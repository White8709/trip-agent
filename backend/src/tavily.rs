use std::{collections::HashSet, time::Duration};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{error::AppError, models::WebSource};

const TAVILY_SEARCH_URL: &str = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL: &str = "https://api.tavily.com/extract";
const PLACEHOLDER_API_KEY: &str = "your_tavily_api_key_here";
const SEARCH_CONTENT_MAX_CHARS: usize = 1000;
const EXTRACT_CONTENT_MAX_CHARS: usize = 4000;

#[derive(Debug, Clone)]
pub struct TavilyConfig {
    pub api_key: String,
    pub search_depth: String,
    pub max_results: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TavilySearchResult {
    pub title: String,
    pub url: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct TavilyClient {
    http: reqwest::Client,
    config: TavilyConfig,
}

#[derive(Debug, Deserialize)]
struct TavilySearchApiResponse {
    #[serde(default)]
    results: Vec<TavilySearchApiItem>,
}

#[derive(Debug, Deserialize)]
struct TavilySearchApiItem {
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    content: String,
}

#[derive(Debug, Deserialize)]
struct TavilyExtractApiResponse {
    #[serde(default)]
    results: Vec<TavilyExtractApiItem>,
}

#[derive(Debug, Deserialize)]
struct TavilyExtractApiItem {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    url: String,
    #[serde(default)]
    raw_content: Option<String>,
    #[serde(default)]
    content: Option<String>,
}

impl TavilyClient {
    /// Creates a Tavily API client with a 15-second request timeout.
    pub fn new(config: TavilyConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("Failed to construct Tavily HTTP client");

        Self { http, config }
    }

    /// Returns true only when a non-placeholder `TAVILY_API_KEY` is configured.
    pub fn is_enabled(&self) -> bool {
        let key = self.config.api_key.trim();
        !key.is_empty() && key != PLACEHOLDER_API_KEY
    }

    /// Searches the web via Tavily `/search` and truncates result snippets safely.
    pub async fn search(&self, query: &str) -> Result<Vec<TavilySearchResult>, AppError> {
        let trimmed_query = query.trim();
        if trimmed_query.is_empty() {
            return Err(AppError::BadRequest("搜尋關鍵字不可為空白。".to_string()));
        }

        let body = json!({
            "query": trimmed_query,
            "search_depth": self.config.search_depth,
            "max_results": self.config.max_results,
        });

        let payload: TavilySearchApiResponse = self
            .post_json(TAVILY_SEARCH_URL, &body, "Search")
            .await?;

        let results = payload
            .results
            .into_iter()
            .filter_map(|item| {
                let url = item.url.trim().to_string();
                if url.is_empty() {
                    return None;
                }
                let title = item.title.trim().to_string();
                let content = truncate_chars(item.content.trim(), SEARCH_CONTENT_MAX_CHARS);
                Some(TavilySearchResult {
                    title,
                    url,
                    content,
                })
            })
            .collect();

        Ok(results)
    }

    /// Extracts webpage content via Tavily `/extract` and truncates it safely.
    pub async fn extract(&self, url: &str) -> Result<Option<TavilySearchResult>, AppError> {
        let trimmed_url = url.trim();
        if trimmed_url.is_empty() {
            return Err(AppError::BadRequest("網頁網址不可為空白。".to_string()));
        }

        let body = json!({
            "urls": [trimmed_url],
        });

        let payload: TavilyExtractApiResponse = self
            .post_json(TAVILY_EXTRACT_URL, &body, "Extract")
            .await?;

        let Some(item) = payload.results.into_iter().next() else {
            return Ok(None);
        };

        let extracted_url = {
            let candidate = item.url.trim();
            if candidate.is_empty() {
                trimmed_url.to_string()
            } else {
                candidate.to_string()
            }
        };

        let raw_text = item
            .raw_content
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                item.content
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            });

        let Some(text) = raw_text else {
            return Ok(None);
        };

        let title = item
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&extracted_url)
            .to_string();

        Ok(Some(TavilySearchResult {
            title,
            url: extracted_url,
            content: truncate_chars(text, EXTRACT_CONTENT_MAX_CHARS),
        }))
    }

    async fn post_json<T: DeserializeOwned>(
        &self,
        endpoint: &str,
        body: &Value,
        op_name: &str,
    ) -> Result<T, AppError> {
        if !self.is_enabled() {
            return Err(AppError::ServiceUnavailable(
                "尚未設定有效的 TAVILY_API_KEY，無法執行網路搜尋。".to_string(),
            ));
        }

        let res = self
            .http
            .post(endpoint)
            .bearer_auth(self.config.api_key.trim())
            .json(body)
            .send()
            .await
            .map_err(|e| AppError::Upstream(format!("無法連線至 Tavily {op_name} API：{e}")))?;

        let status = res.status();
        let text = res
            .text()
            .await
            .map_err(|e| AppError::Upstream(format!("讀取 Tavily {op_name} 回應失敗：{e}")))?;

        if !status.is_success() {
            let msg = extract_error_message(&text);
            return Err(AppError::Upstream(format!(
                "Tavily {op_name} API 回傳錯誤 ({status})：{msg}"
            )));
        }

        serde_json::from_str::<T>(&text)
            .map_err(|e| AppError::Upstream(format!("解析 Tavily {op_name} 回應失敗：{e}")))
    }
}

