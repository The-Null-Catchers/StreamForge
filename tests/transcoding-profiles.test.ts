import test from "node:test";
import assert from "node:assert/strict";
import { profileRenditions } from "../packages/media-core/src/profiles.js";

test("transcoding profiles remain source-aware and never upscale", () => {
  for (const profile of ["data_saver", "balanced", "quality"] as const) {
    const ladder = profileRenditions(1280, 720, profile);
    assert.ok(ladder.length > 0);
    assert.ok(ladder.every((item) => item.height <= 720));
    assert.ok(ladder.every((item) => item.width <= 1280));
  }
});

test("data saver reduces bitrate while quality increases it", () => {
  const saver = profileRenditions(1920, 1080, "data_saver");
  const balanced = profileRenditions(1920, 1080, "balanced");
  const quality = profileRenditions(1920, 1080, "quality");
  const bitrate = (ladder: typeof balanced, height: number) =>
    ladder.find((item) => item.height === height)!.bitrate;

  assert.ok(bitrate(saver, 720) < bitrate(balanced, 720));
  assert.ok(bitrate(quality, 720) > bitrate(balanced, 720));
});

test("data saver caps high resolution sources at 1080p", () => {
  const saver = profileRenditions(3840, 2160, "data_saver");
  const balanced = profileRenditions(3840, 2160, "balanced");
  assert.equal(Math.max(...saver.map((item) => item.height)), 1080);
  assert.equal(Math.max(...balanced.map((item) => item.height)), 2160);
});
