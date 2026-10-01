ALTER TABLE playback_sessions
  ADD COLUMN IF NOT EXISTS renewable_until timestamptz;

UPDATE playback_sessions
SET renewable_until = greatest(expires_at, created_at + interval '24 hours')
WHERE renewable_until IS NULL;

ALTER TABLE playback_sessions
  ALTER COLUMN renewable_until SET NOT NULL;

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS embed_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS embed_allowed_origins text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS playback_sessions_renewable_until
  ON playback_sessions(renewable_until);

CREATE INDEX IF NOT EXISTS videos_embed_enabled
  ON videos(embed_enabled)
  WHERE deleted_at IS NULL;
