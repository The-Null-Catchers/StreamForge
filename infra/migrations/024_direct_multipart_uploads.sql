ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS upload_mode text NOT NULL DEFAULT 'proxy'
    CHECK(upload_mode IN ('proxy','direct')),
  ADD COLUMN IF NOT EXISTS multipart_upload_id text,
  ADD COLUMN IF NOT EXISTS object_key text;

CREATE INDEX IF NOT EXISTS uploads_direct_open
  ON uploads(workspace_id,created_at)
  WHERE upload_mode='direct' AND status='uploading';
