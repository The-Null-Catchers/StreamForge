import { test } from "node:test";
import assert from "node:assert/strict";
import { profiles, subtitleVtt, subtitleSegments } from "../packages/media-core/src/index.js";
import {
  publicAddress,
  can,
  hash,
  signature,
  validSignature,
  expectedPartSize,
} from "../packages/shared/src/security.js";
test("role hierarchy denies privilege escalation", () => {
  assert.equal(can("viewer", "editor"), false);
  assert.equal(can("editor", "admin"), false);
  assert.equal(can("owner", "admin"), true);
});
test("renditions never upscale either dimension, including portrait and small sources", () => {
  for (const [w, h] of [
    [1280, 720],
    [1920, 1080],
    [240, 320],
    [720, 1280],
    [4096, 2160],
    [5, 7],
  ])
    for (const r of profiles(w, h)) {
      assert.ok(r.width <= w);
      assert.ok(r.height <= h);
      assert.equal(r.width % 2, 0);
      assert.equal(r.height % 2, 0);
    }
  assert.deepEqual(
    profiles(1280, 720).map((x) => x.height),
    [360, 480, 720],
  );
});
test("chunk boundaries reject missing and excess parts", () => {
  assert.equal(expectedPartSize(20, 8, 0), 8);
  assert.equal(expectedPartSize(20, 8, 2), 4);
  assert.throws(() => expectedPartSize(20, 8, 3));
  assert.throws(() => expectedPartSize(20, 8, -1));
  assert.throws(() => expectedPartSize(20, 8, 0.5));
});
test("SHA256 integrity and webhook replay window", () => {
  assert.equal(
    hash("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const ts = "1700000000",
    body = '{"event":"video.ready"}',
    sig = signature("secret", ts, body);
  assert.ok(validSignature("secret", ts, body, sig, 1700000000000));
  assert.equal(
    validSignature("secret", ts, body + "x", sig, 1700000000000),
    false,
  );
  assert.equal(validSignature("secret", ts, body, sig, 1700000600000), false);
  assert.equal(validSignature("secret", ts, body, "x", 1700000000000), false);
});
test("SRT conversion preserves Arabic and converts timestamp syntax", () => {
  const vtt = subtitleVtt(
    "1\r\n00:00:01,000 --> 00:00:03,000\r\nمرحبا بالعالم\r\n",
  );
  assert.ok(vtt.startsWith("WEBVTT"));
  assert.ok(vtt.includes("00:00:01.000"));
  assert.ok(vtt.includes("مرحبا"));
  assert.throws(() => subtitleVtt("not subtitles"));
});

test("subtitle cues become searchable timestamped transcript segments", () => {
  const segments = subtitleSegments(
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<v Speaker>مرحبا بالعالم</v>\n\n00:04.000 --> 00:05.250\nBuild &amp; ship",
  );
  assert.deepEqual(segments, [
    { startSeconds: 1, endSeconds: 3.5, text: "مرحبا بالعالم" },
    { startSeconds: 4, endSeconds: 5.25, text: "Build & ship" },
  ]);
});

test("webhook address policy excludes loopback, private, mapped private and link-local IPs", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "0.0.0.0",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("93.184.216.34"), true);
});
