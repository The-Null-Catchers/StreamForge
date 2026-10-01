ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS live_concurrency_limit integer NOT NULL DEFAULT 3
    CHECK(live_concurrency_limit BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS live_minutes_monthly_limit bigint NOT NULL DEFAULT 10000
    CHECK(live_minutes_monthly_limit >= 0);

CREATE INDEX IF NOT EXISTS usage_records_workspace_live_month
  ON usage_records(workspace_id,created_at)
  WHERE kind='live_seconds';
