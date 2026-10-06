import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run, type Rendition } from "./index.js";
import type { AudioTrack } from "./audio.js";

async function packagePlaylist(
  input: string,
  outputDir: string,
  stream: "video" | "audio",
) {
  await mkdir(outputDir, { recursive: true });
  const copyFilters =
    stream === "audio" ? ["-bsf:a", "aac_adtstoasc"] : [];
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-protocol_whitelist",
      "file,crypto,data,tcp,http,https,tls",
      "-allowed_extensions",
      "ALL",
      "-i",
      input,
      "-map",
      stream === "video" ? "0:v:0" : "0:a:0",
      stream === "video" ? "-an" : "-vn",
      "-c",
      "copy",
      ...copyFilters,
      "-f",
      "hls",
      "-hls_time",
      "4",
      "-hls_playlist_type",
      "vod",
      "-hls_flags",
      "independent_segments",
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
      "init.mp4",
      "-hls_segment_filename",
      join(outputDir, "segment-%05d.m4s"),
      join(outputDir, "index.m3u8"),
    ],
    7200000,
  );
}

export async function packageCmafFromHls(
  output: string,
  variants: Rendition[],
  audioTracks: AudioTrack[],
) {
  const root = join(output, "cmaf");
  await mkdir(root, { recursive: true });

  for (const variant of variants)
    await packagePlaylist(
      join(output, variant.name, "index.m3u8"),
      join(root, variant.name),
      "video",
    );

  for (const track of audioTracks)
    await packagePlaylist(
      join(output, "audio", `track-${track.ordinal + 1}`, "index.m3u8"),
      join(root, "audio", `track-${track.ordinal + 1}`),
      "audio",
    );

  const master = await readFile(join(output, "master.m3u8"), "utf8");
  await writeFile(
    join(root, "master.m3u8"),
    master.replace(/#EXT-X-VERSION:\d+/, "#EXT-X-VERSION:7"),
  );

  await validateCmaf(root, variants, audioTracks);
  return { root, variants: variants.length, audioTracks: audioTracks.length };
}

export async function validateCmaf(
  root: string,
  variants: Rendition[],
  audioTracks: AudioTrack[],
) {
  const master = await readFile(join(root, "master.m3u8"), "utf8");
  if (!master.includes("#EXT-X-VERSION:7")) throw Error("INVALID_CMAF_MASTER");

  const playlists = [
    ...variants.map((variant) => join(root, variant.name, "index.m3u8")),
    ...audioTracks.map((track) =>
      join(root, "audio", `track-${track.ordinal + 1}`, "index.m3u8"),
    ),
  ];

  for (const playlistPath of playlists) {
    const playlist = await readFile(playlistPath, "utf8");
    if (!playlist.includes('#EXT-X-MAP:URI="init.mp4"'))
      throw Error("CMAF_INIT_MISSING");
    if (!playlist.includes("#EXT-X-ENDLIST")) throw Error("INCOMPLETE_CMAF");
    const segments = playlist
      .split("\n")
      .filter((line) => /^segment-\d+\.m4s$/.test(line));
    if (!segments.length) throw Error("EMPTY_CMAF");
    await readFile(join(playlistPath, "..", "init.mp4"));
    for (const segment of segments)
      await readFile(join(playlistPath, "..", segment));
  }
}
