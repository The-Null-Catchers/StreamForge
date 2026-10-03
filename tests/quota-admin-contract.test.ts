import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("quota administration route remains owner protected", async () => {
  const source = await readFile("apps/api/src/workspaces.ts", "utf8");
  assert.match(source, /\/api\/v1\/workspaces\/:id\/quotas/);
  assert.match(source, /access\(req, req\.params\.id, "owner"\)/);
  assert.match(source, /workspace\.quotas_updated/);
});
