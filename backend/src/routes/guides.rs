use std::{path::Path, sync::OnceLock};

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    db::AppState,
    error::AppError,
    models::{
        AudioResponse, ChatRequest, ChatResponse, GuideEnvelope, GuideResponse, GuideStyle,
        WebSource,
    },
    routes::auth::DeviceAuth,
    tavily::{dedupe_sources, truncate_chars},
};

#[derive(Debug, Deserialize)]
pub struct GuideQuery {
    pub style: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GenerateGuideRequest {
    pub style: Option<String>,
    #[serde(default)]
    pub force_regenerate: bool,
    #[serde(default = "crate::models::default_true")]
    pub enable_web_search: bool,
}

fn parse_style(opt: Option<&str>) -> Result<GuideStyle, AppError> {
    match opt {
        None => Ok(GuideStyle::Cultural),
        Some(s) => GuideStyle::from_str_opt(s).ok_or_else(|| {
            AppError::BadRequest(format!(
                "不支援的導覽風格 '{s}'，請選擇 cultural、casual 或 family。"
            ))
        }),
    }
}

async fn verify_item_ownership(
    state: &AppState,
    item_id: i64,
    device_id: &str,
) -> Result<(String, String, i64), AppError> {
    let row = sqlx::query(
        "SELECT t.title AS trip_title, i.name AS item_name, i.duration_minutes \
         FROM trip_items i \
         JOIN trip_days d ON i.day_id = d.id \
         JOIN trips t ON d.trip_id = t.id \
         WHERE i.id = ? AND t.device_id = ?",
    )
    .bind(item_id)
    .bind(device_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("找不到該行程景點或無權存取。".to_string()))?;

    Ok((
        row.get("trip_title"),
        row.get("item_name"),
        row.get("duration_minutes"),
    ))
}

fn row_to_guide_response(
    state: &AppState,
    row: &sqlx::sqlite::SqliteRow,
) -> Result<GuideResponse, AppError> {
    let id: String = row.get("id");
    let item_id: i64 = row.get("item_id");
    let style: String = row.get("style");
    let story: String = row.get("story");
    let highlights_json: String = row.get("highlights_json");
    let tips_json: String = row.get("tips_json");
    let narration_script: String = row.get("narration_script");
    let audio_path: Option<String> = row.get("audio_path");
    let sources_json: String = row.get("sources_json");
    let updated_at: String = row.get("updated_at");

    let highlights: Vec<String> = serde_json::from_str(&highlights_json)
        .map_err(|e| AppError::Internal(format!("解析 highlights JSON 失敗：{e}")))?;
    let tips: Vec<String> = serde_json::from_str(&tips_json)
        .map_err(|e| AppError::Internal(format!("解析 tips JSON 失敗：{e}")))?;
    let sources: Vec<WebSource> = serde_json::from_str(&sources_json)
        .map_err(|e| AppError::Internal(format!("解析 sources JSON 失敗：{e}")))?;

    let audio_url = audio_path.and_then(|filename| {
        if state.audio_cache_dir.join(&filename).exists() {
            Some(format!("/api/audio/{id}"))
        } else {
            None
        }
    });

    Ok(GuideResponse {
        id,
        item_id,
        style,
        story,
        highlights,
        tips,
        narration_script,
        audio_url,
        sources,
        updated_at,
    })
}

pub async fn get_guide(
    auth: DeviceAuth,
    State(state): State<AppState>,
    AxumPath(item_id): AxumPath<i64>,
    Query(query): Query<GuideQuery>,
) -> Result<Json<GuideEnvelope>, AppError> {
    let style = parse_style(query.style.as_deref())?;
    verify_item_ownership(&state, item_id, &auth.device_id).await?;

    let row = sqlx::query(
        "SELECT id, item_id, style, story, highlights_json, tips_json, narration_script, audio_path, sources_json, updated_at \
         FROM ai_guides WHERE item_id = ? AND style = ?",
    )
    .bind(item_id)
    .bind(style.as_str())
    .fetch_optional(&state.pool)
    .await?;

    let guide = match row {
        Some(r) => Some(row_to_guide_response(&state, &r)?),
        None => None,
    };

    Ok(Json(GuideEnvelope { guide }))
}

pub async fn generate_guide(
    auth: DeviceAuth,
    State(state): State<AppState>,
    AxumPath(item_id): AxumPath<i64>,
    Json(req): Json<GenerateGuideRequest>,
) -> Result<Json<GuideEnvelope>, AppError> {
    let style = parse_style(req.style.as_deref())?;
    let (trip_title, item_name, duration_minutes) =
        verify_item_ownership(&state, item_id, &auth.device_id).await?;

    let existing = sqlx::query(
        "SELECT id, item_id, style, story, highlights_json, tips_json, narration_script, audio_path, sources_json, updated_at \
         FROM ai_guides WHERE item_id = ? AND style = ?",
    )
    .bind(item_id)
    .bind(style.as_str())
    .fetch_optional(&state.pool)
    .await?;

    if !req.force_regenerate {
        if let Some(ref row) = existing {
            return Ok(Json(GuideEnvelope {
                guide: Some(row_to_guide_response(&state, row)?),
            }));
        }
    }

    let mut web_context: Option<String> = None;
    let mut sources: Vec<WebSource> = Vec::new();

    if req.enable_web_search && state.tavily.is_enabled() {
        let query = format!("{item_name} {trip_title} 營業時間 門票 景點特色");
        match state.tavily.search(&query).await {
            Ok(results) if !results.is_empty() => {
                let mut snippets = Vec::with_capacity(results.len());
                let mut raw_sources = Vec::with_capacity(results.len());
                for (idx, item) in results.into_iter().enumerate() {
                    let display_title = if item.title.is_empty() {
                        item.url.clone()
                    } else {
                        item.title.clone()
                    };
                    snippets.push(format!(
                        "[{}] {} ({})\n{}",
                        idx + 1,
                        display_title,
                        item.url,
                        item.content
                    ));
                    raw_sources.push(WebSource {
                        title: item.title,
                        url: item.url,
                    });
                }
                web_context = Some(snippets.join("\n\n"));
                sources = dedupe_sources(raw_sources);
            }
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(
                    %item_id,
                    %item_name,
                    %err,
                    "Tavily search failed during generate_guide; continuing without web context"
                );
            }
        }
    }

