CREATE TABLE IF NOT EXISTS quota_notices(
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  quota_key text NOT NULL,
  period_key text NOT NULL,
  threshold integer NOT NULL CHECK(threshold IN (80,90,100)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,quota_key,period_key,threshold)
);

CREATE INDEX IF NOT EXISTS quota_notices_created
  ON quota_notices(created_at DESC);
