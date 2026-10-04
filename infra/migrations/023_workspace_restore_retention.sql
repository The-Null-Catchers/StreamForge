ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS restore_until timestamptz,
  ADD COLUMN IF NOT EXISTS purged_at timestamptz;

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS pre_delete_status text;

CREATE INDEX IF NOT EXISTS workspaces_restore_due
  ON workspaces(restore_until)
  WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
