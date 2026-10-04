ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS cleanup_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cleanup_completed_at timestamptz;

CREATE INDEX IF NOT EXISTS workspaces_cleanup_pending
  ON workspaces(deleted_at)
  WHERE cleanup_pending = true;
