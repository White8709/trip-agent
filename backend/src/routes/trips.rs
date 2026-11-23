use std::collections::HashMap;

use axum::{extract::State, http::StatusCode, Json};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    db::AppState,
    error::AppError,
    models::{LatestTripEnvelope, TripDayResponse, TripItemResponse, TripResponse},
    parser::parse_chictrip,
    routes::auth::DeviceAuth,
};

#[derive(Debug, Deserialize)]
pub struct ImportTripRequest {
    pub raw_text: String,
}

pub async fn import_trip(
    auth: DeviceAuth,
    State(state): State<AppState>,
    Json(req): Json<ImportTripRequest>,
) -> Result<(StatusCode, Json<TripResponse>), AppError> {
    let parsed = parse_chictrip(&req.raw_text).map_err(|e| AppError::BadRequest(e.to_string()))?;

    let trip_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);

    let mut tx = state.pool.begin().await?;

    sqlx::query(
        "INSERT INTO trips (id, device_id, title, share_url, raw_text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&trip_id)
    .bind(&auth.device_id)
    .bind(&parsed.title)
    .bind(&parsed.share_url)
    .bind(&req.raw_text)
    .bind(&created_at)
    .execute(&mut *tx)
    .await?;

    let mut days_resp = Vec::with_capacity(parsed.days.len());

    for day in parsed.days {
        let day_res =
            sqlx::query("INSERT INTO trip_days (trip_id, day_number, date) VALUES (?, ?, ?)")
                .bind(&trip_id)
                .bind(day.day_number)
                .bind(&day.date)
                .execute(&mut *tx)
                .await?;
        let day_id = day_res.last_insert_rowid();

        let mut items_resp = Vec::with_capacity(day.items.len());
        for item in day.items {
            let item_res = sqlx::query(
                "INSERT INTO trip_items (day_id, sequence, start_time, name, duration_minutes) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(day_id)
            .bind(item.sequence)
            .bind(&item.start_time)
            .bind(&item.name)
            .bind(item.duration_minutes)
            .execute(&mut *tx)
            .await?;

            items_resp.push(TripItemResponse {
                item_id: item_res.last_insert_rowid(),
                sequence: item.sequence,
                start_time: item.start_time,
                name: item.name,
                duration_minutes: item.duration_minutes,
                cached_styles: Vec::new(),
            });
        }

        days_resp.push(TripDayResponse {
            day_number: day.day_number,
            date: day.date,
            items: items_resp,
        });
    }

    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(TripResponse {
            id: trip_id,
            title: parsed.title,
            share_url: parsed.share_url,
            created_at,
            days: days_resp,
        }),
    ))
}

pub async fn get_latest_trip(
    auth: DeviceAuth,
    State(state): State<AppState>,
) -> Result<Json<LatestTripEnvelope>, AppError> {
    let trip_row = sqlx::query(
        "SELECT id, title, share_url, created_at FROM trips WHERE device_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&auth.device_id)
    .fetch_optional(&state.pool)
    .await?;

    let Some(trip_row) = trip_row else {
        return Ok(Json(LatestTripEnvelope { trip: None }));
    };

    let trip_id: String = trip_row.get("id");
    let title: String = trip_row.get("title");
    let share_url: Option<String> = trip_row.get("share_url");
    let created_at: String = trip_row.get("created_at");

    let day_rows = sqlx::query(
        "SELECT id, day_number, date FROM trip_days WHERE trip_id = ? ORDER BY day_number ASC",
    )
    .bind(&trip_id)
    .fetch_all(&state.pool)
    .await?;

    let item_rows = sqlx::query(
        "SELECT i.id, i.day_id, i.sequence, i.start_time, i.name, i.duration_minutes \
         FROM trip_items i \
         JOIN trip_days d ON i.day_id = d.id \
         WHERE d.trip_id = ? \
         ORDER BY d.day_number ASC, i.sequence ASC",
    )
    .bind(&trip_id)
    .fetch_all(&state.pool)
    .await?;

    let cached_rows = sqlx::query(
        "SELECT g.item_id, g.style \
         FROM ai_guides g \
         JOIN trip_items i ON g.item_id = i.id \
         JOIN trip_days d ON i.day_id = d.id \
         WHERE d.trip_id = ?",
    )
    .bind(&trip_id)
    .fetch_all(&state.pool)
    .await?;

    let mut styles_by_item: HashMap<i64, Vec<String>> = HashMap::new();
    for row in cached_rows {
        let item_id: i64 = row.get("item_id");
        let style: String = row.get("style");
        styles_by_item.entry(item_id).or_default().push(style);
    }

    let mut items_by_day: HashMap<i64, Vec<TripItemResponse>> = HashMap::new();
    for row in item_rows {
        let item_id: i64 = row.get("id");
        let day_id: i64 = row.get("day_id");
        let cached_styles = styles_by_item.remove(&item_id).unwrap_or_default();
        items_by_day
            .entry(day_id)
            .or_default()
            .push(TripItemResponse {
                item_id,
                sequence: row.get("sequence"),
                start_time: row.get("start_time"),
                name: row.get("name"),
                duration_minutes: row.get("duration_minutes"),
                cached_styles,
            });
    }

    let days = day_rows
        .into_iter()
        .map(|row| {
            let day_id: i64 = row.get("id");
            TripDayResponse {
                day_number: row.get("day_number"),
                date: row.get("date"),
                items: items_by_day.remove(&day_id).unwrap_or_default(),
            }
        })
        .collect();

    Ok(Json(LatestTripEnvelope {
        trip: Some(TripResponse {
            id: trip_id,
            title,
            share_url,
            created_at,
            days,
        }),
    }))
}
