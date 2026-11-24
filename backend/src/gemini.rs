use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::OnceLock, time::Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use zhconv::{zhconv, Variant};

use crate::{
    error::AppError,
    models::{ChatMessage, GuideStyle, WebSource},
    tavily::{dedupe_sources, TavilyClient},
};

const MAX_TOOL_ROUNDS: usize = 3;

pub const TRADITIONAL_CHINESE_SYSTEM_RULE: &str = "STRICT LANGUAGE POLICY: Reply EXCLUSIVELY in Traditional Chinese (繁體中文, zh-TW, Taiwan usage). NEVER output Simplified Chinese (简体中文), English sentences or translated titles, Japanese hiragana/katakana (ひらがな/カタカナ), Korean, or any other language.\n\
【最高優先語言規範】無論使用者的提問語言、對話歷史語言、語音辨識結果、景點外文名稱，或網路搜尋回傳的網頁語言為何，你的每一句回覆都必須 100% 嚴格使用「繁體中文（台灣正體中文與台灣慣用語）」撰寫：\n\
1. 絕對禁止使用任何簡體字（例如：这、为、门、馆、推荐、路线、里脊等；一律使用台灣用語如腰內肉、里肌肉、資訊、飯店、捷運／電車）。\n\
2. 絕對禁止輸出英文句子、英文網頁標題或括號內附註長串英文／日文假名（例如不可寫「(Rapidly Rotating Bouncing Spheres)」、「(ロースカツ)」、「名代かつくら」等），請直接以台灣繁體中文表達。\n\
3. 引用搜尋來源撰寫 [來源名稱](真實網址) 時，「來源名稱」必須翻譯成簡短的台灣繁體中文（如 [京都 teamLab 參觀指南](真實網址)），不可直接複製整段英文或日文網頁標題；但括號內的真實網址必須保持原樣不可修改。";

const TOOL_TRADITIONAL_ZH_REMINDER: &str = "CRITICAL: Summarize the results EXCLUSIVELY in Taiwan Traditional Chinese (繁體中文). Translate all English/Japanese/Simplified Chinese facts, menu names, and [來源名稱](url) labels into Taiwan Traditional Chinese. NO Simplified Chinese, NO Japanese kana, NO English sentences or untranslated webpage titles.";

#[derive(Debug, Clone)]
pub struct GeminiConfig {
    pub api_key: String,
    pub text_model: String,
    pub tts_model: String,
    pub tts_voice: String,
    pub tts_style: String,
    pub stt_model: String,
}

#[derive(Debug, Clone)]
pub struct GeminiClient {
    http: reqwest::Client,
    config: GeminiConfig,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct GeneratedGuide {
    pub story: String,
    pub highlights: Vec<String>,
    pub tips: Vec<String>,
    pub narration_script: String,
}

#[derive(Debug, Clone)]
pub struct ChatOutput {
    pub reply: String,
    pub sources: Vec<WebSource>,
    pub search_queries: Vec<String>,
}

impl GeminiClient {
    pub fn new(config: GeminiConfig) -> Self {
        Self {
            http: reqwest::Client::new(),
            config,
        }
    }

    fn ensure_api_key(&self) -> Result<&str, AppError> {
        let key = self.config.api_key.trim();
        if key.is_empty() || key == "your_gemini_api_key_here" {
            return Err(AppError::ServiceUnavailable(
                "後端尚未設定有效的 GEMINI_API_KEY，請於 backend/.env 中填入您的 Gemini API Key 後重啟服務。".to_string(),
            ));
        }
        Ok(key)
    }

    pub fn api_key_checked(&self) -> Result<&str, AppError> {
        self.ensure_api_key()
    }

    pub fn stt_model(&self) -> &str {
        self.config.stt_model.trim()
    }

    pub fn tts_cache_fingerprint(&self) -> (&str, &str, &str) {
        (
            &self.config.tts_model,
            &self.config.tts_voice,
            &self.config.tts_style,
        )
    }

    pub async fn generate_guide(
        &self,
        trip_title: &str,
        place_name: &str,
        duration_minutes: i64,
        style: GuideStyle,
        web_context: Option<&str>,
    ) -> Result<GeneratedGuide, AppError> {
        let api_key = self.ensure_api_key()?;
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            self.config.text_model, api_key
        );

        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let body = build_guide_request_body(
            trip_title,
            place_name,
            duration_minutes,
            style,
            web_context,
            &today,
        );

        let res = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Upstream(format!("無法連線至 Gemini Text API：{e}")))?;

