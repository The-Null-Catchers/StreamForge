import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("playback API signs CMAF playlists, init segments, fragments and audio renditions", async () => {
  const source = await readFile("apps/api/src/playback.ts", "utf8");

  assert.match(source, /cmafUrl: base \+ "hls\/cmaf\/master\.m3u8"/);
  assert.match(source, /audio\\\/track-\\d\+/);
  assert.match(source, /init\\\.mp4/);
  assert.match(source, /segment-\\d\+\\\.m4s/);
  assert.match(source, /URI="\(\[\^"\]\+\\\.\(\?:m3u8\|mp4\|m4s\|ts\|jpg\)\)"/);
  assert.match(source, /video\/iso\.segment/);
  assert.match(source, /"audio_track_change"/);
});

test("HLS.js prefers signed CMAF while native HLS keeps the compatibility playlist", async () => {
  const source = await readFile("apps/web/components/Player.tsx", "utf8");

  assert.match(source, /cmafUrl: string/);
  assert.match(source, /hls\.loadSource\(data\.cmafUrl \|\| data\.url\)/);
  assert.match(source, /video\.src = data\.url/);
});
