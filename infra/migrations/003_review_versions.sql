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

INSERT INTO video_versions(
  video_id,version_number,label,source_video_id,source_key,output_prefix,filename,
  checksum,size,metadata,renditions,created_by,created_at
)
SELECT
  v.id,1,'Initial version',v.id,v.source_key,v.output_prefix,v.filename,
  v.checksum,v.size,v.metadata,v.renditions,'migration',v.created_at
FROM videos v
WHERE v.deleted_at IS NULL
ON CONFLICT(video_id,version_number) DO NOTHING;

UPDATE videos v
SET active_version_id=vv.id
FROM video_versions vv
WHERE vv.video_id=v.id
  AND vv.version_number=1
  AND v.active_version_id IS NULL;
