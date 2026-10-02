import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStaleTempDirs } from "../apps/worker/src/temp-janitor.js";

test("stale temp janitor removes only old StreamForge directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "streamforge-janitor-test-"));
  try {
    const stale = join(root, "streamforge-stale");
    const fresh = join(root, "streamforge-fresh");
    const unrelated = join(root, "other-stale");
    await Promise.all([mkdir(stale), mkdir(fresh), mkdir(unrelated)]);

    const now = Date.now();
    const oldSeconds = (now - 8 * 60 * 60 * 1000) / 1000;
    await utimes(stale, oldSeconds, oldSeconds);
    await utimes(unrelated, oldSeconds, oldSeconds);

    const removed = await cleanupStaleTempDirs(
      root,
      6 * 60 * 60 * 1000,
      now,
    );

    assert.equal(removed, 1);
    await assert.rejects(stat(stale));
    assert.ok((await stat(fresh)).isDirectory());
    assert.ok((await stat(unrelated)).isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
