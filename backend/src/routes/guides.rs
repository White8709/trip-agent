use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    db::AppState,
    error::AppError,
    models::{AudioResponse, GuideEnvelope, GuideResponse, GuideStyle},
    routes::auth::DeviceAuth,
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
    let updated_at: String = row.get("updated_at");

    let highlights: Vec<String> = serde_json::from_str(&highlights_json)
        .map_err(|e| AppError::Internal(format!("解析 highlights JSON 失敗：{e}")))?;
    let tips: Vec<String> = serde_json::from_str(&tips_json)
        .map_err(|e| AppError::Internal(format!("解析 tips JSON 失敗：{e}")))?;

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
        updated_at,
    })
}

pub async fn get_guide(
    auth: DeviceAuth,
    State(state): State<AppState>,
    Path(item_id): Path<i64>,
    Query(query): Query<GuideQuery>,
) -> Result<Json<GuideEnvelope>, AppError> {
    let style = parse_style(query.style.as_deref())?;
    verify_item_ownership(&state, item_id, &auth.device_id).await?;

    let row = sqlx::query(
        "SELECT id, item_id, style, story, highlights_json, tips_json, narration_script, audio_path, updated_at \
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
    Path(item_id): Path<i64>,
    Json(req): Json<GenerateGuideRequest>,
) -> Result<Json<GuideEnvelope>, AppError> {
    let style = parse_style(req.style.as_deref())?;
    let (trip_title, item_name, duration_minutes) =
        verify_item_ownership(&state, item_id, &auth.device_id).await?;

    let existing = sqlx::query(
        "SELECT id, item_id, style, story, highlights_json, tips_json, narration_script, audio_path, updated_at \
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

    let generated = state
        .gemini
        .generate_guide(&trip_title, &item_name, duration_minutes, style)
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

    sqlx::query(
        "INSERT INTO ai_guides \
         (id, item_id, style, story, highlights_json, tips_json, narration_script, audio_path, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) \
         ON CONFLICT(item_id, style) DO UPDATE SET \
           id = excluded.id, \
           story = excluded.story, \
           highlights_json = excluded.highlights_json, \
           tips_json = excluded.tips_json, \
           narration_script = excluded.narration_script, \
           audio_path = NULL, \
           updated_at = excluded.updated_at",
    )
    .bind(&guide_id)
    .bind(item_id)
    .bind(style.as_str())
    .bind(&generated.story)
    .bind(&highlights_json)
    .bind(&tips_json)
    .bind(&generated.narration_script)
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
            updated_at: now,
        }),
    }))
}

pub async fn generate_guide_audio(
    auth: DeviceAuth,
    State(state): State<AppState>,
    Path(item_id): Path<i64>,
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

pub async fn serve_audio(
    State(state): State<AppState>,
    Path(guide_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let parsed_uuid = Uuid::parse_str(guide_id.trim())
        .map_err(|_| AppError::BadRequest("無效的語音識別碼。".to_string()))?;

    let disk_path = state
        .audio_cache_dir
        .join(format!("{}.wav", parsed_uuid));

    let bytes = tokio::fs::read(&disk_path).await.map_err(|err| {
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
