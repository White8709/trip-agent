ALTER TABLE trips ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE trips SET updated_at = created_at WHERE updated_at = '';
CREATE INDEX IF NOT EXISTS idx_trips_device_updated ON trips(device_id, updated_at DESC);
