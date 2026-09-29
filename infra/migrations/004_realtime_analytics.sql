ALTER TABLE playback_sessions
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS playback_sessions_video_last_seen
  ON playback_sessions(video_id,last_seen_at DESC);

ALTER TABLE analytics_events
  ADD COLUMN IF NOT EXISTS quality text,
  ADD COLUMN IF NOT EXISTS startup_ms integer CHECK(startup_ms IS NULL OR startup_ms >= 0);

CREATE INDEX IF NOT EXISTS analytics_video_event_date
  ON analytics_events(video_id,event,created_at DESC);