fn extract_error_message(raw_body: &str) -> String {
    if let Ok(val) = serde_json::from_str::<Value>(raw_body) {
        if let Some(msg) = val
            .pointer("/detail/error")
            .or_else(|| val.get("detail"))
            .or_else(|| val.get("error"))
            .or_else(|| val.get("message"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return msg.to_string();
        }
    }

    let trimmed = raw_body.trim();
    if trimmed.is_empty() {
        "未知錯誤".to_string()
    } else {
        truncate_chars(trimmed, 200)
    }
}

/// Truncates `input` to at most `max_chars` Unicode scalar values on a valid UTF-8 boundary.
pub(crate) fn truncate_chars(input: &str, max_chars: usize) -> String {
    match input.char_indices().nth(max_chars) {
        Some((idx, _)) => input[..idx].to_string(),
        None => input.to_string(),
    }
}

/// Deduplicates `WebSource` entries by `url` while preserving insertion order and skipping empty URLs.
pub fn dedupe_sources(sources: Vec<WebSource>) -> Vec<WebSource> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::with_capacity(sources.len());

    for mut source in sources {
        let url = source.url.trim().to_string();
        if url.is_empty() {
            continue;
        }
        if seen.insert(url.clone()) {
            source.url = url;
            source.title = source.title.trim().to_string();
            deduped.push(source);
        }
    }

    deduped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client_with_key(api_key: &str) -> TavilyClient {
        TavilyClient::new(TavilyConfig {
            api_key: api_key.to_string(),
            search_depth: "basic".to_string(),
            max_results: 5,
        })
    }

    #[test]
    fn is_enabled_handles_empty_placeholder_and_valid_keys() {
        assert!(!client_with_key("").is_enabled());
        assert!(!client_with_key("   \t\n ").is_enabled());
        assert!(!client_with_key("your_tavily_api_key_here").is_enabled());
        assert!(!client_with_key("  your_tavily_api_key_here  ").is_enabled());
        assert!(client_with_key("tvly-dev-123456").is_enabled());
        assert!(client_with_key("  tvly-prod-xyz  ").is_enabled());
    }

    #[test]
    fn truncate_chars_respects_utf8_boundaries_including_cjk() {
        assert_eq!(truncate_chars("hello", 10), "hello");
        assert_eq!(truncate_chars("hello", 5), "hello");
        assert_eq!(truncate_chars("hello world", 5), "hello");
        assert_eq!(truncate_chars("hello", 0), "");

        let cjk = "京都清水寺參拜時間與門票資訊🌸2026";
        let truncated = truncate_chars(cjk, 5);
        assert_eq!(truncated, "京都清水寺");
        assert_eq!(truncated.chars().count(), 5);

        let with_emoji = "景點🌸✨推薦";
        let truncated_emoji = truncate_chars(with_emoji, 4);
        assert_eq!(truncated_emoji, "景點🌸✨");
        assert!(std::str::from_utf8(truncated_emoji.as_bytes()).is_ok());

        assert_eq!(truncate_chars(cjk, 100), cjk);
    }

    #[test]
    fn dedupe_sources_preserves_order_skips_empty_and_deduplicates_by_url() {
        let input = vec![
            WebSource {
                title: "Empty".to_string(),
                url: "   ".to_string(),
            },
            WebSource {
                title: "清水寺官網".to_string(),
                url: "https://www.kiyomizudera.or.jp/".to_string(),
            },
            WebSource {
                title: "京都觀光".to_string(),
                url: " https://kyoto.travel/ ".to_string(),
            },
            WebSource {
                title: "Duplicate 清水寺".to_string(),
                url: "https://www.kiyomizudera.or.jp/".to_string(),
            },
            WebSource {
                title: "Duplicate 京都觀光".to_string(),
                url: "https://kyoto.travel/".to_string(),
            },
            WebSource {
                title: "JR 西日本".to_string(),
                url: "https://www.westjr.co.jp/".to_string(),
            },
        ];

        let deduped = dedupe_sources(input);
        assert_eq!(
            deduped,
            vec![
                WebSource {
                    title: "清水寺官網".to_string(),
                    url: "https://www.kiyomizudera.or.jp/".to_string(),
                },
                WebSource {
                    title: "京都觀光".to_string(),
                    url: "https://kyoto.travel/".to_string(),
                },
                WebSource {
                    title: "JR 西日本".to_string(),
                    url: "https://www.westjr.co.jp/".to_string(),
                },
            ]
        );
    }
}
