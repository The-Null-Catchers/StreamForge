ALTER TABLE live_streams
  ADD COLUMN IF NOT EXISTS auto_create_vod boolean NOT NULL DEFAULT true;

ALTER TABLE live_sessions
  ADD COLUMN IF NOT EXISTS promotion_status text NOT NULL DEFAULT 'pending'
    CHECK(promotion_status IN ('pending','queued','running','complete','failed','skipped')),
  ADD COLUMN IF NOT EXISTS recording_video_id uuid REFERENCES videos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS promotion_error text,
  ADD COLUMN IF NOT EXISTS promoted_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS live_sessions_recording_video
  ON live_sessions(recording_video_id)
  WHERE recording_video_id IS NOT NULL;
