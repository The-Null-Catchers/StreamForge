CREATE TABLE IF NOT EXISTS analytics_daily(
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  day date NOT NULL,
  plays bigint NOT NULL DEFAULT 0,
  unique_viewers bigint NOT NULL DEFAULT 0,
  watch_seconds double precision NOT NULL DEFAULT 0,
  completions bigint NOT NULL DEFAULT 0,
  errors bigint NOT NULL DEFAULT 0,
  buffer_starts bigint NOT NULL DEFAULT 0,
  buffer_seconds double precision NOT NULL DEFAULT 0,
  avg_startup_ms double precision,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(video_id,day)
);

CREATE INDEX IF NOT EXISTS analytics_events_session_date
  ON analytics_events(session_id,created_at);

CREATE INDEX IF NOT EXISTS analytics_daily_day
  ON analytics_daily(day DESC,video_id);
