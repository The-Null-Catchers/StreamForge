import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  run,
  probe,
  transcode,
  thumbnails,
  validateHls,
} from "../packages/media-core/src/index.js";
test(
  "real FFmpeg produces playable ABR HLS, poster and thumbnail index",
  { timeout: 180000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "sf-test-"));
    try {
      const source = join(dir, "source.mp4");
      await run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=24",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        source,
      ]);
      const metadata = await probe(source);
      assert.equal(metadata.height, 720);
      assert.equal(metadata.hasAudio, true);
      const out = join(dir, "hls");
      await mkdir(out);
      const variants = await transcode(source, out, metadata);
      assert.equal(variants.length, 3);
      await validateHls(out, variants);
      for (const v of variants) {
        await run(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            join(out, v.name, "index.m3u8"),
            "-f",
            "null",
            "-",
          ],
          30000,
        );
      }
      await thumbnails(source, join(dir, "thumbs"), metadata.duration);
      assert.ok((await stat(join(dir, "thumbs", "poster.jpg"))).size > 100);
      assert.match(
        await readFile(join(dir, "thumbs", "previews.vtt"), "utf8"),
        /^WEBVTT/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "silent small source keeps a single non-upscaled rendition",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "sf-silent-"));
    try {
      const source = join(dir, "source.mp4");
      await run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=240x160:r=24",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        source,
      ]);
      const m = await probe(source);
      assert.equal(m.hasAudio, false);
      const out = join(dir, "hls");
      await mkdir(out);
      const variants = await transcode(source, out, m);
      assert.equal(variants.length, 1);
      assert.equal(variants[0].height, 160);
      await validateHls(out, variants);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
