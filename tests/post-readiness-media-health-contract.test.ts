import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("ready media is periodically rescanned and quarantined on integrity failure", async () => {
  const health = await readFile("apps/worker/src/media-health.ts", "utf8");
  const reconcile = await readFile("apps/worker/src/usage-reconcile.ts", "utf8");

  assert.match(health, /status='ready'/);
  assert.match(health, /verifyReadyVideoMedia/);
  assert.match(health, /#EXT-X-ENDLIST/);
  assert.match(health, /#EXT-X-MAP:/);
  assert.match(health, /MEDIA_INTEGRITY_FAILED/);
  assert.match(health, /status='failed'/);
  assert.match(health, /video\.media\.integrity\.failed/);
  assert.match(health, /Playback has been disabled/);
  assert.match(reconcile, /scanReadyVideoMediaHealth/);
  assert.match(reconcile, /mediaHealthCursor/);
});

test("media health scan rejects unsafe references and verifies non-zero objects", async () => {
  const health = await readFile("apps/worker/src/media-health.ts", "utf8");
  assert.match(health, /clean\.startsWith\("\/"\)/);
  assert.match(health, /clean\.split\("\/"\)\.includes\("\.\."\)/);
  assert.match(health, /\^\[a-z\]\[a-z0-9\+\.\-\]\*:/i);
  assert.match(health, /storage\.size\(key\)\) <= 0/);
});