        let status = res.status();
        let payload: Value = res
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("解析 Gemini 回應失敗：{e}")))?;

        if !status.is_success() {
            let msg = payload
                .pointer("/error/message")
                .and_then(|v| v.as_str())
                .unwrap_or("未知錯誤");
            return Err(AppError::Upstream(format!(
                "Gemini Text API 回傳錯誤 ({status})：{msg}"
            )));
        }

        let raw_text = payload
            .pointer("/candidates/0/content/parts")
            .and_then(|v| v.as_array())
            .and_then(|parts| {
                parts
                    .iter()
                    .filter(|p| !p.get("thought").and_then(|v| v.as_bool()).unwrap_or(false))
                    .find_map(|p| p.get("text").and_then(|v| v.as_str()))
            })
            .ok_or_else(|| {
                AppError::Upstream("Gemini Text API 回應中找不到導覽內容文字。".to_string())
            })?;

        let cleaned = raw_text
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        let mut guide = serde_json::from_str::<GeneratedGuide>(cleaned).map_err(|e| {
            AppError::Upstream(format!("Gemini 回傳的 JSON 格式不符預期：{e}"))
        })?;

        guide.story = self.enforce_traditional_chinese_text(&url, guide.story).await;
        for highlight in &mut guide.highlights {
            let original = std::mem::take(highlight);
            *highlight = self.enforce_traditional_chinese_text(&url, original).await;
        }
        for tip in &mut guide.tips {
            let original = std::mem::take(tip);
            *tip = self.enforce_traditional_chinese_text(&url, original).await;
        }
        guide.narration_script = self
            .enforce_traditional_chinese_text(&url, guide.narration_script)
            .await;

        Ok(guide)
    }

    pub async fn chat_with_tools(
        &self,
        system_instruction: &str,
        messages: &[ChatMessage],
        tavily: Option<&TavilyClient>,
    ) -> Result<ChatOutput, AppError> {
        let api_key = self.ensure_api_key()?;
        let valid_messages: Vec<&ChatMessage> = messages
            .iter()
            .filter(|m| !m.content.trim().is_empty())
            .collect();

        if valid_messages.is_empty() {
            return Err(AppError::BadRequest("請輸入想詢問的內容。".to_string()));
        }

        let mut contents: Vec<Value> = valid_messages
            .into_iter()
            .map(|m| {
                let role = if m.role.eq_ignore_ascii_case("model") {
                    "model"
                } else {
                    "user"
                };
                json!({
                    "role": role,
                    "parts": [{ "text": m.content.trim() }]
                })
            })
            .collect();

        // Reinforce language at the latest user turn to override any foreign-language chat history.
        if let Some(last_user) = contents
            .iter_mut()
            .rev()
            .find(|c| c.get("role").and_then(|v| v.as_str()) == Some("user"))
        {
            if let Some(parts) = last_user.get_mut("parts").and_then(|v| v.as_array_mut()) {
                parts.push(json!({
                    "text": "（系統強制規範：無論以上提問、對話歷史或搜尋資料使用何種語言，本則回覆必須 100% 使用台灣繁體中文，絕對禁止簡體字、日文假名、英文句子或未翻譯的外文標題。）"
                }));
            }
        }

        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            self.config.text_model, api_key
        );

        let active_tavily = tavily.filter(|client| client.is_enabled());
        let mut collected_sources: Vec<WebSource> = Vec::new();
        let mut search_queries: Vec<String> = Vec::new();

        if let Some(client) = active_tavily {
            for _round in 0..MAX_TOOL_ROUNDS {
                let payload = self
                    .send_chat_generate_content(&url, system_instruction, &contents, true)
                    .await?;

                let model_content = extract_model_content(&payload)?;
                let parts = extract_parts_from_content(&model_content)?;

                let function_calls: Vec<&Value> =
                    parts.iter().filter_map(|p| p.get("functionCall")).collect();

                if function_calls.is_empty() {
                    let reply = self
                        .enforce_traditional_chinese_text(&url, join_text_parts(parts)?)
                        .await;
                    return Ok(ChatOutput {
                        reply,
                        sources: dedupe_sources(collected_sources),
                        search_queries,
                    });
                }

                // Preserve raw model content (including thoughtSignature and functionCall.id).
                contents.push(model_content.clone());

                let mut fn_responses = Vec::with_capacity(function_calls.len());
                for fc in function_calls {
                    let resp = execute_tavily_tool_call(
                        client,
                        fc,
                        &mut collected_sources,
                        &mut search_queries,
                    )
                    .await;
                    fn_responses.push(resp);
                }

                contents.push(json!({
                    "role": "user",
                    "parts": fn_responses
                }));
            }
        }

        let payload = self
            .send_chat_generate_content(&url, system_instruction, &contents, false)
            .await?;
        let model_content = extract_model_content(&payload)?;
        let parts = extract_parts_from_content(&model_content)?;
        let reply = self
            .enforce_traditional_chinese_text(&url, join_text_parts(parts)?)
            .await;

        Ok(ChatOutput {
            reply,
            sources: dedupe_sources(collected_sources),
            search_queries,
        })
    }

    async fn enforce_traditional_chinese_text(&self, url: &str, raw_text: String) -> String {
        let normalized = strip_foreign_parenthetical_glosses(&convert_to_zh_tw_preserving_urls(&raw_text));
        if !needs_traditional_chinese_rewrite(&normalized) {
            return normalized;
        }

        match self.rewrite_to_traditional_chinese(url, &normalized).await {
            Ok(rewritten) => {
                let final_text =
                    strip_foreign_parenthetical_glosses(&convert_to_zh_tw_preserving_urls(&rewritten));
                if final_text.trim().is_empty() {
                    normalized
                } else {
                    final_text
                }
            }
            Err(err) => {
                tracing::warn!(%err, "Traditional Chinese rewrite guard failed; falling back to zhconv output");
                normalized
            }
        }
    }

    async fn rewrite_to_traditional_chinese(&self, url: &str, text: &str) -> Result<String, AppError> {
        const REWRITE_SYSTEM_PROMPT: &str = "STRICT RULE: Output MUST contain ZERO Japanese hiragana/katakana (ひらがな/カタカナ), ZERO Simplified Chinese, and ZERO English sentences or parenthetical English glosses.\n\
        你是台灣繁體中文旅遊編輯。請將使用者提供的文本 100% 改寫並翻譯為自然通順的「台灣繁體中文（正體中文與台灣慣用語）」。\n\
        嚴格規則：\n\
        1. 將所有英文句子、網頁標題、日文（含所有平假名／片假名如 ロース、かつくら）、韓文及簡體中文，全部改寫為台灣繁體中文（例如腰內肉、里肌肉、味集中座位）。\n\
        2. 必須「直接刪除」括號內的日文假名或長串英文原文附註：例如「經典里肌豬排套餐（ロースかつ）」必須改為「經典里肌豬排套餐」、「快速旋轉跳跳球 (Rapidly Rotating Bouncing Spheres)」必須改為「快速旋轉跳跳球」。\n\
        3. 若文本中有 [來源名稱](https://...) 連結，請將括號前的「來源名稱」翻成簡短台灣繁體中文，但括號內的 https:// 或 http:// 網址必須一字不差完整保留。\n\
        4. 保留原有的換行與「•」「1.」條列結構，不要新增 **粗體**、### 標題或任何解說前言，直接輸出改寫後的完整內容。";

        let body = json!({
            "systemInstruction": {
                "parts": [{ "text": REWRITE_SYSTEM_PROMPT }]
            },
            "contents": [{
                "role": "user",
                "parts": [{ "text": text }]
            }],
            "generationConfig": {
                "temperature": 0.2
            }
        });

        let res = self
            .http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Upstream(format!("無法連線至 Gemini 繁體中文改寫服務：{e}")))?;

        let status = res.status();
        let payload: Value = res
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("解析 Gemini 改寫回應失敗：{e}")))?;

        if !status.is_success() {
            let msg = payload
                .pointer("/error/message")
                .and_then(|v| v.as_str())
                .unwrap_or("未知錯誤");
            return Err(AppError::Upstream(format!(
                "Gemini 繁體中文改寫回傳錯誤 ({status})：{msg}"
            )));
        }

        let model_content = extract_model_content(&payload)?;
        let parts = extract_parts_from_content(&model_content)?;
        join_text_parts(parts)
    }

    async fn send_chat_generate_content(
        &self,
        url: &str,
        system_instruction: &str,
        contents: &[Value],
        include_tools: bool,
    ) -> Result<Value, AppError> {
        let mut body = json!({
            "systemInstruction": {
                "parts": [{ "text": system_instruction }]
            },
            "contents": contents,
            "generationConfig": {
                "temperature": 0.7
            }
        });

        if include_tools {
            body["tools"] = chat_tool_declarations();
        }

        let res = self
            .http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Upstream(format!("無法連線至 Gemini Chat API：{e}")))?;

        let status = res.status();
        let payload: Value = res
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("解析 Gemini 對話回應失敗：{e}")))?;

        if !status.is_success() {
            let msg = payload
                .pointer("/error/message")
                .and_then(|v| v.as_str())
                .unwrap_or("未知錯誤");
            return Err(AppError::Upstream(format!(
                "Gemini Chat API 回傳錯誤 ({status})：{msg}"
            )));
        }

        Ok(payload)
    }

    pub async fn generate_tts_wav(&self, narration_script: &str) -> Result<Vec<u8>, AppError> {
        if self.config.tts_model.to_ascii_lowercase().contains("live") {
            self.generate_tts_wav_live(narration_script).await
        } else {
            self.generate_tts_wav_rest(narration_script).await
        }
    }

    async fn generate_tts_wav_rest(&self, narration_script: &str) -> Result<Vec<u8>, AppError> {
        let api_key = self.ensure_api_key()?;
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            self.config.tts_model, api_key
        );

        let mut part = json!({ "text": narration_script });
        let style_trimmed = self.config.tts_style.trim();
        if !style_trimmed.is_empty() {
            part["speechMetadata"] = json!({
                "style": style_trimmed
            });
        }

        let body = json!({
            "contents": [{
                "role": "user",
                "parts": [part]
            }],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {
                            "voiceName": self.config.tts_voice
                        }
                    }
                }
            }
        });

        let res = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Upstream(format!("無法連線至 Gemini TTS API：{e}")))?;

        let status = res.status();
        let payload: Value = res
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("解析 Gemini TTS 回應失敗：{e}")))?;

        if !status.is_success() {
            let msg = payload
                .pointer("/error/message")
                .and_then(|v| v.as_str())
                .unwrap_or("未知錯誤");
            return Err(AppError::Upstream(format!(
                "Gemini TTS API 回傳錯誤 ({status})：{msg}"
            )));
        }

        let parts = payload
            .pointer("/candidates/0/content/parts")
            .and_then(|v| v.as_array())
            .ok_or_else(|| AppError::Upstream("Gemini TTS 回應缺少 parts 欄位。".to_string()))?;

        let inline_data = parts
            .iter()
            .find_map(|p| p.get("inlineData").or_else(|| p.get("inline_data")))
            .ok_or_else(|| AppError::Upstream("Gemini TTS 回應中找不到音訊資料。".to_string()))?;

        let b64 = inline_data
            .get("data")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Upstream("Gemini TTS inlineData 缺少 base64 data。".to_string()))?;

        let mime_type = inline_data
            .get("mimeType")
            .or_else(|| inline_data.get("mime_type"))
            .and_then(|v| v.as_str())
            .unwrap_or("audio/L16;codec=pcm;rate=24000");

        let raw_bytes = BASE64
            .decode(b64)
            .map_err(|e| AppError::Upstream(format!("語音 Base64 解碼失敗：{e}")))?;

        if mime_type.to_ascii_lowercase().contains("wav") {
            Ok(raw_bytes)
        } else {
            let sample_rate = parse_sample_rate(mime_type).unwrap_or(24000);
            Ok(pcm_to_wav(&raw_bytes, sample_rate, 1, 16))
        }
    }

    async fn generate_tts_wav_live(&self, narration_script: &str) -> Result<Vec<u8>, AppError> {
        let api_key = self.ensure_api_key()?;
        let ws_url = format!(
            "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={}",
            api_key
        );

        let model_resource = if self.config.tts_model.starts_with("models/") {
            self.config.tts_model.clone()
        } else {
            format!("models/{}", self.config.tts_model)
        };

        let mut setup_inner = json!({
            "model": model_resource,
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {
                            "voiceName": self.config.tts_voice
                        }
                    }
                }
            }
        });

        let style_trimmed = self.config.tts_style.trim();
        if !style_trimmed.is_empty() {
            setup_inner["systemInstruction"] = json!({
                "parts": [{
                    "text": format!(
                        "請以自然台灣繁體中文口音與以下風格朗讀使用者提供的導覽稿，不要唸出這段指示也不要額外補充內容：{}",
                        style_trimmed
                    )
                }]
            });
        }

        let setup_msg = json!({ "setup": setup_inner });

        let client_msg = json!({
            "clientContent": {
                "turns": [{
                    "role": "user",
                    "parts": [{ "text": narration_script }]
                }],
                "turnComplete": true
            }
        });

        tokio::time::timeout(Duration::from_secs(60), async move {
            let (ws_stream, _) = connect_async(&ws_url).await.map_err(|e| {
                AppError::Upstream(format!("無法連線至 Gemini Live API WebSocket：{e}"))
            })?;

            let (mut write, mut read) = ws_stream.split();

            write
                .send(Message::Text(setup_msg.to_string().into()))
                .await
                .map_err(|e| {
                    AppError::Upstream(format!("傳送 Gemini Live setup 訊息失敗：{e}"))
                })?;

            loop {
                match read_live_json(&mut read, &mut write).await? {
                    LiveFrame::Json(payload) => {
                        if let Some(err_val) = payload.get("error") {
                            return Err(AppError::Upstream(format!(
                                "Gemini Live API setup 錯誤：{err_val}"
                            )));
                        }
                        if payload.get("setupComplete").is_some()
                            || payload.get("setup_complete").is_some()
                        {
                            break;
                        }
                    }
                    LiveFrame::Closed(reason) => {
                        return Err(AppError::Upstream(format!(
                            "Gemini Live API 在完成 setup 前關閉連線：{reason}"
                        )));
                    }
                }
            }

            write
                .send(Message::Text(client_msg.to_string().into()))
                .await
                .map_err(|e| {
                    AppError::Upstream(format!("傳送 Gemini Live 朗讀內容失敗：{e}"))
                })?;

            let mut pcm_buf: Vec<u8> = Vec::new();
            let mut sample_rate: u32 = 24000;

            loop {
                match read_live_json(&mut read, &mut write).await? {
                    LiveFrame::Json(payload) => {
                        if let Some(err_val) = payload.get("error") {
                            return Err(AppError::Upstream(format!(
                                "Gemini Live API 生成語音錯誤：{err_val}"
                            )));
                        }

                        let server_content = payload
                            .get("serverContent")
                            .or_else(|| payload.get("server_content"));

                        if let Some(sc) = server_content {
                            let parts = sc
                                .pointer("/modelTurn/parts")
                                .or_else(|| sc.pointer("/model_turn/parts"))
                                .and_then(|v| v.as_array());

                            if let Some(parts) = parts {
                                for part in parts {
                                    let Some(inline_data) =
                                        part.get("inlineData").or_else(|| part.get("inline_data"))
                                    else {
                                        continue;
                                    };

                                    if let Some(mime) = inline_data
                                        .get("mimeType")
                                        .or_else(|| inline_data.get("mime_type"))
                                        .and_then(|v| v.as_str())
                                    {
                                        if let Some(rate) = parse_sample_rate(mime) {
                                            sample_rate = rate;
                                        }
                                    }

                                    if let Some(b64) =
                                        inline_data.get("data").and_then(|v| v.as_str())
                                    {
                                        let chunk = BASE64.decode(b64).map_err(|e| {
                                            AppError::Upstream(format!(
                                                "Gemini Live 語音 Base64 解碼失敗：{e}"
                                            ))
                                        })?;
                                        pcm_buf.extend_from_slice(&chunk);
                                    }
                                }
                            }

                            let turn_complete = sc
                                .get("turnComplete")
                                .or_else(|| sc.get("turn_complete"))
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);

                            if turn_complete {
                                break;
                            }
                        }
                    }
                    LiveFrame::Closed(reason) => {
                        if pcm_buf.is_empty() {
                            return Err(AppError::Upstream(format!(
                                "Gemini Live API 關閉連線且未回傳音訊：{reason}"
                            )));
                        }
                        break;
                    }
                }
            }

            let _ = write.send(Message::Close(None)).await;

            if pcm_buf.is_empty() {
                return Err(AppError::Upstream(
                    "Gemini Live API 未回傳任何音訊資料。".to_string(),
                ));
            }

            Ok(pcm_to_wav(&pcm_buf, sample_rate, 1, 16))
        })
        .await
        .map_err(|_| AppError::Upstream("Gemini Live API 語音生成逾時（超過 60 秒）。".to_string()))?
    }
}