    let generated = state
        .gemini
        .generate_guide(
            &trip_title,
            &item_name,
            duration_minutes,
            style,
            web_context.as_deref(),
        )
        .await?;

    if let Some(ref row) = existing {
        let old_audio: Option<String> = row.get("audio_path");
        if let Some(fname) = old_audio {
            let path = state.audio_cache_dir.join(fname);
            if let Err(err) = tokio::fs::remove_file(&path).await {
                if err.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(?path, %err, "Failed to remove stale audio cache");
                }
            }
        }
    }

    let guide_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let highlights_json = serde_json::to_string(&generated.highlights)
        .map_err(|e| AppError::Internal(format!("序列化 highlights 失敗：{e}")))?;
    let tips_json = serde_json::to_string(&generated.tips)
        .map_err(|e| AppError::Internal(format!("序列化 tips 失敗：{e}")))?;
    let sources_json = serde_json::to_string(&sources)
        .map_err(|e| AppError::Internal(format!("序列化 sources 失敗：{e}")))?;

    sqlx::query(
        "INSERT INTO ai_guides \
         (id, item_id, style, story, highlights_json, tips_json, narration_script, audio_path, sources_json, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?) \
         ON CONFLICT(item_id, style) DO UPDATE SET \
           id = excluded.id, \
           story = excluded.story, \
           highlights_json = excluded.highlights_json, \
           tips_json = excluded.tips_json, \
           narration_script = excluded.narration_script, \
           audio_path = NULL, \
           sources_json = excluded.sources_json, \
           updated_at = excluded.updated_at",
    )
    .bind(&guide_id)
    .bind(item_id)
    .bind(style.as_str())
    .bind(&generated.story)
    .bind(&highlights_json)
    .bind(&tips_json)
    .bind(&generated.narration_script)
    .bind(&sources_json)
    .bind(&now)
    .bind(&now)
    .execute(&state.pool)
    .await?;

    Ok(Json(GuideEnvelope {
        guide: Some(GuideResponse {
            id: guide_id,
            item_id,
            style: style.as_str().to_string(),
            story: generated.story,
            highlights: generated.highlights,
            tips: generated.tips,
            narration_script: generated.narration_script,
            audio_url: None,
            sources,
            updated_at: now,
        }),
    }))
}

