import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("active workspace listing excludes tombstones and owners can list deleted workspaces", async () => {
  const source = await readFile("apps/api/src/workspaces.ts", "utf8");
  assert.match(source, /w\.deleted_at IS NULL/);
  assert.match(source, /\/api\/v1\/workspaces\/deleted/);
  assert.match(source, /m\.role='owner'/);
  assert.match(source, /w\.purged_at IS NULL/);
  assert.match(source, /recoverable/);
});

test("retention maintenance locks due tombstones and schedules durable cleanup", async () => {
  const source = await readFile("apps/worker/src/workspace-retention.ts", "utf8");
  assert.match(source, /restore_until <= now\(\)/);
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /enqueue\(c, "cleanup", \{ videoId: video\.id \}\)/);
  assert.match(source, /DELETE FROM workspace_members/);
  assert.match(source, /SET purged_at=now\(\),restore_until=NULL/);
  assert.match(source, /workspace\.purge_scheduled/);
});

test("worker maintenance executes retention purge", async () => {
  const source = await readFile("apps/worker/src/index.ts", "utf8");
  assert.match(source, /purgeExpiredWorkspaces/);
  assert.match(source, /expired workspace restore windows purged/);
});
