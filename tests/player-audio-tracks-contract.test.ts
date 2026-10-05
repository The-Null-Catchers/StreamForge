import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("web player exposes HLS alternate audio tracks and switches them", async () => {
  const source = await readFile("apps/web/components/Player.tsx", "utf8");
  assert.match(source, /Hls\.Events\.AUDIO_TRACKS_UPDATED/);
  assert.match(source, /Hls\.Events\.AUDIO_TRACK_SWITCHED/);
  assert.match(source, /hls\.audioTracks\.map/);
  assert.match(source, /engine\.current\.audioTrack = value/);
  assert.match(source, /aria-label="Audio track"/);
  assert.match(source, /audio_track_change/);
  assert.match(source, /audioLanguage/);
});
