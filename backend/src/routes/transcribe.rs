use std::{pin::Pin, time::Duration};

use axum::{
    extract::{
        ws::{Message as AxumMessage, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::Response,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, tungstenite::Message as TungsteniteMessage};

use crate::{db::AppState, error::AppError, gemini::convert_to_zh_tw_preserving_urls};

#[derive(Debug, Deserialize)]
pub struct TranscribeQuery {
    #[serde(default)]
    pub token: String,
}

enum UpstreamFrame {
    Json(Value),
    Ignored,
    Closed(String),
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ServerTranscriptionEvents {
    interim: Option<String>,
    final_text: Option<String>,
    done: bool,
}

pub async fn transcribe_live(
    Query(params): Query<TranscribeQuery>,
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    let token = params.token.trim();
    if token.is_empty() {
        return Err(AppError::Unauthorized(
            "缺少裝置識別碼（token），請重新整理頁面。".to_string(),
        ));
    }

    let device_exists = sqlx::query("SELECT id FROM devices WHERE device_token = ?")
        .bind(token)
        .fetch_optional(&state.pool)
        .await?
        .is_some();

    if !device_exists {
        return Err(AppError::Unauthorized(
            "無效或過期的裝置識別碼，請重新註冊裝置。".to_string(),
        ));
    }

    let _ = state.gemini.api_key_checked()?.to_string();

    Ok(ws.on_upgrade(move |socket| handle_live_transcribe(socket, state)))
}

async fn handle_live_transcribe(client_ws: WebSocket, state: AppState) {
    let (mut client_write, mut client_read) = client_ws.split();

    let api_key = match state.gemini.api_key_checked() {
        Ok(key) => key.to_string(),
        Err(err) => {
            let _ = send_client_error(&mut client_write, &err.to_string()).await;
            let _ = client_write.send(AxumMessage::Close(None)).await;
            let _ = client_write.close().await;
            return;
        }
    };

    let ws_url = format!(
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={}",
        api_key
    );

    let upstream_ws = match tokio::time::timeout(Duration::from_secs(15), connect_async(&ws_url))
        .await
    {
        Ok(Ok((ws_stream, _))) => ws_stream,
        Ok(Err(err)) => {
            tracing::warn!(%err, "Failed to connect to Gemini Live STT WebSocket");
            let _ = send_client_error(&mut client_write, "無法連線至 Gemini Live 語音辨識服務")
                .await;
            let _ = client_write.send(AxumMessage::Close(None)).await;
            let _ = client_write.close().await;
            return;
        }
        Err(_) => {
            tracing::warn!("Timed out connecting to Gemini Live STT WebSocket");
            let _ = send_client_error(&mut client_write, "無法連線至 Gemini Live 語音辨識服務")
                .await;
            let _ = client_write.send(AxumMessage::Close(None)).await;
            let _ = client_write.close().await;
            return;
        }
    };

    let (mut upstream_write, mut upstream_read) = upstream_ws.split();

    let model_resource = build_model_resource(state.gemini.stt_model());
    let setup_msg = json!({
        "setup": {
            "model": model_resource,
            "generationConfig": { "responseModalities": ["TEXT"] },
            "inputAudioTranscription": {
                "languageCodes": ["zh-TW"],
                "mode": "SMART"
            }
        }
    });

    if let Err(err) = upstream_write
        .send(TungsteniteMessage::Text(setup_msg.to_string().into()))
        .await
    {
        tracing::warn!(%err, "Failed to send Gemini Live STT setup message");
        let _ = send_client_error(&mut client_write, "無法連線至 Gemini Live 語音辨識服務").await;
        close_sockets(&mut upstream_write, &mut client_write).await;
        return;
    }

    if !wait_for_setup_complete(
        &mut upstream_read,
        &mut upstream_write,
        &mut client_read,
        &mut client_write,
    )
    .await
    {
        close_sockets(&mut upstream_write, &mut client_write).await;
        return;
    }

    if send_client_json(&mut client_write, json!({ "type": "ready" }))
        .await
        .is_err()
    {
        close_sockets(&mut upstream_write, &mut client_write).await;
        return;
    }

    let mut client_ended = false;
    let mut grace_deadline: Option<Pin<Box<tokio::time::Sleep>>> = None;

    let session_result = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            tokio::select! {
                _ = async {
                    match grace_deadline.as_mut() {
                        Some(sleep) => sleep.await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    let _ = send_client_json(&mut client_write, json!({ "type": "done" })).await;
                    break;
                }
                client_msg = client_read.next() => {
                    match client_msg {
                        Some(Ok(AxumMessage::Binary(pcm_bytes))) => {
                            if !client_ended && !pcm_bytes.is_empty() {
                                let b64 = BASE64.encode(&pcm_bytes);
                                let msg = json!({
                                    "realtimeInput": {
                                        "audio": {
                                            "mimeType": "audio/pcm;rate=16000",
                                            "data": b64
                                        }
                                    }
                                });
                                if upstream_write
                                    .send(TungsteniteMessage::Text(msg.to_string().into()))
                                    .await
                                    .is_err()
                                {
                                    let _ = send_client_error(
                                        &mut client_write,
                                        "傳送音訊至 Gemini Live 語音辨識失敗",
                                    )
                                    .await;
                                    break;
                                }
                            }
                        }
                        Some(Ok(AxumMessage::Text(txt))) => {
                            if !client_ended && is_client_end_message(&txt) {
                                client_ended = true;
                                let end_msg = json!({
                                    "realtimeInput": {
                                        "audioStreamEnd": true
                                    }
                                });
                                if upstream_write
                                    .send(TungsteniteMessage::Text(end_msg.to_string().into()))
                                    .await
                                    .is_err()
                                {
                                    let _ = send_client_json(
                                        &mut client_write,
                                        json!({ "type": "done" }),
                                    )
                                    .await;
                                    break;
                                }
                                grace_deadline = Some(Box::pin(tokio::time::sleep(
                                    Duration::from_millis(3500),
                                )));
                            }
                        }
                        Some(Ok(AxumMessage::Ping(_))) | Some(Ok(AxumMessage::Pong(_))) => {}
                        Some(Ok(AxumMessage::Close(_))) | None => {
                            let _ = upstream_write.send(TungsteniteMessage::Close(None)).await;
                            break;
                        }
                        Some(Err(err)) => {
                            tracing::debug!(%err, "Client WebSocket read error during live transcribe");
                            let _ = upstream_write.send(TungsteniteMessage::Close(None)).await;
                            break;
                        }
                    }
                }
                upstream_msg = upstream_read.next() => {
                    let Some(res) = upstream_msg else {
                        if client_ended {
                            let _ = send_client_json(&mut client_write, json!({ "type": "done" })).await;
                        } else {
                            let _ = send_client_error(
                                &mut client_write,
                                "Gemini Live 語音辨識連線已意外中斷",
                            )
                            .await;
                        }
                        break;
                    };
                    let msg = match res {
                        Ok(m) => m,
                        Err(err) => {
                            let _ = send_client_error(
                                &mut client_write,
                                &format!("Gemini Live 語音辨識讀取失敗：{err}"),
                            )
                            .await;
                            break;
                        }
                    };
                    match decode_upstream_message(msg, &mut upstream_write).await {
                        Ok(UpstreamFrame::Json(payload)) => {
                            if let Some(err_msg) = extract_upstream_error(&payload) {
                                let _ = send_client_error(&mut client_write, &err_msg).await;
                                break;
                            }
                            let events = extract_transcription_events(&payload);
                            if let Some(interim) = events.interim {
                                let normalized = convert_to_zh_tw_preserving_urls(&interim);
                                if send_client_json(
                                    &mut client_write,
                                    json!({ "type": "interim", "text": normalized }),
                                )
                                .await
                                .is_err()
                                {
                                    break;
                                }
                            }
                            if let Some(final_text) = events.final_text {
                                let normalized = convert_to_zh_tw_preserving_urls(&final_text);
                                if send_client_json(
                                    &mut client_write,
                                    json!({ "type": "final", "text": normalized }),
                                )
                                .await
                                .is_err()
                                {
                                    break;
                                }
                            }
                            if events.done {
                                let _ = send_client_json(
                                    &mut client_write,
                                    json!({ "type": "done" }),
                                )
                                .await;
                                if client_ended {
                                    break;
                                }
                            }
                        }
                        Ok(UpstreamFrame::Ignored) => {}
                        Ok(UpstreamFrame::Closed(reason)) => {
                            if client_ended {
                                let _ = send_client_json(
                                    &mut client_write,
                                    json!({ "type": "done" }),
                                )
                                .await;
                            } else {
                                let _ = send_client_error(
                                    &mut client_write,
                                    &format!("Gemini Live 語音辨識連線已關閉：{reason}"),
                                )
                                .await;
                            }
                            break;
                        }
                        Err(err_msg) => {
                            let _ = send_client_error(&mut client_write, &err_msg).await;
                            break;
                        }
                    }
                }
            }
        }
    })
    .await;

    if session_result.is_err() {
        if client_ended {
            let _ = send_client_json(&mut client_write, json!({ "type": "done" })).await;
        } else {
            let _ = send_client_error(&mut client_write, "語音辨識單次連線已達 120 秒上限").await;
        }
    }

    close_sockets(&mut upstream_write, &mut client_write).await;
}

async fn wait_for_setup_complete<UR, UW, CR, CW>(
    upstream_read: &mut UR,
    upstream_write: &mut UW,
    client_read: &mut CR,
    client_write: &mut CW,
) -> bool
where
    UR: StreamExt<Item = Result<TungsteniteMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
    UW: SinkExt<TungsteniteMessage, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
    CR: StreamExt<Item = Result<AxumMessage, axum::Error>> + Unpin,
    CW: SinkExt<AxumMessage, Error = axum::Error> + Unpin,
{
    let setup_fut = async {
        loop {
            tokio::select! {
                client_msg = client_read.next() => {
                    match client_msg {
                        None | Some(Ok(AxumMessage::Close(_))) | Some(Err(_)) => return false,
                        Some(Ok(_)) => {}
                    }
                }
                upstream_msg = upstream_read.next() => {
                    let Some(res) = upstream_msg else {
                        let _ = send_client_error(client_write, "Gemini Live 語音辨識在初始化前關閉連線").await;
                        return false;
                    };
                    let msg = match res {
                        Ok(m) => m,
                        Err(err) => {
                            let _ = send_client_error(
                                client_write,
                                &format!("Gemini Live 語音辨識初始化讀取失敗：{err}"),
                            )
                            .await;
                            return false;
                        }
                    };
                    match decode_upstream_message(msg, upstream_write).await {
                        Ok(UpstreamFrame::Json(payload)) => {
                            if let Some(err_msg) = extract_upstream_error(&payload) {
                                let _ = send_client_error(client_write, &err_msg).await;
                                return false;
                            }
                            if is_setup_complete(&payload) {
                                return true;
                            }
                        }
                        Ok(UpstreamFrame::Ignored) => {}
                        Ok(UpstreamFrame::Closed(reason)) => {
                            let _ = send_client_error(
                                client_write,
                                &format!("Gemini Live 語音辨識在初始化前關閉連線：{reason}"),
                            )
                            .await;
                            return false;
                        }
                        Err(err_msg) => {
                            let _ = send_client_error(client_write, &err_msg).await;
                            return false;
                        }
                    }
                }
            }
        }
    };

    match tokio::time::timeout(Duration::from_secs(15), setup_fut).await {
        Ok(ready) => ready,
        Err(_) => {
            let _ = send_client_error(client_write, "等待 Gemini Live 語音辨識初始化逾時").await;
            false
        }
    }
}

async fn decode_upstream_message<W>(
    msg: TungsteniteMessage,
    upstream_write: &mut W,
) -> Result<UpstreamFrame, String>
where
    W: SinkExt<TungsteniteMessage, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    match msg {
        TungsteniteMessage::Text(text) => serde_json::from_str::<Value>(&text)
            .map(UpstreamFrame::Json)
            .map_err(|e| format!("解析 Gemini Live JSON 回應失敗：{e}")),
        TungsteniteMessage::Binary(bytes) => {
            let text = std::str::from_utf8(&bytes)
                .map_err(|e| format!("Gemini Live 二進位訊息非有效 UTF-8：{e}"))?;
            serde_json::from_str::<Value>(text)
                .map(UpstreamFrame::Json)
                .map_err(|e| format!("解析 Gemini Live Binary JSON 回應失敗：{e}"))
        }
        TungsteniteMessage::Ping(payload) => {
            let _ = upstream_write.send(TungsteniteMessage::Pong(payload)).await;
            Ok(UpstreamFrame::Ignored)
        }
        TungsteniteMessage::Pong(_) | TungsteniteMessage::Frame(_) => Ok(UpstreamFrame::Ignored),
        TungsteniteMessage::Close(frame) => {
            let reason = match frame {
                Some(f) if !f.reason.is_empty() => format!("{} ({})", f.reason, f.code),
                Some(f) => format!("code {}", f.code),
                None => "連線已關閉".to_string(),
            };
            Ok(UpstreamFrame::Closed(reason))
        }
    }
}

