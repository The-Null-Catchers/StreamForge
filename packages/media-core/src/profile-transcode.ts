import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run, type Metadata } from "./index.js";
import { audioMediaLines, transcodeAudioTracks } from "./audio.js";
import { packageCmafFromHls } from "./cmaf.js";
import {
  profileRenditions,
  type TranscodingProfile,
} from "./profiles.js";

export async function transcodeWithProfile(
  source: string,
  output: string,
  metadata: Metadata,
  profile: TranscodingProfile,
  onProgress?: (name: string, pct: number) => void,
) {
  const variants = profileRenditions(metadata.width, metadata.height, profile);
  for (const variant of variants) {
    const dir = join(output, variant.name);
    await mkdir(dir, { recursive: true });
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,matroska,webm",
        "-i",
        source,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `scale=${variant.width}:${variant.height},setsar=1`,
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "veryfast",
        "-threads",
        "2",
        "-b:v",
        String(variant.bitrate),
        "-maxrate",
        String(Math.round(variant.bitrate * 1.1)),
        "-bufsize",
        String(variant.bitrate * 2),
        "-sc_threshold",
        "0",
        "-force_key_frames",
        "expr:gte(t,n_forced*4)",
        "-f",
        "hls",
        "-hls_time",
        "4",
        "-hls_playlist_type",
        "vod",
        "-hls_flags",
        "independent_segments",
        "-hls_segment_filename",
        join(dir, "segment-%05d.ts"),
        "-progress",
        "pipe:1",
        join(dir, "index.m3u8"),
      ],
      7200000,
      (seconds) =>
        onProgress?.(
          variant.name,
          Math.min(99, Math.round((seconds / metadata.duration) * 100)),
        ),
    );
    onProgress?.(variant.name, 100);
  }

  const audioTracks = metadata.hasAudio
    ? await transcodeAudioTracks(source, output, metadata)
    : [];
  const master = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    ...audioMediaLines(audioTracks),
  ];
  for (const variant of variants) {
    const lines = (
      await readFile(join(output, variant.name, "index.m3u8"), "utf8")
    ).split("\n");
    let duration = 0;
    let totalDuration = 0;
    let totalBytes = 0;
    let peak = 0;
    for (const line of lines) {
      if (line.startsWith("#EXTINF:"))
        duration = Number(line.slice(8).split(",")[0]);
      else if (line.endsWith(".ts")) {
        const bytes = (await stat(join(output, variant.name, line))).size;
        totalBytes += bytes;
        totalDuration += duration;
        peak = Math.max(peak, (bytes * 8) / duration);
      }
    }
    const technical = JSON.parse(
      await run(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_streams",
          "-of",
          "json",
          join(output, variant.name, "segment-00000.ts"),
        ],
        30000,
      ),
    );
    const stream = technical.streams.find(
      (item: { codec_type: string }) => item.codec_type === "video",
    );
    const codec = `avc1.6400${Number(stream.level).toString(16).padStart(2, "0")}`;
    const audioAttributes = audioTracks.length ? ',AUDIO="audio"' : "";
    master.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.ceil(peak)},AVERAGE-BANDWIDTH=${Math.ceil((totalBytes * 8) / totalDuration)},RESOLUTION=${variant.width}x${variant.height},CODECS="${codec}${audioTracks.length ? ",mp4a.40.2" : ""}"${audioAttributes}`,
      `${variant.name}/index.m3u8`,
    );
  }
  await writeFile(join(output, "master.m3u8"), master.join("\n") + "\n");
  await packageCmafFromHls(output, variants, audioTracks);
  return variants;
}
