ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS transcoding_profile text NOT NULL DEFAULT 'balanced'
    CHECK(transcoding_profile IN ('data_saver','balanced','quality'));

CREATE INDEX IF NOT EXISTS videos_transcoding_profile
  ON videos(workspace_id,transcoding_profile)
  WHERE deleted_at IS NULL;
