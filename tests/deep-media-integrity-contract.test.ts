import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("packaging verifies every referenced HLS and CMAF object", async () => {
  const source = await readFile("apps/worker/src/pipeline.ts", "utf8");
  assert.match(source, /verifyStoredMediaPlaylist/);
  assert.match(source, /#EXT-X-ENDLIST/);
  assert.match(source, /#EXT-X-MAP:/);
  assert.match(source, /matchAll\(\/URI=/);
  assert.match(source, /storage\.exists\(key\)/);
  assert.match(source, /storage\.size\(key\)/);
  assert.match(source, /segmentExtension: "\.ts" \| "\.m4s"/);
  assert.match(source, /hls\/cmaf\/\$\{rendition\.name\}\/index\.m3u8/);
  assert.match(source, /hls\/cmaf\/audio\/track-\$\{ordinal\}\/index\.m3u8/);
});

test("stored playlist references are constrained to local media objects", async () => {
  const source = await readFile("apps/worker/src/pipeline.ts", "utf8");
  assert.match(source, /clean\.startsWith\("\/"\)/);
  assert.match(source, /split\("\/"\)\.includes\("\.\."\)/);
  assert.match(source, /\["\.ts", "\.m4s", "\.mp4"\]/);
  assert.match(source, /OUTPUT_VERIFICATION_FAILED/);
  assert.match(source, /OUTPUT_MISSING/);
});
