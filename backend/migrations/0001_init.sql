CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    device_token TEXT UNIQUE NOT NULL,
    binding_code TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    share_url TEXT,
    raw_text TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_days (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    day_number INTEGER NOT NULL,
    date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day_id INTEGER NOT NULL REFERENCES trip_days(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    name TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trip_days_order ON trip_days(trip_id, day_number ASC);
CREATE INDEX IF NOT EXISTS idx_trip_items_order ON trip_items(day_id, sequence ASC);

CREATE TABLE IF NOT EXISTS ai_guides (
    id TEXT PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES trip_items(id) ON DELETE CASCADE,
    style TEXT NOT NULL,
    story TEXT NOT NULL,
    highlights_json TEXT NOT NULL,
    tips_json TEXT NOT NULL,
    narration_script TEXT NOT NULL,
    audio_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(item_id, style)
);
