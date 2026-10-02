CREATE UNIQUE INDEX workspace_single_owner
  ON workspace_members(workspace_id)
  WHERE role='owner';
