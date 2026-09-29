CREATE TABLE IF NOT EXISTS transcriptions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  language text NOT NULL CHECK(language IN ('auto','ar','en')),
  status text NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','complete','failed')),
  progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  subtitle_id uuid REFERENCES subtitles(id) ON DELETE SET NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcriptions_video_created
  ON transcriptions(video_id,created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS transcriptions_one_active
  ON transcriptions(video_id,language)
  WHERE status IN ('queued','running');