pub async fn generate_guide_audio(
    auth: DeviceAuth,
    State(state): State<AppState>,
    AxumPath(item_id): AxumPath<i64>,
    Json(req): Json<GenerateGuideRequest>,
) -> Result<Json<AudioResponse>, AppError> {
    let style = parse_style(req.style.as_deref())?;
    verify_item_ownership(&state, item_id, &auth.device_id).await?;

    let row = sqlx::query(
        "SELECT id, narration_script, audio_path FROM ai_guides WHERE item_id = ? AND style = ?",
    )
    .bind(item_id)
    .bind(style.as_str())
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| {
        AppError::NotFound("請先生成此風格的 AI 導覽文案，再生成語音。".to_string())
    })?;

    let guide_id: String = row.get("id");
    let narration_script: String = row.get("narration_script");
    let audio_path: Option<String> = row.get("audio_path");

    if !req.force_regenerate {
        if let Some(ref fname) = audio_path {
            if state.audio_cache_dir.join(fname).exists() {
                return Ok(Json(AudioResponse {
                    audio_url: format!("/api/audio/{guide_id}"),
                }));
            }
        }
    }

    let wav_bytes = state.gemini.generate_tts_wav(&narration_script).await?;
    let filename = format!("{guide_id}.wav");
    let disk_path = state.audio_cache_dir.join(&filename);

    tokio::fs::write(&disk_path, &wav_bytes)
        .await
        .map_err(|e| AppError::Internal(format!("寫入語音快取檔失敗：{e}")))?;

    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    sqlx::query("UPDATE ai_guides SET audio_path = ?, updated_at = ? WHERE id = ?")
        .bind(&filename)
        .bind(&now)
        .bind(&guide_id)
        .execute(&state.pool)
        .await?;

    Ok(Json(AudioResponse {
        audio_url: format!("/api/audio/{guide_id}"),
    }))
}

async fn read_wav_response(disk_path: &Path) -> Result<impl IntoResponse, AppError> {
    let bytes = tokio::fs::read(disk_path).await.map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound("找不到該語音檔案。".to_string())
        } else {
            AppError::Internal(format!("讀取語音檔案失敗：{err}"))
        }
    })?;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "audio/wav"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        bytes,
    ))
}

pub async fn serve_audio(
    State(state): State<AppState>,
    AxumPath(guide_id): AxumPath<String>,
) -> Result<impl IntoResponse, AppError> {
    let parsed_uuid = Uuid::parse_str(guide_id.trim())
        .map_err(|_| AppError::BadRequest("無效的語音識別碼。".to_string()))?;

    let disk_path = state
        .audio_cache_dir
        .join(format!("{}.wav", parsed_uuid));

    read_wav_response(&disk_path).await
}

#[derive(Debug, Deserialize)]
pub struct ChatTtsRequest {
    pub text: String,
}