async fn send_client_json<CW>(client_write: &mut CW, payload: Value) -> Result<(), axum::Error>
where
    CW: SinkExt<AxumMessage, Error = axum::Error> + Unpin,
{
    client_write
        .send(AxumMessage::Text(payload.to_string().into()))
        .await
}

async fn send_client_error<CW>(client_write: &mut CW, message: &str) -> Result<(), axum::Error>
where
    CW: SinkExt<AxumMessage, Error = axum::Error> + Unpin,
{
    send_client_json(client_write, json!({ "type": "error", "message": message })).await
}

async fn close_sockets<UW, CW>(upstream_write: &mut UW, client_write: &mut CW)
where
    UW: SinkExt<TungsteniteMessage, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
    CW: SinkExt<AxumMessage, Error = axum::Error> + Unpin,
{
    let _ = upstream_write.send(TungsteniteMessage::Close(None)).await;
    let _ = upstream_write.close().await;
    let _ = client_write.send(AxumMessage::Close(None)).await;
    let _ = client_write.close().await;
}

fn build_model_resource(stt_model: &str) -> String {
    let trimmed = stt_model.trim();
    if trimmed.starts_with("models/") {
        trimmed.to_string()
    } else {
        format!("models/{trimmed}")
    }
}

fn is_setup_complete(payload: &Value) -> bool {
    payload.get("setupComplete").is_some() || payload.get("setup_complete").is_some()
}

