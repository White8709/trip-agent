mod db;
mod error;
mod gemini;
mod models;
mod parser;
mod routes;
mod tavily;

use std::{net::SocketAddr, path::PathBuf};

use axum::{
    extract::State,
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
    routes::{auth, guides, transcribe, trips},
    tavily::{TavilyClient, TavilyConfig},
};

#[tokio::main]
async fn main() {
    let dotenv_result = dotenvy::dotenv();

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "trip_agent_backend=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    if let Err(err) = dotenv_result {
        if !err.not_found() {
            tracing::error!(%err, "載入 .env 失敗，請檢查語法（含空白的值須加雙引號）");
        }
    }

    let host: std::net::IpAddr = std::env::var("HOST")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| std::net::IpAddr::from([127, 0, 0, 1]));

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
        stt_model: std::env::var("GEMINI_STT_MODEL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "gemini-3.5-transcribe-live".to_string()),
    };

    let tavily_config = TavilyConfig {
        api_key: std::env::var("TAVILY_API_KEY").unwrap_or_default(),
        search_depth: std::env::var("TAVILY_SEARCH_DEPTH")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "basic".to_string()),
        max_results: 5,
    };

    let state = AppState {
        pool,
        gemini: GeminiClient::new(gemini_config),
        tavily: TavilyClient::new(tavily_config),
        audio_cache_dir,
    };

    tracing::info!(
        web_search_enabled = state.tavily.is_enabled(),
        "Tavily web search status"
    );

    let api_router = Router::new()
        .route("/api/health", get(health))
        .route("/api/devices/register", post(auth::register_device))
        .route("/api/devices/me", get(auth::get_me).patch(auth::update_me))
        .route("/api/devices/bind", post(auth::bind_device))
        .route("/api/trips", get(trips::list_trips))
        .route("/api/trips/import", post(trips::import_trip))
        .route("/api/trips/latest", get(trips::get_latest_trip))
        .route(
            "/api/trips/{trip_id}",
            get(trips::get_trip)
                .put(trips::update_trip)
                .delete(trips::delete_trip),
        )
        .route(
            "/api/trips/{trip_id}/days/{day_number}/chat",
            post(guides::chat_day),
        )
        .route(
            "/api/items/{item_id}/guide",
            get(guides::get_guide).post(guides::generate_guide),
        )
        .route(
            "/api/items/{item_id}/guide/audio",
            post(guides::generate_guide_audio),
        )
        .route("/api/items/{item_id}/chat", post(guides::chat_item))
        .route("/api/audio/{guide_id}", get(guides::serve_audio))
        .route("/api/transcribe/live", get(transcribe::transcribe_live))
        .route("/api/tts", post(guides::generate_chat_tts))
        .route("/api/tts/audio/{audio_hash}", get(guides::serve_chat_audio));

    let mut app = api_router
        .with_state(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let dist_dir = PathBuf::from(
        std::env::var("STATIC_DIR").unwrap_or_else(|_| "../frontend/dist".to_string()),
    );
    if dist_dir.exists() {
        tracing::info!(?dist_dir, "Serving static frontend build");
        let index_file = dist_dir.join("index.html");
        let serve_dir = ServeDir::new(&dist_dir).fallback(ServeFile::new(index_file));
        app = app.fallback_service(serve_dir);
    }

    let addr = SocketAddr::from((host, port));
    tracing::info!("Listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind TCP listener");
    axum::serve(listener, app)
        .await
        .expect("Axum server exited unexpectedly");
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "web_search_enabled": state.tavily.is_enabled()
    }))
}
