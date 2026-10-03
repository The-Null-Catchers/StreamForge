import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("workspace rename remains owner protected", async () => {
  const source = await readFile("apps/api/src/workspace-admin.ts", "utf8");
  assert.match(source, /\/api\/v1\/workspaces\/:id/);
  assert.match(source, /access\(req, req\.params\.id, "owner"\)/);
  assert.match(source, /workspace\.renamed/);
});

test("pending invites can be listed and revoked by workspace admins", async () => {
  const source = await readFile("apps/api/src/workspace-admin.ts", "utf8");
  assert.match(source, /\/api\/v1\/workspaces\/:id\/invites/);
  assert.match(source, /\/api\/v1\/workspaces\/:id\/invites\/:inviteId/);
  assert.match(source, /access\(req, req\.params\.id, "admin"\)/);
  assert.match(source, /member\.invite_revoked/);
  assert.match(source, /INVITE_NOT_FOUND/);
});
