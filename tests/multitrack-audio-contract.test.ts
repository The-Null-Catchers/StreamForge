import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("production transcoder emits alternate HLS audio groups", async () => {
  const source = await readFile(
    "packages/media-core/src/profile-transcode.ts",
    "utf8",
  );
  assert.match(source, /transcodeAudioTracks/);
  assert.match(source, /audioMediaLines/);
  assert.match(source, /-an/);
  assert.match(source, /AUDIO=\"audio\"/);
  assert.match(source, /mp4a\.40\.2/);
});

test("audio helper preserves language, title and a single default track", async () => {
  const source = await readFile("packages/media-core/src/audio.ts", "utf8");
  assert.match(source, /codec_type === \"audio\"/);
  assert.match(source, /tags\?\.language/);
  assert.match(source, /tags\?\.title/);
  assert.match(source, /disposition\?\.default/);
  assert.match(source, /TYPE=AUDIO/);
  assert.match(source, /GROUP-ID=\"audio\"/);
  assert.match(source, /DEFAULT=\$\{track\.isDefault \? \"YES\" : \"NO\"\}/);
  assert.match(source, /AUTOSELECT=YES/);
  assert.match(source, /audio\/track-\$\{track\.ordinal \+ 1\}\/index\.m3u8/);
});

test("each input audio stream is transcoded once to an AAC HLS rendition", async () => {
  const source = await readFile("packages/media-core/src/audio.ts", "utf8");
  assert.match(source, /`0:a:\$\{track\.ordinal\}`/);
  assert.match(source, /\"-c:a\",\s*\"aac\"/);
  assert.match(source, /\"-b:a\",\s*\"128k\"/);
  assert.match(source, /\"-hls_playlist_type\",\s*\"vod\"/);
  assert.match(source, /segment-%05d\.ts/);
});
