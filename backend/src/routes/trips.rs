use std::{collections::HashMap, path::Path as FsPath};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::{
    db::AppState,
    error::AppError,
    models::{
        LatestTripEnvelope, TripDayResponse, TripEnvelope, TripItemResponse, TripListEnvelope,
        TripResponse, TripSummaryResponse, UpdateTripResponse,
    },
    parser::{parse_chictrip, ParsedDay},
    routes::auth::DeviceAuth,
};

#[derive(Debug, Deserialize)]
pub struct ImportTripRequest {
    pub raw_text: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTripRequest {
    pub raw_text: String,
}

/// A cached AI guide row snapshotted so it can be re-attached to a new trip item.
#[derive(Debug, Clone)]
struct SavedGuideRow {
    id: String,
    style: String,
    story: String,
    highlights_json: String,
    tips_json: String,
    narration_script: String,
    audio_path: Option<String>,
    sources_json: String,
    created_at: String,
    updated_at: String,
}

/// All cached guides of one old trip item, with the keys used for re-matching.
#[derive(Debug)]
struct OldItemBundle {
    day_number: i64,
    name: String,
    guides: Vec<SavedGuideRow>,
}

fn trip_not_found() -> AppError {
    AppError::NotFound("找不到該行程或無權存取。".to_string())
}

async fn remove_audio_file(audio_cache_dir: &FsPath, filename: &str) {
    let path = audio_cache_dir.join(filename);
    if let Err(err) = tokio::fs::remove_file(&path).await {
        if err.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(?path, %err, "Failed to remove audio cache file");
        }
    }
}