enum LiveFrame {
    Json(Value),
    Closed(String),
}

fn build_guide_request_body(
    trip_title: &str,
    place_name: &str,
    duration_minutes: i64,
    style: GuideStyle,
    web_context: Option<&str>,
    today: &str,
) -> Value {
    let duration_desc = if duration_minutes == 0 {
        "路過或備案站點（停留時間彈性）".to_string()
    } else {
        format!("預計停留 {} 分鐘", duration_minutes)
    };

    let mut prompt = format!(
        "你是一位專業且充滿溫度的繁體中文私人旅遊導覽員。今天日期是 {today}。請根據以下資訊為旅客撰寫專屬景點導覽：\n\
        - 行程主題：{trip_title}\n\
        - 景點/活動名稱：{place_name}\n\
        - 行程安排：{duration_desc}\n\
        - 導覽風格：{style_desc}\n\n\
        請嚴格使用繁體中文（台灣用語）輸出 JSON，包含以下四個欄位：\n\
        1. story：景點背景故事、歷史文化或特色脈絡（約 120 至 180 字）。\n\
        2. highlights：2 至 4 個具體「必看亮點」或推薦體驗（每點簡潔明確，20 至 45 字）。\n\
        3. tips：2 至 3 個「在地實用建議」（包含動線、拍照、美食或留意事項，每點 20 至 45 字）。\n\
        4. narration_script：一段專為語音合成設計的口語導覽講稿（約 180 至 250 字），須像真人導覽員自然親切地對旅客說話，不可包含任何 Markdown 符號、項目符號或表情符號。",
        style_desc = style.prompt_instruction()
    );

    if let Some(ctx) = web_context.map(str::trim).filter(|s| !s.is_empty()) {
        prompt.push_str(&format!(
            "\n\n以下是即時網路搜尋取得的最新參考資訊，請優先核對並融入最新的營業時間、門票價格、活動展覽或注意事項（同時仍須嚴格遵守上述 JSON schema 與四個欄位格式輸出）。在 `tips` 欄位中提及官網或查詢資訊時，可使用 [來源名稱](真實網址) 格式附上該資料來源的實際網址；但 `narration_script` 欄位必須保持純口語朗讀稿，絕對不可包含任何網址、http/https 連結或 Markdown 符號：\n{ctx}\n\n請注意：無論上方參考資料使用何種語言（包含簡體中文、日文或英文），請務必轉寫並整理為台灣繁體中文後再填入上述 JSON 的 `story`、`highlights`、`tips` 與 `narration_script` 四個欄位，不可夾雜簡體字或未翻譯的外文句子。"
        ));
    }

    let system_text = format!(
        "{TRADITIONAL_CHINESE_SYSTEM_RULE}\n你正在為去趣行程旅客撰寫結構化 JSON 景點導覽，四個 JSON 欄位（story、highlights、tips、narration_script）都必須嚴格以台灣繁體中文輸出，不可夾雜簡體字或非繁體中文段落。"
    );

    json!({
        "systemInstruction": {
            "parts": [{ "text": system_text }]
        },
        "contents": [{
            "role": "user",
            "parts": [{ "text": prompt }]
        }],
        "generationConfig": {
            "temperature": 0.7,
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "story": { "type": "STRING" },
                    "highlights": {
                        "type": "ARRAY",
                        "items": { "type": "STRING" }
                    },
                    "tips": {
                        "type": "ARRAY",
                        "items": { "type": "STRING" }
                    },
                    "narration_script": { "type": "STRING" }
                },
                "required": ["story", "highlights", "tips", "narration_script"]
            }
        }
    })
}

