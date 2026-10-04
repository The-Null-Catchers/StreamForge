import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("workspace deletion is owner-only and requires exact-name confirmation", async () => {
  const source = await readFile("apps/api/src/workspace-admin.ts", "utf8");
  assert.match(source, /app\.delete<[\s\S]*?\/api\/v1\/workspaces\/:id/);
  assert.match(source, /access\(req, req\.params\.id, "owner"\)/);
  assert.match(source, /WORKSPACE_CONFIRMATION_MISMATCH/);
  assert.match(source, /body\.confirmation !== workspace\.rows\[0\]\.name/);
});

test("workspace deletion creates a restore window and revokes integrations", async () => {
  const source = await readFile("apps/api/src/workspace-admin.ts", "utf8");
  assert.match(source, /pre_delete_status=status/);
  assert.match(source, /WORKSPACE_RESTORE_GRACE_DAYS/);
  assert.match(source, /restore_until=now\(\)\+\$2\*interval '1 day'/);
  assert.match(source, /UPDATE api_keys SET revoked_at/);
  assert.match(source, /UPDATE webhooks SET enabled=false/);
  assert.match(source, /DELETE FROM workspace_invites/);
  assert.match(source, /workspace\.deletion_requested/);
  assert.doesNotMatch(source, /DELETE FROM workspace_members WHERE workspace_id=\$1/);
});

test("owner can restore a workspace only inside the grace window", async () => {
  const source = await readFile("apps/api/src/workspace-admin.ts", "utf8");
  assert.match(source, /\/api\/v1\/workspaces\/:id\/restore/);
  assert.match(source, /WORKSPACE_RESTORE_WINDOW_EXPIRED/);
  assert.match(source, /membership\.rows\[0\]\.role !== "owner"/);
  assert.match(source, /status=coalesce\(pre_delete_status,'draft'\)/);
  assert.match(source, /workspace\.restored/);
});

test("deleted workspace access is blocked", async () => {
  const source = await readFile("apps/api/src/context.ts", "utf8");
  assert.match(source, /SELECT deleted_at FROM workspaces WHERE id=\$1/);
  assert.match(source, /workspaceState\.rows\[0\]\.deleted_at/);
  assert.match(source, /WORKSPACE_NOT_FOUND/);
});

test("workspace settings requires name confirmation before delete", async () => {
  const source = await readFile("apps/web/app/workspace-settings/page.tsx", "utf8");
  assert.match(source, /Danger zone/);
  assert.match(source, /deleteConfirmation !== workspace\.name/);
  assert.match(source, /method: "DELETE"/);
});
