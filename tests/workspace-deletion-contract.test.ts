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

test("workspace deletion revokes integrations and uses durable media cleanup", async () => {
  const source = await readFile("apps/api/src/workspace-admin.ts", "utf8");
  assert.match(source, /UPDATE api_keys SET revoked_at/);
  assert.match(source, /UPDATE webhooks SET enabled=false/);
  assert.match(source, /DELETE FROM workspace_invites/);
  assert.match(source, /enqueue\(c, "cleanup", \{ videoId: video\.id \}\)/);
  assert.match(source, /DELETE FROM workspace_members/);
  assert.match(source, /workspace\.deletion_requested/);
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
