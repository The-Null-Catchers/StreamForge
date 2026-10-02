ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS upload_bytes_monthly_limit bigint NOT NULL DEFAULT 536870912000
    CHECK(upload_bytes_monthly_limit >= 0);

CREATE INDEX IF NOT EXISTS uploads_workspace_month
  ON uploads(workspace_id,created_at);
