use axum::{
    extract::{FromRequestParts, State},
    http::{request::Parts, StatusCode},
    Json,
};
use chrono::{SecondsFormat, Utc};
use rand::{distributions::Alphanumeric, Rng};
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    db::AppState,
    error::AppError,
    models::{DeviceProfileResponse, DeviceResponse},
};

#[derive(Debug, Clone)]
pub struct DeviceAuth {
    pub device_id: String,
    pub binding_code: String,
    pub display_name: String,
    pub created_at: String,
}

impl FromRequestParts<AppState> for DeviceAuth {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get("x-device-token")
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                AppError::Unauthorized("缺少裝置識別碼（X-Device-Token），請重新整理頁面。".to_string())
            })?;

        let row = sqlx::query(
            "SELECT id, binding_code, display_name, created_at FROM devices WHERE device_token = ?",
        )
        .bind(token)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            AppError::Unauthorized("無效或過期的裝置識別碼，請重新註冊裝置。".to_string())
        })?;

        Ok(DeviceAuth {
            device_id: row.get("id"),
            binding_code: row.get("binding_code"),
            display_name: row.get("display_name"),
            created_at: row.get("created_at"),
        })
    }
}

fn generate_binding_code() -> String {
    const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    let mut random_segment = |len: usize| -> String {
        (0..len)
            .map(|_| {
                let idx = rng.gen_range(0..CHARSET.len());
                CHARSET[idx] as char
            })
            .collect()
    };
    format!("TRIP-{}-{}", random_segment(4), random_segment(4))
}

fn generate_device_token() -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(24)
        .map(char::from)
        .collect();
    format!("{}-{}", Uuid::new_v4(), suffix)
}

pub async fn register_device(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<DeviceResponse>), AppError> {
    let id = Uuid::new_v4().to_string();
    let device_token = generate_device_token();
    let display_name = "我的旅行手帳".to_string();
    let created_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);

    let mut binding_code = String::new();
    let mut inserted = false;

    for _ in 0..6 {
        binding_code = generate_binding_code();
        let res = sqlx::query(
            "INSERT INTO devices (id, device_token, binding_code, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&device_token)
        .bind(&binding_code)
        .bind(&display_name)
        .bind(&created_at)
        .execute(&state.pool)
        .await;

        match res {
            Ok(_) => {
                inserted = true;
                break;
            }
            Err(sqlx::Error::Database(db_err)) if db_err.message().contains("UNIQUE") => {
                continue;
            }
            Err(e) => return Err(AppError::Database(e)),
        }
    }

    if !inserted {
        return Err(AppError::Internal(
            "無法產生唯一綁定碼，請稍後再試。".to_string(),
        ));
    }

    Ok((
        StatusCode::CREATED,
        Json(DeviceResponse {
            device_token,
            binding_code,
            display_name,
        }),
    ))
}

pub async fn get_me(auth: DeviceAuth) -> Json<DeviceProfileResponse> {
    Json(DeviceProfileResponse {
        binding_code: auth.binding_code,
        display_name: auth.display_name,
        created_at: auth.created_at,
    })
}

#[derive(Debug, Deserialize)]
pub struct UpdateMeRequest {
    pub display_name: String,
}

pub async fn update_me(
    auth: DeviceAuth,
    State(state): State<AppState>,
    Json(req): Json<UpdateMeRequest>,
) -> Result<Json<DeviceProfileResponse>, AppError> {
    let trimmed = req.display_name.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("裝置名稱不可為空白。".to_string()));
    }
    if trimmed.chars().count() > 40 {
        return Err(AppError::BadRequest(
            "裝置名稱請勿超過 40 個字元。".to_string(),
        ));
    }

    sqlx::query("UPDATE devices SET display_name = ? WHERE id = ?")
        .bind(trimmed)
        .bind(&auth.device_id)
        .execute(&state.pool)
        .await?;

    Ok(Json(DeviceProfileResponse {
        binding_code: auth.binding_code,
        display_name: trimmed.to_string(),
        created_at: auth.created_at,
    }))
}

#[derive(Debug, Deserialize)]
pub struct BindDeviceRequest {
    pub binding_code: String,
}

pub async fn bind_device(
    State(state): State<AppState>,
    Json(req): Json<BindDeviceRequest>,
) -> Result<Json<DeviceResponse>, AppError> {
    let code = req.binding_code.trim().to_uppercase();
    if code.is_empty() {
        return Err(AppError::BadRequest("請輸入綁定碼。".to_string()));
    }

    let row = sqlx::query(
        "SELECT device_token, binding_code, display_name FROM devices WHERE binding_code = ?",
    )
    .bind(&code)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| {
        AppError::NotFound("找不到此綁定碼對應的裝置，請確認輸入是否正確。".to_string())
    })?;

    Ok(Json(DeviceResponse {
        device_token: row.get("device_token"),
        binding_code: row.get("binding_code"),
        display_name: row.get("display_name"),
    }))
}
