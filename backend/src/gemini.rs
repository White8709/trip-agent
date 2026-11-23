use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::{error::AppError, models::GuideStyle};

#[derive(Debug, Clone)]
pub struct GeminiConfig {
    pub api_key: String,
    pub text_model: String,
    pub tts_model: String,
    pub tts_voice: String,
    pub tts_style: String,
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

    pub async fn generate_guide(
        &self,
        trip_title: &str,
        place_name: &str,
        duration_minutes: i64,
        style: GuideStyle,
    ) -> Result<GeneratedGuide, AppError> {
        let api_key = self.ensure_api_key()?;
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            self.config.text_model, api_key
        );

        let duration_desc = if duration_minutes == 0 {
            "路過或備案站點（停留時間彈性）".to_string()
        } else {
            format!("預計停留 {} 分鐘", duration_minutes)
        };

        let prompt = format!(
            "你是一位專業且充滿溫度的繁體中文私人旅遊導覽員。請根據以下資訊為旅客撰寫專屬景點導覽：\n\
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

        let body = json!({
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
        });

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
            .pointer("/candidates/0/content/parts/0/text")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AppError::Upstream("Gemini Text API 回應中找不到導覽內容文字。".to_string())
            })?;

        let cleaned = raw_text
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        serde_json::from_str::<GeneratedGuide>(cleaned).map_err(|e| {
            AppError::Upstream(format!("Gemini 回傳的 JSON 格式不符預期：{e}"))
        })
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
                        "請嚴格使用以下風格朗讀使用者提供的導覽稿，不要唸出這段指示也不要額外補充內容：{}",
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
}
