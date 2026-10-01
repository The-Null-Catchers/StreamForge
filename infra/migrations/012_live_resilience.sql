ALTER TABLE live_streams
  ADD COLUMN IF NOT EXISTS backup_stream_key_hash text UNIQUE,
  ADD COLUMN IF NOT EXISTS active_ingest text
    CHECK(active_ingest IS NULL OR active_ingest IN ('primary','backup')),
  ADD COLUMN IF NOT EXISTS dvr_window_seconds integer NOT NULL DEFAULT 600
    CHECK(dvr_window_seconds BETWEEN 30 AND 21600),
  ADD COLUMN IF NOT EXISTS live_profile text NOT NULL DEFAULT 'standard'
    CHECK(live_profile IN ('source','standard','high'));

CREATE INDEX IF NOT EXISTS live_streams_active_ingest
  ON live_streams(active_ingest)
  WHERE active_ingest IS NOT NULL;