fn chat_tool_declarations() -> Value {
    json!([{
        "functionDeclarations": [
            {
                "name": "web_search",
                "description": "搜尋即時網路資訊，查詢景點最新營業時間、門票價格、公休日、天氣預報、交通異動、近期活動或在地餐廳評價。",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "query": {
                            "type": "STRING",
                            "description": "精簡明確的搜尋關鍵字，可使用繁體中文、日文或英文。"
                        }
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "fetch_webpage",
                "description": "讀取並擷取指定網址（URL）的網頁內文，適合使用者提供網址或需深入確認官網公告與活動頁面時使用。",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "url": {
                            "type": "STRING",
                            "description": "完整的 http:// 或 https:// 網頁網址。"
                        }
                    },
                    "required": ["url"]
                }
            }
        ]
    }])
}

fn extract_model_content(payload: &Value) -> Result<Value, AppError> {
    payload
        .pointer("/candidates/0/content")
        .cloned()
        .ok_or_else(|| AppError::Upstream("Gemini Chat API 回應中找不到回覆內容。".to_string()))
}

fn extract_parts_from_content(content: &Value) -> Result<&[Value], AppError> {
    content
        .get("parts")
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .ok_or_else(|| AppError::Upstream("Gemini Chat API 回應中找不到回覆內容。".to_string()))
}

