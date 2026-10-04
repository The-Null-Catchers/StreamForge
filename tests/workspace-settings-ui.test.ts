import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("workspace settings UI exposes role-gated rename and invite management", async () => {
  const source = await readFile(
    "apps/web/app/workspace-settings/page.tsx",
    "utf8",
  );

  assert.match(source, /workspace\?\.role === "owner"/);
  assert.match(source, /workspace\?\.role === "admin"/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /\/workspaces\/\$\{workspaceId\}\/invites/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /Invitation revoked/);
});

test("workspace settings UI lists recoverable tombstones and restores them", async () => {
  const source = await readFile(
    "apps/web/app/workspace-settings/page.tsx",
    "utf8",
  );

  assert.match(source, /\/workspaces\/deleted/);
  assert.match(source, /\/workspaces\/\$\{id\}\/restore/);
  assert.match(source, /Recently deleted workspaces/);
  assert.match(source, /Restore workspace/);
  assert.match(source, /Revoked API keys and disabled webhooks stay inactive/);
});
