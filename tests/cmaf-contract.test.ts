import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("production transcoder packages HLS renditions as CMAF fMP4", async () => {
  const transcoder = await readFile(
    "packages/media-core/src/profile-transcode.ts",
    "utf8",
  );
  const cmaf = await readFile("packages/media-core/src/cmaf.ts", "utf8");

  assert.match(transcoder, /packageCmafFromHls\(output, variants, audioTracks\)/);
  assert.match(cmaf, /-hls_segment_type/);
  assert.match(cmaf, /fmp4/);
  assert.match(cmaf, /-hls_fmp4_init_filename/);
  assert.match(cmaf, /init\.mp4/);
  assert.match(cmaf, /segment-%05d\.m4s/);
  assert.match(cmaf, /#EXT-X-VERSION:7/);
  assert.match(cmaf, /#EXT-X-MAP:URI=/);
});