/// Cleans Markdown links, bare URLs, and Markdown formatting symbols so TTS reads naturally.
pub fn sanitize_text_for_tts(raw: &str) -> String {
    static MD_LINK_RE: OnceLock<Regex> = OnceLock::new();
    static BARE_URL_RE: OnceLock<Regex> = OnceLock::new();
    static ITALIC_RE: OnceLock<Regex> = OnceLock::new();
    static HEADING_RE: OnceLock<Regex> = OnceLock::new();
    static BULLET_RE: OnceLock<Regex> = OnceLock::new();
    static HORIZ_WS_RE: OnceLock<Regex> = OnceLock::new();

    let md_link_re = MD_LINK_RE
        .get_or_init(|| Regex::new(r"\[([^\]]+)\]\((https?://[^\s)]+)\)").expect("valid md link regex"));
    let bare_url_re = BARE_URL_RE
        .get_or_init(|| Regex::new(r"https?://\S+").expect("valid bare url regex"));
    let italic_re = ITALIC_RE
        .get_or_init(|| Regex::new(r"\*([^*\n]+)\*").expect("valid italic regex"));
    let heading_re = HEADING_RE
        .get_or_init(|| Regex::new(r"^[ \t]*#{1,6}[ \t]*").expect("valid heading regex"));
    let bullet_re = BULLET_RE
        .get_or_init(|| Regex::new(r"^[ \t]*(?:[-*+•])[ \t]+").expect("valid bullet regex"));
    let horiz_ws_re = HORIZ_WS_RE
        .get_or_init(|| Regex::new(r"[ \t]{2,}").expect("valid whitespace regex"));

    let step1 = md_link_re.replace_all(raw, "$1");
    let step2 = bare_url_re.replace_all(&step1, "");
    let step3 = step2
        .replace("**", "")
        .replace("__", "")
        .replace('`', "");
    let step4 = italic_re.replace_all(&step3, "$1");

    let lines: Vec<String> = step4
        .lines()
        .filter_map(|line| {
            let no_heading = heading_re.replace(line, "");
            let no_bullet = bullet_re.replace(&no_heading, "");
            let collapsed = horiz_ws_re.replace_all(no_bullet.trim(), " ");
            let cleaned = collapsed.trim();
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned.to_string())
            }
        })
        .collect();

    lines.join("\n")
}

pub async fn generate_chat_tts(
    _auth: DeviceAuth,
    State(state): State<AppState>,
    Json(req): Json<ChatTtsRequest>,
) -> Result<Json<AudioResponse>, AppError> {
    let sanitized = sanitize_text_for_tts(&req.text);
    if sanitized.is_empty() {
        return Err(AppError::BadRequest("沒有可轉為語音的文字內容。".to_string()));
    }

    let text = truncate_chars(&sanitized, 3000);
    let (model, voice, style) = state.gemini.tts_cache_fingerprint();
    let fingerprint = format!("{model}|{voice}|{style}|{text}");
    let hash = hex::encode(Sha256::digest(fingerprint.as_bytes()));

    let filename = format!("chat-{hash}.wav");
    let disk_path = state.audio_cache_dir.join(&filename);

    if disk_path.exists() {
        return Ok(Json(AudioResponse {
            audio_url: format!("/api/tts/audio/{hash}"),
        }));
    }

    let wav_bytes = state.gemini.generate_tts_wav(&text).await?;
    tokio::fs::write(&disk_path, &wav_bytes)
        .await
        .map_err(|e| AppError::Internal(format!("寫入語音快取檔失敗：{e}")))?;

    Ok(Json(AudioResponse {
        audio_url: format!("/api/tts/audio/{hash}"),
    }))
}

pub async fn serve_chat_audio(
    State(state): State<AppState>,
    AxumPath(audio_hash): AxumPath<String>,
) -> Result<impl IntoResponse, AppError> {
    if audio_hash.len() != 64
        || !audio_hash
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(AppError::BadRequest("無效的語音識別碼。".to_string()));
    }

    let disk_path = state.audio_cache_dir.join(format!("chat-{audio_hash}.wav"));
    read_wav_response(&disk_path).await
}