/// Inserts parsed days and items; returns `(new_item_id, day_number, trimmed_name)` per item.
async fn insert_days(
    tx: &mut Transaction<'_, Sqlite>,
    trip_id: &str,
    days: &[ParsedDay],
) -> Result<Vec<(i64, i64, String)>, AppError> {
    let mut inserted = Vec::new();

    for day in days {
        let day_res =
            sqlx::query("INSERT INTO trip_days (trip_id, day_number, date) VALUES (?, ?, ?)")
                .bind(trip_id)
                .bind(day.day_number)
                .bind(&day.date)
                .execute(&mut **tx)
                .await?;
        let day_id = day_res.last_insert_rowid();

        for item in &day.items {
            let item_res = sqlx::query(
                "INSERT INTO trip_items (day_id, sequence, start_time, name, duration_minutes) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(day_id)
            .bind(item.sequence)
            .bind(&item.start_time)
            .bind(&item.name)
            .bind(item.duration_minutes)
            .execute(&mut **tx)
            .await?;

            inserted.push((
                item_res.last_insert_rowid(),
                day.day_number,
                item.name.trim().to_string(),
            ));
        }
    }

    Ok(inserted)
}

/// Loads a full trip (days, items, cached styles) owned by `device_id`.
async fn load_trip_by_id(
    pool: &SqlitePool,
    trip_id: &str,
    device_id: &str,
) -> Result<Option<TripResponse>, AppError> {
    let trip_row = sqlx::query(
        "SELECT id, title, share_url, raw_text, created_at, updated_at FROM trips WHERE id = ? AND device_id = ?",
    )
    .bind(trip_id)
    .bind(device_id)
    .fetch_optional(pool)
    .await?;

    let Some(trip_row) = trip_row else {
        return Ok(None);
    };

    let day_rows = sqlx::query(
        "SELECT id, day_number, date FROM trip_days WHERE trip_id = ? ORDER BY day_number ASC",
    )
    .bind(trip_id)
    .fetch_all(pool)
    .await?;

    let item_rows = sqlx::query(
        "SELECT i.id, i.day_id, i.sequence, i.start_time, i.name, i.duration_minutes \
         FROM trip_items i \
         JOIN trip_days d ON i.day_id = d.id \
         WHERE d.trip_id = ? \
         ORDER BY d.day_number ASC, i.sequence ASC",
    )
    .bind(trip_id)
    .fetch_all(pool)
    .await?;

    let cached_rows = sqlx::query(
        "SELECT g.item_id, g.style \
         FROM ai_guides g \
         JOIN trip_items i ON g.item_id = i.id \
         JOIN trip_days d ON i.day_id = d.id \
         WHERE d.trip_id = ?",
    )
    .bind(trip_id)
    .fetch_all(pool)
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

    Ok(Some(TripResponse {
        id: trip_row.get("id"),
        title: trip_row.get("title"),
        share_url: trip_row.get("share_url"),
        raw_text: trip_row.get("raw_text"),
        created_at: trip_row.get("created_at"),
        updated_at: trip_row.get("updated_at"),
        days,
    }))
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
        "INSERT INTO trips (id, device_id, title, share_url, raw_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&trip_id)
    .bind(&auth.device_id)
    .bind(&parsed.title)
    .bind(&parsed.share_url)
    .bind(&req.raw_text)
    .bind(&created_at)
    .bind(&created_at)
    .execute(&mut *tx)
    .await?;

    insert_days(&mut tx, &trip_id, &parsed.days).await?;

    tx.commit().await?;

    let trip = load_trip_by_id(&state.pool, &trip_id, &auth.device_id)
        .await?
        .ok_or_else(trip_not_found)?;

    Ok((StatusCode::CREATED, Json(trip)))
}

pub async fn list_trips(
    auth: DeviceAuth,
    State(state): State<AppState>,
) -> Result<Json<TripListEnvelope>, AppError> {
    // Correlated subqueries (instead of multi-join aggregation) avoid row fan-out when an
    // item has several cached guide styles.
    let rows = sqlx::query(
        "SELECT t.id, t.title, t.share_url, t.created_at, t.updated_at, \
           (SELECT COUNT(*) FROM trip_days d WHERE d.trip_id = t.id) AS day_count, \
           (SELECT COUNT(*) FROM trip_items i JOIN trip_days d ON i.day_id = d.id \
              WHERE d.trip_id = t.id) AS item_count, \
           (SELECT COALESCE(SUM(i.duration_minutes), 0) FROM trip_items i \
              JOIN trip_days d ON i.day_id = d.id WHERE d.trip_id = t.id) AS total_duration_minutes, \
           (SELECT MIN(d.date) FROM trip_days d WHERE d.trip_id = t.id) AS start_date, \
           (SELECT MAX(d.date) FROM trip_days d WHERE d.trip_id = t.id) AS end_date, \
           (SELECT COUNT(DISTINCT g.item_id) FROM ai_guides g \
              JOIN trip_items i ON g.item_id = i.id \
              JOIN trip_days d ON i.day_id = d.id \
              WHERE d.trip_id = t.id) AS cached_guide_item_count \
         FROM trips t \
         WHERE t.device_id = ? \
         ORDER BY t.updated_at DESC, t.created_at DESC",
    )
    .bind(&auth.device_id)
    .fetch_all(&state.pool)
    .await?;

    let trips = rows
        .into_iter()
        .map(|row| TripSummaryResponse {
            id: row.get("id"),
            title: row.get("title"),
            share_url: row.get("share_url"),
            start_date: row.get("start_date"),
            end_date: row.get("end_date"),
            day_count: row.get("day_count"),
            item_count: row.get("item_count"),
            total_duration_minutes: row.get("total_duration_minutes"),
            cached_guide_item_count: row.get("cached_guide_item_count"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        })
        .collect();

    Ok(Json(TripListEnvelope { trips }))
}

pub async fn get_latest_trip(
    auth: DeviceAuth,
    State(state): State<AppState>,
) -> Result<Json<LatestTripEnvelope>, AppError> {
    let latest_id: Option<String> = sqlx::query_scalar(
        "SELECT id FROM trips WHERE device_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1",
    )
    .bind(&auth.device_id)
    .fetch_optional(&state.pool)
    .await?;

    let trip = match latest_id {
        Some(id) => load_trip_by_id(&state.pool, &id, &auth.device_id).await?,
        None => None,
    };

    Ok(Json(LatestTripEnvelope { trip }))
}

pub async fn get_trip(
    auth: DeviceAuth,
    State(state): State<AppState>,
    Path(trip_id): Path<String>,
) -> Result<Json<TripEnvelope>, AppError> {
    let trip = load_trip_by_id(&state.pool, &trip_id, &auth.device_id)
        .await?
        .ok_or_else(trip_not_found)?;
    Ok(Json(TripEnvelope { trip }))
}

pub async fn update_trip(
    auth: DeviceAuth,
    State(state): State<AppState>,
    Path(trip_id): Path<String>,
    Json(req): Json<UpdateTripRequest>,
) -> Result<Json<UpdateTripResponse>, AppError> {
    let parsed = parse_chictrip(&req.raw_text).map_err(|e| AppError::BadRequest(e.to_string()))?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);

    let mut tx = state.pool.begin().await?;

    let owned: Option<String> =
        sqlx::query_scalar("SELECT id FROM trips WHERE id = ? AND device_id = ?")
            .bind(&trip_id)
            .bind(&auth.device_id)
            .fetch_optional(&mut *tx)
            .await?;
    if owned.is_none() {
        return Err(trip_not_found());
    }

    // Snapshot every cached guide, grouped per old item in trip order.
    let guide_rows = sqlx::query(
        "SELECT g.id, g.item_id, g.style, g.story, g.highlights_json, g.tips_json, \
                g.narration_script, g.audio_path, g.sources_json, g.created_at, g.updated_at, \
                d.day_number, i.name \
         FROM ai_guides g \
         JOIN trip_items i ON g.item_id = i.id \
         JOIN trip_days d ON i.day_id = d.id \
         WHERE d.trip_id = ? \
         ORDER BY d.day_number ASC, i.sequence ASC, g.style ASC",
    )
    .bind(&trip_id)
    .fetch_all(&mut *tx)
    .await?;

    let mut bundles: Vec<OldItemBundle> = Vec::new();
    let mut last_item_id: Option<i64> = None;
    for row in guide_rows {
        let item_id: i64 = row.get("item_id");
        if last_item_id != Some(item_id) {
            let name: String = row.get("name");
            bundles.push(OldItemBundle {
                day_number: row.get("day_number"),
                name: name.trim().to_string(),
                guides: Vec::new(),
            });
            last_item_id = Some(item_id);
        }
        if let Some(bundle) = bundles.last_mut() {
            bundle.guides.push(SavedGuideRow {
                id: row.get("id"),
                style: row.get("style"),
                story: row.get("story"),
                highlights_json: row.get("highlights_json"),
                tips_json: row.get("tips_json"),
                narration_script: row.get("narration_script"),
                audio_path: row.get("audio_path"),
                sources_json: row.get("sources_json"),
                created_at: row.get("created_at"),
                updated_at: row.get("updated_at"),
            });
        }
    }

    // Cascades to trip_items and ai_guides.
    sqlx::query("DELETE FROM trip_days WHERE trip_id = ?")
        .bind(&trip_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "UPDATE trips SET title = ?, share_url = ?, raw_text = ?, updated_at = ? WHERE id = ? AND device_id = ?",
    )
    .bind(&parsed.title)
    .bind(&parsed.share_url)
    .bind(&req.raw_text)
    .bind(&now)
    .bind(&trip_id)
    .bind(&auth.device_id)
    .execute(&mut *tx)
    .await?;

    let new_items = insert_days(&mut tx, &trip_id, &parsed.days).await?;

    // Two-pass matching: same day + name first, then name only across days.
    let mut used = vec![false; bundles.len()];
    let mut assignment: Vec<Option<usize>> = vec![None; new_items.len()];

    for (new_idx, (_, day_number, name)) in new_items.iter().enumerate() {
        let found = bundles
            .iter()
            .enumerate()
            .find(|(old_idx, b)| !used[*old_idx] && b.day_number == *day_number && b.name == *name)
            .map(|(old_idx, _)| old_idx);
        if let Some(old_idx) = found {
            used[old_idx] = true;
            assignment[new_idx] = Some(old_idx);
        }
    }
    for (new_idx, (_, _, name)) in new_items.iter().enumerate() {
        if assignment[new_idx].is_some() {
            continue;
        }
        let found = bundles
            .iter()
            .enumerate()
            .find(|(old_idx, b)| !used[*old_idx] && b.name == *name)
            .map(|(old_idx, _)| old_idx);
        if let Some(old_idx) = found {
            used[old_idx] = true;
            assignment[new_idx] = Some(old_idx);
        }
    }

    let mut preserved_guides = 0usize;
    for (new_idx, (new_item_id, _, _)) in new_items.iter().enumerate() {
        let Some(old_idx) = assignment[new_idx] else {
            continue;
        };
        for guide in &bundles[old_idx].guides {
            sqlx::query(
                "INSERT INTO ai_guides \
                 (id, item_id, style, story, highlights_json, tips_json, narration_script, audio_path, sources_json, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&guide.id)
            .bind(new_item_id)
            .bind(&guide.style)
            .bind(&guide.story)
            .bind(&guide.highlights_json)
            .bind(&guide.tips_json)
            .bind(&guide.narration_script)
            .bind(&guide.audio_path)
            .bind(&guide.sources_json)
            .bind(&guide.created_at)
            .bind(&guide.updated_at)
            .execute(&mut *tx)
            .await?;
            preserved_guides += 1;
        }
    }

    tx.commit().await?;

    // Only guides that were NOT carried over lose their audio files.
    for (old_idx, bundle) in bundles.iter().enumerate() {
        if used[old_idx] {
            continue;
        }
        for guide in &bundle.guides {
            if let Some(filename) = &guide.audio_path {
                remove_audio_file(&state.audio_cache_dir, filename).await;
            }
        }
    }

    let trip = load_trip_by_id(&state.pool, &trip_id, &auth.device_id)
        .await?
        .ok_or_else(trip_not_found)?;

    Ok(Json(UpdateTripResponse {
        trip,
        preserved_guides,
    }))
}

pub async fn delete_trip(
    auth: DeviceAuth,
    State(state): State<AppState>,
    Path(trip_id): Path<String>,
) -> Result<StatusCode, AppError> {
    let owned: Option<String> =
        sqlx::query_scalar("SELECT id FROM trips WHERE id = ? AND device_id = ?")
            .bind(&trip_id)
            .bind(&auth.device_id)
            .fetch_optional(&state.pool)
            .await?;
    if owned.is_none() {
        return Err(trip_not_found());
    }

    let audio_files: Vec<String> = sqlx::query_scalar(
        "SELECT g.audio_path FROM ai_guides g \
         JOIN trip_items i ON g.item_id = i.id \
         JOIN trip_days d ON i.day_id = d.id \
         WHERE d.trip_id = ? AND g.audio_path IS NOT NULL",
    )
    .bind(&trip_id)
    .fetch_all(&state.pool)
    .await?;

    let result = sqlx::query("DELETE FROM trips WHERE id = ? AND device_id = ?")
        .bind(&trip_id)
        .bind(&auth.device_id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(trip_not_found());
    }

    for filename in &audio_files {
        remove_audio_file(&state.audio_cache_dir, filename).await;
    }

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::{
        db::init_pool,
        gemini::{GeminiClient, GeminiConfig},
        tavily::{TavilyClient, TavilyConfig},
    };

    struct TestEnv {
        state: AppState,
        auth: DeviceAuth,
        other: DeviceAuth,
        dir: PathBuf,
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    async fn setup() -> TestEnv {
        let pool = init_pool("sqlite::memory:")
            .await
            .expect("in-memory pool should init");
        let dir = std::env::temp_dir().join(format!("trip-agent-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");

        let mut devices = Vec::new();
        for n in 0..2 {
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO devices (id, device_token, binding_code, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(format!("token-{n}-{id}"))
            .bind(format!("TRIP-TEST-{n}"))
            .bind("test")
            .bind("2026-01-01T00:00:00.000Z")
            .execute(&pool)
            .await
            .expect("insert device");
            devices.push(DeviceAuth {
                device_id: id,
                binding_code: format!("TRIP-TEST-{n}"),
                display_name: "test".to_string(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
            });
        }
        let other = devices.pop().unwrap();
        let auth = devices.pop().unwrap();

        let state = AppState {
            pool,
            gemini: GeminiClient::new(GeminiConfig {
                api_key: String::new(),
                text_model: "test".to_string(),
                tts_model: "test".to_string(),
                tts_voice: "test".to_string(),
                tts_style: "test".to_string(),
                stt_model: "test".to_string(),
            }),
            tavily: TavilyClient::new(TavilyConfig {
                api_key: String::new(),
                search_depth: "basic".to_string(),
                max_results: 5,
            }),
            audio_cache_dir: dir.clone(),
        };

        TestEnv {
            state,
            auth,
            other,
            dir,
        }
    }

    fn raw(title: &str, days: &[(i64, &str, &[(&str, &str)])]) -> String {
        let mut out = format!("行程名稱：{title}\n\n");
        for (day_number, date, items) in days {
            out.push_str(&format!("第{day_number}天 ({date})\n"));
            for (time, name) in *items {
                out.push_str(&format!("{time} {name} (停留 01時00分)\n"));
            }
            out.push('\n');
        }
        out.push_str("點擊連結查看完整行程：https://chictrip-share.app.link/abc123\n");
        out
    }

    async fn import(env: &TestEnv, auth: &DeviceAuth, text: String) -> TripResponse {
        let (status, Json(trip)) = import_trip(
            auth.clone(),
            State(env.state.clone()),
            Json(ImportTripRequest { raw_text: text }),
        )
        .await
        .expect("import should succeed");
        assert_eq!(status, StatusCode::CREATED);
        trip
    }

    async fn add_guide(env: &TestEnv, item_id: i64, style: &str, with_audio: bool) -> Option<String> {
        let guide_id = Uuid::new_v4().to_string();
        let audio = with_audio.then(|| format!("{guide_id}.wav"));
        if let Some(name) = &audio {
            std::fs::write(env.dir.join(name), b"RIFFfake").expect("write wav");
        }
        sqlx::query(
            "INSERT INTO ai_guides (id, item_id, style, story, highlights_json, tips_json, narration_script, audio_path, sources_json, created_at, updated_at) \
             VALUES (?, ?, ?, 'story', '[]', '[]', 'script', ?, '[]', 'c', 'u')",
        )
        .bind(&guide_id)
        .bind(item_id)
        .bind(style)
        .bind(&audio)
        .execute(&env.state.pool)
        .await
        .expect("insert guide");
        audio
    }

    fn wav_exists(env: &TestEnv, name: &str) -> bool {
        env.dir.join(name).exists()
    }

    async fn guide_count(env: &TestEnv) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM ai_guides")
            .fetch_one(&env.state.pool)
            .await
            .unwrap()
    }

    async fn pause() {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }

    #[tokio::test]
    async fn list_trips_orders_by_updated_and_counts_exactly() {
        let env = setup().await;
        let a = import(
            &env,
            &env.auth,
            raw(
                "A",
                &[
                    (1, "2026/11/26", &[("09:00", "甲"), ("10:00", "乙")]),
                    (2, "2026/11/27", &[("09:00", "丙")]),
                ],
            ),
        )
        .await;
        pause().await;
        let b = import(
            &env,
            &env.auth,
            raw("B", &[(1, "2027/01/05", &[("09:00", "丁")])]),
        )
        .await;
        import(&env, &env.other, raw("Other", &[(1, "2027/01/05", &[("09:00", "戊")])])).await;

        // Item 甲 has 3 cached styles, 乙 has 2: a fan-out join would inflate counts.
        let first = a.days[0].items[0].item_id;
        let second = a.days[0].items[1].item_id;
        for style in ["cultural", "casual", "family"] {
            add_guide(&env, first, style, false).await;
        }
        for style in ["cultural", "casual"] {
            add_guide(&env, second, style, false).await;
        }

        let Json(list) = list_trips(env.auth.clone(), State(env.state.clone()))
            .await
            .unwrap();
        assert_eq!(list.trips.len(), 2);
        assert_eq!(list.trips[0].id, b.id);
        assert_eq!(list.trips[1].id, a.id);
        assert_eq!(b.created_at, b.updated_at);

        let sa = &list.trips[1];
        assert_eq!(sa.day_count, 2);
        assert_eq!(sa.item_count, 3);
        assert_eq!(sa.total_duration_minutes, 180);
        assert_eq!(sa.cached_guide_item_count, 2);
        assert_eq!(sa.start_date.as_deref(), Some("2026-11-26"));
        assert_eq!(sa.end_date.as_deref(), Some("2026-11-27"));
        assert_eq!(sa.share_url.as_deref(), Some("https://chictrip-share.app.link/abc123"));

        let sb = &list.trips[0];
        assert_eq!(sb.day_count, 1);
        assert_eq!(sb.item_count, 1);
        assert_eq!(sb.total_duration_minutes, 60);
        assert_eq!(sb.cached_guide_item_count, 0);

        // Updating A bumps it to the top and latest follows updated_at.
        pause().await;
        let _ = update_trip(
            env.auth.clone(),
            State(env.state.clone()),
            Path(a.id.clone()),
            Json(UpdateTripRequest {
                raw_text: raw("A2", &[(1, "2026/11/26", &[("09:00", "甲")])]),
            }),
        )
        .await
        .unwrap();
        let Json(list) = list_trips(env.auth.clone(), State(env.state.clone()))
            .await
            .unwrap();
        assert_eq!(list.trips[0].id, a.id);
        assert_eq!(list.trips[0].title, "A2");
        let Json(latest) = get_latest_trip(env.auth.clone(), State(env.state.clone()))
            .await
            .unwrap();
        assert_eq!(latest.trip.unwrap().id, a.id);

        let Json(empty) = list_trips(
            DeviceAuth {
                device_id: "nobody".to_string(),
                ..env.auth.clone()
            },
            State(env.state.clone()),
        )
        .await
        .unwrap();
        assert!(empty.trips.is_empty());
    }

    #[tokio::test]
    async fn get_trip_returns_raw_text_and_isolates_devices() {
        let env = setup().await;
        let text = raw("北海道", &[(1, "2026/12/01", &[("09:00", "札幌")])]);
        let trip = import(&env, &env.auth, text.clone()).await;
        assert_eq!(trip.raw_text, text);

        let Json(TripEnvelope { trip: got }) = get_trip(
            env.auth.clone(),
            State(env.state.clone()),
            Path(trip.id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(got.raw_text, text);
        assert_eq!(got.title, "北海道");
        assert_eq!(got.days.len(), 1);
        assert_eq!(got.days[0].items[0].name, "札幌");

        let err = get_trip(
            env.other.clone(),
            State(env.state.clone()),
            Path(trip.id.clone()),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));

        let err = get_trip(
            env.auth.clone(),
            State(env.state.clone()),
            Path("missing".to_string()),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn update_trip_preserves_matching_guides_and_cleans_orphans() {
        let env = setup().await;
        let trip = import(
            &env,
            &env.auth,
            raw(
                "T",
                &[
                    (
                        1,
                        "2026/11/26",
                        &[("09:00", "金閣寺"), ("10:00", "金閣寺"), ("11:00", "清水寺")],
                    ),
                    (2, "2026/11/27", &[("09:00", "伏見稻荷"), ("10:00", "嵐山")]),
                ],
            ),
        )
        .await;
        let d1 = &trip.days[0].items;
        let d2 = &trip.days[1].items;

        // Same-day duplicates: each has its own guide + wav.
        let dup_a = add_guide(&env, d1[0].item_id, "cultural", true).await.unwrap();
        let dup_a2 = add_guide(&env, d1[0].item_id, "casual", true).await.unwrap();
        let dup_b = add_guide(&env, d1[1].item_id, "family", true).await.unwrap();
        // 清水寺 will be removed.
        let orphan = add_guide(&env, d1[2].item_id, "cultural", true).await.unwrap();
        // 伏見稻荷 moves from day 2 to day 1.
        let moved = add_guide(&env, d2[0].item_id, "casual", true).await.unwrap();
        // 嵐山 stays on day 2.
        let stay = add_guide(&env, d2[1].item_id, "cultural", true).await.unwrap();

        let new_text = raw(
            "T new",
            &[
                (
                    1,
                    "2026/11/26",
                    &[("08:00", "伏見稻荷"), ("09:00", "金閣寺"), ("10:00", "金閣寺")],
                ),
                (2, "2026/11/27", &[("09:00", "嵐山"), ("10:00", "新景點")]),
            ],
        );

        // Wrong device and bad text are rejected without touching data.
        let err = update_trip(
            env.other.clone(),
            State(env.state.clone()),
            Path(trip.id.clone()),
            Json(UpdateTripRequest { raw_text: new_text.clone() }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        let err = update_trip(
            env.auth.clone(),
            State(env.state.clone()),
            Path(trip.id.clone()),
            Json(UpdateTripRequest { raw_text: "   ".to_string() }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
        assert_eq!(guide_count(&env).await, 6);
        assert!(wav_exists(&env, &orphan));

        pause().await;
        let Json(resp) = update_trip(
            env.auth.clone(),
            State(env.state.clone()),
            Path(trip.id.clone()),
            Json(UpdateTripRequest { raw_text: new_text.clone() }),
        )
        .await
        .unwrap();

        assert_eq!(resp.preserved_guides, 5);
        assert_eq!(resp.trip.id, trip.id);
        assert_eq!(resp.trip.title, "T new");
        assert_eq!(resp.trip.raw_text, new_text);
        assert_eq!(resp.trip.created_at, trip.created_at);
        assert!(resp.trip.updated_at > trip.updated_at);

        let sorted = |mut v: Vec<String>| {
            v.sort();
            v
        };
        let n1 = &resp.trip.days[0].items;
        let n2 = &resp.trip.days[1].items;
        // Cross-day moved stop keeps its guide.
        assert_eq!(n1[0].name, "伏見稻荷");
        assert_eq!(n1[0].cached_styles, vec!["casual".to_string()]);
        // Same-day duplicates keep their own guides in order.
        assert_eq!(
            sorted(n1[1].cached_styles.clone()),
            vec!["casual".to_string(), "cultural".to_string()]
        );
        assert_eq!(n1[2].cached_styles, vec!["family".to_string()]);
        assert_eq!(n2[0].name, "嵐山");
        assert_eq!(n2[0].cached_styles, vec!["cultural".to_string()]);
        assert!(n2[1].cached_styles.is_empty());

        // Guide ids and audio paths are preserved.
        let stored: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT id, audio_path FROM ai_guides")
                .fetch_all(&env.state.pool)
                .await
                .unwrap();
        assert_eq!(stored.len(), 5);
        for wav in [&dup_a, &dup_a2, &dup_b, &moved, &stay] {
            assert!(wav_exists(&env, wav), "{wav} should be kept");
            assert!(stored
                .iter()
                .any(|(id, path)| path.as_deref() == Some(wav.as_str())
                    && format!("{id}.wav") == *wav));
        }
        assert!(!wav_exists(&env, &orphan), "orphan wav should be removed");

        let Json(list) = list_trips(env.auth.clone(), State(env.state.clone()))
            .await
            .unwrap();
        assert_eq!(list.trips[0].cached_guide_item_count, 4);
    }

    #[tokio::test]
    async fn delete_trip_cascades_rows_and_wav_files() {
        let env = setup().await;
        let trip = import(
            &env,
            &env.auth,
            raw("D", &[(1, "2026/11/26", &[("09:00", "甲"), ("10:00", "乙")])]),
        )
        .await;
        let keep = import(&env, &env.auth, raw("Keep", &[(1, "2026/11/26", &[("09:00", "丙")])])).await;

        let w1 = add_guide(&env, trip.days[0].items[0].item_id, "cultural", true)
            .await
            .unwrap();
        let w2 = add_guide(&env, trip.days[0].items[1].item_id, "casual", true)
            .await
            .unwrap();
        add_guide(&env, trip.days[0].items[1].item_id, "family", false).await;
        let w_keep = add_guide(&env, keep.days[0].items[0].item_id, "cultural", true)
            .await
            .unwrap();

        let err = delete_trip(
            env.other.clone(),
            State(env.state.clone()),
            Path(trip.id.clone()),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        assert!(wav_exists(&env, &w1));
        assert_eq!(guide_count(&env).await, 4);

        let status = delete_trip(
            env.auth.clone(),
            State(env.state.clone()),
            Path(trip.id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::NO_CONTENT);

        assert!(!wav_exists(&env, &w1));
        assert!(!wav_exists(&env, &w2));
        assert!(wav_exists(&env, &w_keep));
        assert_eq!(guide_count(&env).await, 1);
        let days: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM trip_days WHERE trip_id = ?")
            .bind(&trip.id)
            .fetch_one(&env.state.pool)
            .await
            .unwrap();
        assert_eq!(days, 0);
        let items: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM trip_items")
            .fetch_one(&env.state.pool)
            .await
            .unwrap();
        assert_eq!(items, 1);

        let err = delete_trip(
            env.auth.clone(),
            State(env.state.clone()),
            Path(trip.id.clone()),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }
}
