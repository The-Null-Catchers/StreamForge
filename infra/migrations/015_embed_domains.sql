ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS embed_allowed_origins text[] NOT NULL DEFAULT '{}';