fn format_stay_for_prompt(duration_minutes: i64) -> String {
    if duration_minutes == 0 {
        "路過 / 備案（停留 0 分鐘）".to_string()
    } else {
        format!("預計停留 {} 分鐘", duration_minutes)
    }
}

fn web_search_prompt_instruction(enabled: bool) -> &'static str {
    if enabled {
        "\n若要確認最新營業時間、門票價格、公休日、天氣預報、餐廳推薦或讀取旅客提供的特定網址，請主動使用 web_search 或 fetch_webpage 網路搜尋工具查詢最新資訊後再回答，勿捏造網址或未經查證的即時資訊。\n當你引用網路搜尋查到的官網、購票頁、餐廳或攻略文章時，請務必使用 [來源名稱](真實網址) 格式附上可點擊超連結（僅限工具實際回傳的網址，切勿自行編造 URL）；其餘文字仍維持純文字排版，不要使用 **粗體**、### 標題或 LaTeX。"
    } else {
        ""
    }
}

pub async fn chat_day(
    auth: DeviceAuth,
    State(state): State<AppState>,
    AxumPath((trip_id, day_number)): AxumPath<(String, i64)>,
    Json(req): Json<ChatRequest>,
) -> Result<Json<ChatResponse>, AppError> {
    let day_row = sqlx::query(
        "SELECT t.title AS trip_title, d.id AS day_id, d.date \
         FROM trip_days d \
         JOIN trips t ON d.trip_id = t.id \
         WHERE t.id = ? AND d.day_number = ? AND t.device_id = ?",
    )
    .bind(&trip_id)
    .bind(day_number)
    .bind(&auth.device_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("找不到該天的行程資料或無權存取。".to_string()))?;

    let trip_title: String = day_row.get("trip_title");
    let day_id: i64 = day_row.get("day_id");
    let date: String = day_row.get("date");

    let item_rows = sqlx::query(
        "SELECT sequence, start_time, name, duration_minutes \
         FROM trip_items \
         WHERE day_id = ? \
         ORDER BY sequence ASC",
    )
    .bind(day_id)
    .fetch_all(&state.pool)
    .await?;

    let mut schedule_lines = Vec::with_capacity(item_rows.len());
    for row in item_rows {
        let seq: i64 = row.get("sequence");
        let start_time: String = row.get("start_time");
        let name: String = row.get("name");
        let duration_minutes: i64 = row.get("duration_minutes");
        schedule_lines.push(format!(
            "#{seq} {start_time} {name}（{}）",
            format_stay_for_prompt(duration_minutes)
        ));
    }

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let web_search_active = req.enable_web_search && state.tavily.is_enabled();
    let system_instruction = format!(
        "你是一位貼心且熟悉當地旅遊的繁體中文（台灣用語）AI 行程助手。今天日期：{today}。\n\
        請完全根據旅客「當天」的真實行程資料回答問題，包含路線順暢度、交通與時間分配、附近美食或伴手禮、拍照與備案建議。\n\
        回答請精簡好讀（適合手機螢幕閱讀），請用純文字搭配換行或「•」「1.」條列排版，切勿使用 Markdown 語法（如 **粗體**、### 標題）或 LaTeX 數學符號，也不要捏造行程表中不存在的預訂時間。{}\n\n\
        【行程主題】{trip_title}\n\
        【日期】第 {day_number} 天（{date}）\n\
        【當日行程表（依順序排列）】\n{}",
        web_search_prompt_instruction(web_search_active),
        schedule_lines.join("\n")
    );

    let tavily = if req.enable_web_search {
        Some(&state.tavily)
    } else {
        None
    };
    let output = state
        .gemini
        .chat_with_tools(&system_instruction, &req.messages, tavily)
        .await?;
    Ok(Json(ChatResponse {
        reply: output.reply,
        sources: output.sources,
        search_queries: output.search_queries,
    }))
}