fn extract_upstream_error(payload: &Value) -> Option<String> {
    let err_val = payload.get("error")?;
    let msg = err_val
        .get("message")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| err_val.to_string());
    Some(format!("Gemini Live 語音辨識錯誤：{msg}"))
}

fn is_client_end_message(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|s| s == "end"))
        .unwrap_or(false)
}

fn extract_transcription_events(payload: &Value) -> ServerTranscriptionEvents {
    let mut events = ServerTranscriptionEvents::default();
    let Some(sc) = payload
        .get("serverContent")
        .or_else(|| payload.get("server_content"))
    else {
        return events;
    };

    events.interim = sc
        .get("interimInputTranscription")
        .or_else(|| sc.get("interim_input_transcription"))
        .and_then(|v| v.get("text"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(ToString::to_string);

    events.final_text = sc
        .get("inputTranscription")
        .or_else(|| sc.get("input_transcription"))
        .and_then(|v| v.get("text"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(ToString::to_string);

    let generation_complete = sc
        .get("generationComplete")
        .or_else(|| sc.get("generation_complete"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let turn_complete = sc
        .get("turnComplete")
        .or_else(|| sc.get("turn_complete"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    events.done = generation_complete || turn_complete;
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_model_resource_prefixes_models_only_when_missing() {
        assert_eq!(
            build_model_resource("gemini-3.5-transcribe-live"),
            "models/gemini-3.5-transcribe-live"
        );
        assert_eq!(
            build_model_resource("models/gemini-3.5-transcribe-live"),
            "models/gemini-3.5-transcribe-live"
        );
    }

    #[test]
    fn detects_setup_complete_in_camel_and_snake_case() {
        assert!(is_setup_complete(&json!({ "setupComplete": {} })));
        assert!(is_setup_complete(&json!({ "setup_complete": {} })));
        assert!(!is_setup_complete(&json!({ "serverContent": {} })));
    }

    #[test]
    fn extracts_transcription_events_camel_and_snake_case() {
        let camel = json!({
            "serverContent": {
                "interimInputTranscription": { "text": "台北" },
                "inputTranscription": { "text": "   " },
                "generationComplete": true
            }
        });
        assert_eq!(
            extract_transcription_events(&camel),
            ServerTranscriptionEvents {
                interim: Some("台北".to_string()),
                final_text: None,
                done: true,
            }
        );

        let snake = json!({
            "server_content": {
                "interim_input_transcription": { "text": "" },
                "input_transcription": { "text": "台北101怎麼去" },
                "turn_complete": true
            }
        });
        assert_eq!(
            extract_transcription_events(&snake),
            ServerTranscriptionEvents {
                interim: None,
                final_text: Some("台北101怎麼去".to_string()),
                done: true,
            }
        );
    }

    #[test]
    fn detects_client_end_message_safely() {
        assert!(is_client_end_message(r#"{"type":"end"}"#));
        assert!(!is_client_end_message(r#"{"type":"ping"}"#));
        assert!(!is_client_end_message("not-json"));
    }
}
