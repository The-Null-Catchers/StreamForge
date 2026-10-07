import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("worker uploads CMAF initialization and media fragments with media MIME types", async () => {
  const source = await readFile("apps/worker/src/pipeline.ts", "utf8");

  assert.match(source, /name\.endsWith\("\.mp4"\)/);
  assert.match(source, /"audio\/mp4"/);
  assert.match(source, /"video\/mp4"/);
  assert.match(source, /name\.endsWith\("\.m4s"\)/);
  assert.match(source, /"audio\/iso\.segment"/);
  assert.match(source, /"video\/iso\.segment"/);
});

test("video readiness requires CMAF master, init segments and first media fragments", async () => {
  const source = await readFile("apps/worker/src/pipeline.ts", "utf8");

  assert.match(source, /"hls\/cmaf\/master\.m3u8"/);
  assert.match(source, /`hls\/cmaf\/\$\{r\.name\}\/init\.mp4`/);
  assert.match(source, /`hls\/cmaf\/\$\{r\.name\}\/segment-00000\.m4s`/);
  assert.match(source, /sourceAudioTrackCount\(v\.metadata\)/);
  assert.match(source, /`hls\/cmaf\/audio\/track-\$\{ordinal\}\/init\.mp4`/);
  assert.match(source, /`hls\/cmaf\/audio\/track-\$\{ordinal\}\/segment-00000\.m4s`/);
  assert.match(source, /throw Error\("OUTPUT_MISSING"\)/);
});