pub async fn chat_item(
    auth: DeviceAuth,
    State(state): State<AppState>,
    AxumPath(item_id): AxumPath<i64>,
    Json(req): Json<ChatRequest>,
) -> Result<Json<ChatResponse>, AppError> {
    let item_row = sqlx::query(
        "SELECT t.title AS trip_title, d.day_number, d.date, i.start_time, i.name AS item_name, i.duration_minutes \
         FROM trip_items i \
         JOIN trip_days d ON i.day_id = d.id \
         JOIN trips t ON d.trip_id = t.id \
         WHERE i.id = ? AND t.device_id = ?",
    )
    .bind(item_id)
    .bind(&auth.device_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("找不到該行程景點或無權存取。".to_string()))?;

    let trip_title: String = item_row.get("trip_title");
    let day_number: i64 = item_row.get("day_number");
    let date: String = item_row.get("date");
    let start_time: String = item_row.get("start_time");
    let item_name: String = item_row.get("item_name");
    let duration_minutes: i64 = item_row.get("duration_minutes");

    let cached_story: Option<String> = sqlx::query(
        "SELECT story FROM ai_guides WHERE item_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(item_id)
    .fetch_optional(&state.pool)
    .await?
    .map(|r| r.get("story"));

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let web_search_active = req.enable_web_search && state.tavily.is_enabled();
    let mut system_instruction = format!(
        "你是一位親切專業的繁體中文（台灣用語）私人旅遊導覽員。今天日期：{today}。\n\
        旅客目前正在查看行程中的單一景點，請針對這個景點回答他的問題（例如必看亮點、必吃美食、停留時間安排、排隊技巧、親子或雨天備案等）。\n\
        回答請簡潔自然、適合手機畫面閱讀；請使用純文字與換行或「•」「1.」條列，切勿使用 Markdown 語法（如 **粗體**、### 標題）或 LaTeX 數學符號。{}\n\n\
        【行程主題】{trip_title}\n\
        【日期與時段】第 {day_number} 天（{date}）{start_time}\n\
        【景點 / 活動名稱】{item_name}\n\
        【停留安排】{}",
        web_search_prompt_instruction(web_search_active),
        format_stay_for_prompt(duration_minutes)
    );

    if let Some(story) = cached_story {
        system_instruction.push_str(&format!("\n【景點背景摘要】{story}"));
    }

    let tavily = if req.enable_web_search {
        Some(&state.tavily)
    } else {
        None
    };
    let output = state
        .gemini
        .chat_with_tools(&system_instruction, &req.messages, tavily)
        .await?;
    Ok(Json(ChatResponse {
        reply: output.reply,
        sources: output.sources,
        search_queries: output.search_queries,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_text_for_tts_keeps_markdown_link_labels_and_strips_bare_urls() {
        let input = "建議先看 [大阪城官網](https://www.osakacastle.net/ticket?lang=zh) 確認開館時間，或參考 https://travel.example.com/osaka/info 。";
        assert_eq!(
            sanitize_text_for_tts(input),
            "建議先看 大阪城官網 確認開館時間，或參考 。"
        );

        let bare_only = "詳情請見 https://www.kiyomizudera.or.jp/ 和 http://kyoto.travel/en";
        assert_eq!(sanitize_text_for_tts(bare_only), "詳情請見 和");
    }

    #[test]
    fn sanitize_text_for_tts_cleans_markdown_headings_bullets_bold_and_whitespace() {
        let input = "###   今日推薦路線  \n\n- **清水寺**：早晨光線最好\n* __二寧坂__：逛街吃`抹茶冰淇淋`\n+ *傍晚*前往鴨川散步\n\n\n";
        assert_eq!(
            sanitize_text_for_tts(input),
            "今日推薦路線\n清水寺：早晨光線最好\n二寧坂：逛街吃抹茶冰淇淋\n傍晚前往鴨川散步"
        );
    }

    #[test]
    fn sanitize_text_for_tts_returns_empty_when_only_urls_or_symbols() {
        assert_eq!(
            sanitize_text_for_tts("  https://example.com   **__`###`__**  "),
            ""
        );
    }
}
