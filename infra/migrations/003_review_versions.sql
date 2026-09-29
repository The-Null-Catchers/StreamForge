CREATE TABLE video_versions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id),
  version_number integer NOT NULL,
  label text NOT NULL DEFAULT '',
  source_video_id uuid REFERENCES videos(id),
  source_key text,
  output_prefix text,
  filename text,
  checksum text,
  size bigint NOT NULL DEFAULT 0,
  metadata jsonb,
  renditions jsonb NOT NULL DEFAULT '[]',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(video_id, version_number)
);

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS active_version_id uuid REFERENCES video_versions(id),
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'pending'
    CHECK(review_status IN ('pending','approved','changes_requested'));

CREATE TABLE review_comments(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id),
  version_id uuid REFERENCES video_versions(id),
  parent_id uuid REFERENCES review_comments(id),
  author_id uuid NOT NULL REFERENCES users(id),
  timestamp_seconds double precision CHECK(timestamp_seconds IS NULL OR timestamp_seconds >= 0),
  body text NOT NULL,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX video_versions_video_number
  ON video_versions(video_id, version_number DESC);

CREATE INDEX review_comments_video_created
  ON review_comments(video_id, created_at, id);

CREATE INDEX review_comments_version_created
  ON review_comments(version_id, created_at, id);
