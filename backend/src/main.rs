mod db;
mod error;
mod gemini;
mod models;
mod parser;
mod routes;

use std::{net::SocketAddr, path::PathBuf};

use axum::{
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::{
    db::{init_pool, AppState},
    gemini::{GeminiClient, GeminiConfig},
    routes::{auth, guides, trips},
};

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "trip_agent_backend=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3001);

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://data/trip_agent.db?mode=rwc".to_string());

    let audio_cache_dir = PathBuf::from(
        std::env::var("AUDIO_CACHE_DIR").unwrap_or_else(|_| "data/audio".to_string()),
    );

    if let Err(e) = std::fs::create_dir_all(&audio_cache_dir) {
        panic!("無法建立語音快取目錄 {:?}: {e}", audio_cache_dir);
    }

    let pool = init_pool(&database_url)
        .await
        .expect("Failed to initialize SQLite database pool");

    let gemini_config = GeminiConfig {
        api_key: std::env::var("GEMINI_API_KEY").unwrap_or_default(),
        text_model: std::env::var("GEMINI_TEXT_MODEL")
            .unwrap_or_else(|_| "gemini-3.5-flash-lite".to_string()),
        tts_model: std::env::var("GEMINI_TTS_MODEL")
            .unwrap_or_else(|_| "gemini-3.8-flash-lite-tts".to_string()),
        tts_voice: std::env::var("GEMINI_TTS_VOICE").unwrap_or_else(|_| "Leda".to_string()),
        tts_style: std::env::var("GEMINI_TTS_STYLE")
            .unwrap_or_else(|_| "口語化台灣年輕女性, 1.2倍速".to_string()),
    };

    let state = AppState {
        pool,
        gemini: GeminiClient::new(gemini_config),
        audio_cache_dir,
    };

    let api_router = Router::new()
        .route("/api/health", get(|| async { Json(json!({ "ok": true })) }))
        .route("/api/devices/register", post(auth::register_device))
        .route("/api/devices/me", get(auth::get_me).patch(auth::update_me))
        .route("/api/devices/bind", post(auth::bind_device))
        .route("/api/trips/import", post(trips::import_trip))
        .route("/api/trips/latest", get(trips::get_latest_trip))
        .route(
            "/api/items/{item_id}/guide",
            get(guides::get_guide).post(guides::generate_guide),
        )
        .route(
            "/api/items/{item_id}/guide/audio",
            post(guides::generate_guide_audio),
        )
        .route("/api/audio/{guide_id}", get(guides::serve_audio));

    let mut app = api_router
        .with_state(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let dist_dir = PathBuf::from("../frontend/dist");
    if dist_dir.exists() {
        tracing::info!(?dist_dir, "Serving static frontend build");
        let index_file = dist_dir.join("index.html");
        let serve_dir = ServeDir::new(&dist_dir).fallback(ServeFile::new(index_file));
        app = app.fallback_service(serve_dir);
    }

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("Listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind TCP listener");
    axum::serve(listener, app)
        .await
        .expect("Axum server exited unexpectedly");
}
