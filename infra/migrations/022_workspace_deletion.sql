ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS workspaces_active
  ON workspaces(id)
  WHERE deleted_at IS NULL;