fn join_text_parts(parts: &[Value]) -> Result<String, AppError> {
    let reply: String = parts
        .iter()
        .filter(|p| !p.get("thought").and_then(|v| v.as_bool()).unwrap_or(false))
        .filter_map(|p| p.get("text").and_then(|v| v.as_str()))
        .collect::<Vec<_>>()
        .join("\n");

    let trimmed = reply.trim();
    if trimmed.is_empty() {
        return Err(AppError::Upstream(
            "Gemini Chat API 回傳空白回覆，請稍後再試。".to_string(),
        ));
    }

    Ok(trimmed.to_string())
}

async fn execute_tavily_tool_call(
    client: &TavilyClient,
    function_call: &Value,
    collected_sources: &mut Vec<WebSource>,
    search_queries: &mut Vec<String>,
) -> Value {
    let name = function_call
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let args = function_call.get("args");

    let response_obj = match name {
        "web_search" => {
            let query = args
                .and_then(|a| a.get("query"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if query.is_empty() {
                json!({ "error": "搜尋關鍵字 query 不可為空白。" })
            } else {
                if !search_queries.iter().any(|q| q == query) {
                    search_queries.push(query.to_string());
                }
                match client.search(query).await {
                    Ok(results) => {
                        for item in &results {
                            collected_sources.push(WebSource {
                                title: item.title.clone(),
                                url: item.url.clone(),
                            });
                        }
                        json!({
                            "results": results,
                            "reply_language_requirement": TOOL_TRADITIONAL_ZH_REMINDER
                        })
                    }
                    Err(err) => {
                        tracing::warn!(%query, %err, "Tavily web_search tool call failed");
                        json!({ "error": err.to_string() })
                    }
                }
            }
        }
        "fetch_webpage" => {
            let target_url = args
                .and_then(|a| a.get("url"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if target_url.is_empty() {
                json!({ "error": "網頁網址 url 不可為空白。" })
            } else {
                match client.extract(target_url).await {
                    Ok(Some(result)) => {
                        collected_sources.push(WebSource {
                            title: result.title.clone(),
                            url: result.url.clone(),
                        });
                        json!({
                            "result": result,
                            "reply_language_requirement": TOOL_TRADITIONAL_ZH_REMINDER
                        })
                    }
                    Ok(None) => json!({ "error": "無法從該網址擷取有效網頁內容。" }),
                    Err(err) => {
                        tracing::warn!(url = %target_url, %err, "Tavily fetch_webpage tool call failed");
                        json!({ "error": err.to_string() })
                    }
                }
            }
        }
        other => json!({ "error": format!("未知的工具名稱：{other}") }),
    };

    let mut fn_resp = json!({
        "name": name,
        "response": response_obj,
    });
    if let Some(id) = function_call.get("id").filter(|v| !v.is_null()) {
        fn_resp["id"] = id.clone();
    }

    json!({ "functionResponse": fn_resp })
}

async fn read_live_json<S, W>(read: &mut S, write: &mut W) -> Result<LiveFrame, AppError>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
    W: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    while let Some(next) = read.next().await {
        let msg = next
            .map_err(|e| AppError::Upstream(format!("Gemini Live WebSocket 讀取失敗：{e}")))?;

        match msg {
            Message::Text(text) => {
                let val: Value = serde_json::from_str(&text).map_err(|e| {
                    AppError::Upstream(format!("解析 Gemini Live JSON 回應失敗：{e}"))
                })?;
                return Ok(LiveFrame::Json(val));
            }
            Message::Binary(bytes) => {
                let text = std::str::from_utf8(&bytes).map_err(|e| {
                    AppError::Upstream(format!("Gemini Live 二進位訊息非有效 UTF-8：{e}"))
                })?;
                let val: Value = serde_json::from_str(text).map_err(|e| {
                    AppError::Upstream(format!("解析 Gemini Live Binary JSON 回應失敗：{e}"))
                })?;
                return Ok(LiveFrame::Json(val));
            }
            Message::Ping(payload) => {
                let _ = write.send(Message::Pong(payload)).await;
            }
            Message::Pong(_) => {}
            Message::Close(frame) => {
                let reason = match frame {
                    Some(f) if !f.reason.is_empty() => format!("{} ({})", f.reason, f.code),
                    Some(f) => format!("code {}", f.code),
                    None => "無詳細關閉原因".to_string(),
                };
                return Ok(LiveFrame::Closed(reason));
            }
            Message::Frame(_) => {}
        }
    }

    Ok(LiveFrame::Closed("連線已結束".to_string()))
}

fn url_regex() -> &'static Regex {
    static URL_RE: OnceLock<Regex> = OnceLock::new();
    URL_RE.get_or_init(|| {
        Regex::new(r"https?://[^\s)\]>。，、；！？「」『』（）]+").expect("valid url regex")
    })
}

fn normalize_taiwan_phrases(text: &str) -> String {
    const TAIWAN_PHRASES: &[(&str, &str)] = &[
        ("信息", "資訊"),
        ("里脊", "里肌"),
        ("視頻", "影片"),
        ("軟件", "軟體"),
        ("網絡", "網路"),
        ("聯繫", "聯絡"),
    ];

    let mut out = text.to_string();
    for (from, to) in TAIWAN_PHRASES {
        if out.contains(from) {
            out = out.replace(from, to);
        }
    }
    out
}

/// Converts Simplified Chinese / Mainland terms to Taiwan Traditional Chinese (`zh-TW`)
/// while preserving `http(s)://` URLs verbatim and avoiding ambiguous single-char traps.
pub fn convert_to_zh_tw_preserving_urls(text: &str) -> String {
    let url_re = url_regex();
    let mut out = String::with_capacity(text.len());
    let mut last_end = 0;

    for mat in url_re.find_iter(text) {
        if mat.start() > last_end {
            let converted = zhconv(&text[last_end..mat.start()], Variant::ZhTW);
            out.push_str(&normalize_taiwan_phrases(&converted));
        }
        out.push_str(mat.as_str());
        last_end = mat.end();
    }

    if last_end < text.len() {
        let converted = zhconv(&text[last_end..], Variant::ZhTW);
        out.push_str(&normalize_taiwan_phrases(&converted));
    }

    out
}

/// Detects non-Traditional-Chinese prose (Japanese kana, Korean Hangul, Cyrillic/Thai/Arabic,
/// pure/dominant English replies, or 4+-word English clauses/titles) outside URLs.
pub fn needs_traditional_chinese_rewrite(text: &str) -> bool {
    let stripped = url_regex().replace_all(text, " ");

    let mut cjk_chars: usize = 0;
    let mut kana_chars: usize = 0;
    let mut hangul_chars: usize = 0;
    let mut other_foreign_chars: usize = 0;
    let mut latin_letters: usize = 0;

    let mut current_word_letters: usize = 0;
    let mut consecutive_english_words: usize = 0;
    let mut max_consecutive_english_words: usize = 0;

    for ch in stripped.chars() {
        if ch.is_ascii_alphabetic() {
            latin_letters += 1;
            current_word_letters += 1;
            continue;
        }
        if ch.is_ascii_digit() {
            continue;
        }

        if current_word_letters >= 2 {
            consecutive_english_words += 1;
            if consecutive_english_words > max_consecutive_english_words {
                max_consecutive_english_words = consecutive_english_words;
            }
        }
        current_word_letters = 0;

        let is_cjk = matches!(ch, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}');
        let is_kana = matches!(ch, '\u{3040}'..='\u{309F}' | '\u{30A0}'..='\u{30FF}');
        let is_hangul = matches!(ch, '\u{AC00}'..='\u{D7AF}' | '\u{1100}'..='\u{11FF}');
        let is_other_foreign = matches!(
            ch,
            '\u{0400}'..='\u{04FF}'
                | '\u{0E00}'..='\u{0E7F}'
                | '\u{0600}'..='\u{06FF}'
                | '\u{0900}'..='\u{097F}'
        );

        if is_cjk {
            cjk_chars += 1;
            consecutive_english_words = 0;
        } else if is_kana {
            kana_chars += 1;
            consecutive_english_words = 0;
        } else if is_hangul {
            hangul_chars += 1;
            consecutive_english_words = 0;
        } else if is_other_foreign {
            other_foreign_chars += 1;
            consecutive_english_words = 0;
        } else if ch == '\n' || ch == '\r' {
            consecutive_english_words = 0;
        }
    }

    if current_word_letters >= 2 {
        consecutive_english_words += 1;
        if consecutive_english_words > max_consecutive_english_words {
            max_consecutive_english_words = consecutive_english_words;
        }
    }

    kana_chars >= 2
        || hangul_chars >= 2
        || other_foreign_chars >= 2
        || (cjk_chars < 8 && latin_letters >= 10)
        || (latin_letters > cjk_chars && latin_letters >= 20)
        || max_consecutive_english_words >= 4
}

fn paren_gloss_regex() -> &'static Regex {
    static PAREN_RE: OnceLock<Regex> = OnceLock::new();
    PAREN_RE.get_or_init(|| Regex::new(r"[ \t]*(?:\(([^()\n]+)\)|（([^（）\n]+)）)").expect("valid paren regex"))
}

/// Removes non-CJK parenthetical glosses (e.g. `(ロースかつ)` or `(Rapidly Rotating Bouncing Spheres)`)
/// that contain Japanese kana, Korean Hangul, or 4+ English words, while preserving URLs and itinerary names.
pub fn strip_foreign_parenthetical_glosses(text: &str) -> String {
    let url_re = url_regex();
    let paren_re = paren_gloss_regex();

    let clean_segment = |seg: &str| -> String {
        paren_re
            .replace_all(seg, |caps: &regex::Captures<'_>| {
                let inner = caps
                    .get(1)
                    .or_else(|| caps.get(2))
                    .map(|m| m.as_str())
                    .unwrap_or("");
                let trimmed = inner.trim();
                if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                    return caps[0].to_string();
                }

                let has_cjk = trimmed
                    .chars()
                    .any(|c| matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}'));
                let has_kana_or_hangul = trimmed.chars().any(|c| {
                    matches!(
                        c,
                        '\u{3040}'..='\u{309F}'
                            | '\u{30A0}'..='\u{30FF}'
                            | '\u{AC00}'..='\u{D7AF}'
                            | '\u{1100}'..='\u{11FF}'
                    )
                });
                let english_word_count = trimmed
                    .split(|c: char| !c.is_ascii_alphanumeric())
                    .filter(|w| w.chars().filter(|c| c.is_ascii_alphabetic()).count() >= 2)
                    .count();

                if !has_cjk && (has_kana_or_hangul || english_word_count >= 4) {
                    String::new()
                } else {
                    caps[0].to_string()
                }
            })
            .into_owned()
    };

    let mut out = String::with_capacity(text.len());
    let mut last_end = 0;
    for mat in url_re.find_iter(text) {
        if mat.start() > last_end {
            out.push_str(&clean_segment(&text[last_end..mat.start()]));
        }
        out.push_str(mat.as_str());
        last_end = mat.end();
    }
    if last_end < text.len() {
        out.push_str(&clean_segment(&text[last_end..]));
    }
    out
}

