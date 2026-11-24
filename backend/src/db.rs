use std::{path::PathBuf, str::FromStr};

use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    SqlitePool,
};

use crate::{gemini::GeminiClient, tavily::TavilyClient};

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub gemini: GeminiClient,
    pub tavily: TavilyClient,
    pub audio_cache_dir: PathBuf,
}

pub async fn init_pool(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    #[tokio::test]
    async fn migrations_add_sources_json_column_to_ai_guides() {
        let pool = init_pool("sqlite::memory:")
            .await
            .expect("in-memory sqlite migrations should succeed");

        let columns = sqlx::query("PRAGMA table_info(ai_guides)")
            .fetch_all(&pool)
            .await
            .expect("PRAGMA table_info should succeed");

        let has_sources_json = columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "sources_json");
        assert!(has_sources_json, "ai_guides should contain sources_json column");
    }
}
