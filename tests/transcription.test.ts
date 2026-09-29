import { test } from "node:test";
import assert from "node:assert/strict";
import { transcriptionVtt } from "../packages/transcription/src/index.js";
import { subtitleSegments } from "../packages/media-core/src/index.js";

test("transcription segments become searchable WebVTT cues", () => {
  const vtt = transcriptionVtt([
    { start: 0, end: 1.25, text: "مرحبا بالعالم" },
    { start: 2.5, end: 4, text: "StreamForge transcript" },
  ]);
  assert.match(vtt, /^WEBVTT/);
  const parsed = subtitleSegments(vtt);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.text, "مرحبا بالعالم");
  assert.equal(parsed[0]?.startSeconds, 0);
  assert.equal(parsed[1]?.endSeconds, 4);
});

test("transcription VTT normalizes whitespace and zero-length cues", () => {
  const vtt = transcriptionVtt([
    { start: 3, end: 3, text: "  hello    world  " },
  ]);
  assert.match(vtt, /00:00:03\.000 --> 00:00:03\.001/);
  assert.match(vtt, /hello world/);
});
