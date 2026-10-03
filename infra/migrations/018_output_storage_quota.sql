ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS output_storage_limit bigint NOT NULL DEFAULT 536870912000
    CHECK(output_storage_limit >= 0);

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS output_bytes bigint NOT NULL DEFAULT 0
    CHECK(output_bytes >= 0);

CREATE INDEX IF NOT EXISTS videos_workspace_output_bytes
  ON videos(workspace_id)
  WHERE deleted_at IS NULL AND output_bytes > 0;
