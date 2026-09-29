ALTER TABLE playback_sessions
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS current_quality text,
  ADD COLUMN IF NOT EXISTS device_type text,
  ADD COLUMN IF NOT EXISTS browser text,
  ADD COLUMN IF NOT EXISTS os text;

ALTER TABLE analytics_events
  ADD COLUMN IF NOT EXISTS quality text,
  ADD COLUMN IF NOT EXISTS duration_ms integer CHECK(duration_ms IS NULL OR duration_ms BETWEEN 0 AND 300000);

CREATE INDEX IF NOT EXISTS playback_sessions_video_active
  ON playback_sessions(video_id,last_seen_at DESC)
  WHERE last_seen_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS analytics_events_video_event_created
  ON analytics_events(video_id,event,created_at DESC);
