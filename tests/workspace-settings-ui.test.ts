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
