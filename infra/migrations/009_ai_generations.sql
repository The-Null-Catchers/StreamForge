CREATE TABLE IF NOT EXISTS ai_generations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK(kind IN ('summary','metadata','chapters','all')),
  language text NOT NULL DEFAULT 'auto' CHECK(language IN ('auto','ar','en')),
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','complete','failed')),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_generations_video_created
  ON ai_generations(video_id,created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ai_generations_one_active
  ON ai_generations(video_id,kind,language)
  WHERE status IN ('queued','running');
