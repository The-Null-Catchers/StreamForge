ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS processing_seconds_monthly_limit bigint NOT NULL DEFAULT 1000000
    CHECK(processing_seconds_monthly_limit >= 0);

CREATE INDEX IF NOT EXISTS usage_records_workspace_processing_month
  ON usage_records(workspace_id,created_at)
  WHERE kind='processing_seconds';