fn parse_sample_rate(mime_type: &str) -> Option<u32> {
    for part in mime_type.split(';') {
        let trimmed = part.trim();
        if let Some(val) = trimmed.strip_prefix("rate=") {
            if let Ok(rate) = val.trim().parse::<u32>() {
                return Some(rate);
            }
        }
    }
    None
}

/// Wraps raw little-endian PCM bytes with a standard 44-byte RIFF/WAVE header.
pub fn pcm_to_wav(
    pcm_bytes: &[u8],
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
) -> Vec<u8> {
    let data_len = pcm_bytes.len() as u32;
    let byte_rate = sample_rate * (channels as u32) * (bits_per_sample as u32 / 8);
    let block_align = channels * (bits_per_sample / 8);
    let riff_chunk_size = 36u32.saturating_add(data_len);

    let mut wav = Vec::with_capacity(44 + pcm_bytes.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_chunk_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm_bytes);
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_to_wav_produces_valid_44_byte_header() {
        let pcm = vec![0x01u8, 0x02, 0x03, 0x04, 0x05, 0x06];
        let wav = pcm_to_wav(&pcm, 24000, 1, 16);

        assert_eq!(wav.len(), 44 + pcm.len());
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(
            u32::from_le_bytes(wav[4..8].try_into().unwrap()),
            36 + pcm.len() as u32
        );
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes(wav[16..20].try_into().unwrap()), 16);
        assert_eq!(u16::from_le_bytes(wav[20..22].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 24000);
        assert_eq!(u32::from_le_bytes(wav[28..32].try_into().unwrap()), 48000);
        assert_eq!(u16::from_le_bytes(wav[32..34].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(
            u32::from_le_bytes(wav[40..44].try_into().unwrap()),
            pcm.len() as u32
        );
        assert_eq!(&wav[44..], pcm.as_slice());
    }

    #[test]
    fn parses_sample_rate_from_mime_type() {
        assert_eq!(
            parse_sample_rate("audio/L16;codec=pcm;rate=24000"),
            Some(24000)
        );
        assert_eq!(parse_sample_rate("audio/pcm;rate=16000"), Some(16000));
        assert_eq!(parse_sample_rate("audio/pcm"), None);
    }

    #[test]
    fn join_text_parts_skips_thought_parts_and_joins_visible_text() {
        let parts = vec![
            json!({ "thought": true, "text": "internal reasoning" }),
            json!({ "text": "第一段回覆" }),
            json!({ "text": "第二段回覆" }),
        ];
        assert_eq!(join_text_parts(&parts).unwrap(), "第一段回覆\n第二段回覆");
    }

    #[test]
    fn chat_tool_declarations_defines_expected_functions() {
        let tools = chat_tool_declarations();
        let decls = tools[0]["functionDeclarations"]
            .as_array()
            .expect("functionDeclarations array");
        let names: Vec<&str> = decls
            .iter()
            .filter_map(|d| d.get("name").and_then(|v| v.as_str()))
            .collect();
        assert_eq!(names, vec!["web_search", "fetch_webpage"]);
    }

    #[test]
    fn guide_request_body_includes_traditional_chinese_system_rule_and_web_reminder() {
        let body = build_guide_request_body(
            "2026大阪秋季漫遊",
            "Kiyomizu-dera",
            60,
            GuideStyle::Cultural,
            Some("[1] Official Site (https://example.com)\nOpen 06:00-18:00 daily."),
            "2026-11-24",
        );

        let sys_text = body["systemInstruction"]["parts"][0]["text"]
            .as_str()
            .expect("systemInstruction text");
        assert!(sys_text.contains("繁體中文（台灣正體中文與台灣慣用語）"));
        assert!(sys_text.contains("絕對禁止使用任何簡體字"));

        let prompt_text = body["contents"][0]["parts"][0]["text"]
            .as_str()
            .expect("user prompt text");
        assert!(prompt_text.contains("不可夾雜簡體字或未翻譯的外文句子"));

        let required = body["generationConfig"]["responseSchema"]["required"]
            .as_array()
            .expect("required schema fields");
        assert_eq!(required.len(), 4);
    }

    #[test]
    fn convert_to_zh_tw_preserving_urls_converts_simplified_and_keeps_urls_intact() {
        let input = "这里推荐几个热门餐厅，拉面很好吃，里脊猪排和详细路线与信息请看 [大阪攻略](https://example.com/zh-hans/info?q=餐厅) 或 https://www.teamlab.art/zh-hans/e/kyoto 。牆面、鏡面、畫面、平台與里肌肉都應維持原樣。";
        let out = convert_to_zh_tw_preserving_urls(input);
        assert!(
            out.contains("這裡推薦幾個熱門餐廳，拉麵很好吃，里肌豬排和詳細路線與資訊請看"),
            "actual out: {out}"
        );
        assert!(out.contains("牆面、鏡面、畫面、平台與里肌肉都應維持原樣。"), "actual out: {out}");
        assert!(!out.contains("牆麵"), "actual out: {out}");
        assert!(!out.contains("鏡麵"), "actual out: {out}");
        assert!(!out.contains("畫麵"), "actual out: {out}");
        assert!(!out.contains("裡肌"), "actual out: {out}");
        assert!(out.contains("https://example.com/zh-hans/info?q=餐厅"), "actual out: {out}");
        assert!(out.contains("https://www.teamlab.art/zh-hans/e/kyoto"), "actual out: {out}");
    }

    #[test]
    fn needs_traditional_chinese_rewrite_detects_foreign_prose_and_allows_short_venues() {
        let ok_reply = "推薦前往 teamLab Biovortex Kyoto 參觀 [官方網站](https://www.teamlab.art/zh-hans/e/kyoto) ，搭乘 JR 至京都車站步行即可抵達。";
        assert!(!needs_traditional_chinese_rewrite(ok_reply));

        let eng_title_reply = "這裡非常好拍 [teamLab Biovortex Kyoto: What to Know Before You Visit | Japan Cheapo](https://japancheapo.com/guide/) 。";
        assert!(needs_traditional_chinese_rewrite(eng_title_reply));

        let kana_reply = "來到名代かつくら，必點里肌肉（ロース）與腰內肉（ヒューカツ）炸豬排套餐。";
        assert!(needs_traditional_chinese_rewrite(kana_reply));

        let pure_eng_reply = "You can visit Kiyomizu-dera early in the morning before 8 AM.";
        assert!(needs_traditional_chinese_rewrite(pure_eng_reply));
    }

    #[test]
    fn strip_foreign_parenthetical_glosses_removes_kana_and_long_english_while_keeping_urls_and_cjk() {
        let input = "1. 經典里肌豬排套餐（ロースかつ）：\n• 快速旋轉跳跳球 (Rapidly Rotating Bouncing Spheres)：\n• 難波站(寄放行李) 與 名代豬排（Katsukura - Kyoto Porta），參考 [官網](https://example.com/(abc)/path)";
        let cleaned = strip_foreign_parenthetical_glosses(input);
        assert!(cleaned.contains("1. 經典里肌豬排套餐："), "cleaned: {cleaned}");
        assert!(cleaned.contains("• 快速旋轉跳跳球："), "cleaned: {cleaned}");
        assert!(cleaned.contains("難波站(寄放行李)"), "cleaned: {cleaned}");
        assert!(cleaned.contains("名代豬排（Katsukura - Kyoto Porta）"), "cleaned: {cleaned}");
        assert!(cleaned.contains("https://example.com/(abc)/path"), "cleaned: {cleaned}");
        assert!(!needs_traditional_chinese_rewrite(&cleaned));
    }
}
