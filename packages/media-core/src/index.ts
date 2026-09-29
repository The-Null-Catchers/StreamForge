import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
export type Rendition = {
  height: number;
  width: number;
  bitrate: number;
  name: string;
};
export type Metadata = {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  codec: string;
  rotation: number;
  raw: Record<string, unknown>;
};
export function profiles(width: number, height: number): Rendition[] {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 2 ||
    height < 2
  )
    throw Error("INVALID_DIMENSIONS");
  const ladder = [
    { height: 360, bitrate: 800000 },
    { height: 480, bitrate: 1400000 },
    { height: 720, bitrate: 2800000 },
    { height: 1080, bitrate: 5000000 },
    { height: 2160, bitrate: 14000000 },
  ];
  const selected = ladder.filter((x) => x.height <= height);
  if (!selected.length)
    selected.push({ height: Math.floor(height / 2) * 2, bitrate: 500000 });
  return selected.map((x) => ({
    ...x,
    width: Math.max(2, Math.floor((width * x.height) / height / 2) * 2),
    name: `${x.height}p`,
  }));
}
export async function run(
  command: string,
  args: string[],
  timeout = 7200000,
  onProgress?: (seconds: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "",
      stderr = "",
      partial = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("MEDIA_TIMEOUT"));
    }, timeout);
    child.stdout.on("data", (b: Buffer) => {
      stdout = (stdout + b.toString()).slice(-4 * 1024 * 1024);
      partial += b.toString();
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("out_time_us="))
          onProgress?.(Number(line.slice(12)) / 1e6);
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-16000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(Error(`MEDIA_PROCESS_FAILED: ${stderr}`));
      else resolve(stdout);
    });
  });
}
export async function probe(source: string): Promise<Metadata> {
  const raw = JSON.parse(
    await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,matroska,webm",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        source,
      ],
      60000,
    ),
  );
  const v = raw.streams?.find(
    (s: { codec_type: string }) => s.codec_type === "video",
  );
  if (!v) throw Error("NO_VIDEO_STREAM");
  const rotation = Number(
    v.side_data_list?.find(
      (s: { rotation?: number }) => s.rotation !== undefined,
    )?.rotation ??
      v.tags?.rotate ??
      0,
  );
  const rotated = Math.abs(rotation) % 180 === 90;
  const metadata = {
    width: Number(rotated ? v.height : v.width),
    height: Number(rotated ? v.width : v.height),
    duration: Number(raw.format?.duration),
    hasAudio: raw.streams.some(
      (s: { codec_type: string }) => s.codec_type === "audio",
    ),
    codec: String(v.codec_name),
    rotation,
    raw,
  };
  if (
    !Number.isFinite(metadata.duration) ||
    metadata.duration <= 0 ||
    metadata.width > 8192 ||
    metadata.height > 8192
  )
    throw Error("UNSUPPORTED_MEDIA");
  return metadata;
}
export async function transcode(
  source: string,
  output: string,
  metadata: Metadata,
  onProgress?: (name: string, pct: number) => void,
) {
  const variants = profiles(metadata.width, metadata.height);
  for (const variant of variants) {
    const dir = join(output, variant.name);
    await mkdir(dir, { recursive: true });
    const audio = metadata.hasAudio
      ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ac", "2"]
      : ["-an"];
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
        ...audio,
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
      (s) =>
        onProgress?.(
          variant.name,
          Math.min(99, Math.round((s / metadata.duration) * 100)),
        ),
    );
    onProgress?.(variant.name, 100);
  }
  const master = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS"];
  for (const v of variants) {
    const lines = (
      await readFile(join(output, v.name, "index.m3u8"), "utf8")
    ).split("\n");
    let duration = 0,
      totalDuration = 0,
      totalBytes = 0,
      peak = 0;
    for (const line of lines) {
      if (line.startsWith("#EXTINF:"))
        duration = Number(line.slice(8).split(",")[0]);
      else if (line.endsWith(".ts")) {
        const bytes = (await stat(join(output, v.name, line))).size;
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
          join(output, v.name, "segment-00000.ts"),
        ],
        30000,
      ),
    );
    const stream = technical.streams.find(
      (x: { codec_type: string }) => x.codec_type === "video",
    );
    const codec = `avc1.6400${Number(stream.level).toString(16).padStart(2, "0")}`;
    master.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.ceil(peak)},AVERAGE-BANDWIDTH=${Math.ceil((totalBytes * 8) / totalDuration)},RESOLUTION=${v.width}x${v.height},CODECS="${codec}${metadata.hasAudio ? ",mp4a.40.2" : ""}"`,
      `${v.name}/index.m3u8`,
    );
  }
  await writeFile(join(output, "master.m3u8"), master.join("\n") + "\n");
  return variants;
}
export async function thumbnails(
  source: string,
  output: string,
  duration: number,
) {
  await mkdir(output, { recursive: true });
  await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      "mov,matroska,webm",
      "-ss",
      String(Math.min(duration / 4, 5)),
      "-i",
      source,
      "-frames:v",
      "1",
      "-vf",
      "scale='min(1280,iw)':-2",
      join(output, "poster.jpg"),
    ],
    60000,
  );
  const interval = Math.max(1, duration / 60);
  await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      "mov,matroska,webm",
      "-i",
      source,
      "-vf",
      `fps=1/${interval},scale=240:-2`,
      "-frames:v",
      "60",
      join(output, "%04d.jpg"),
    ],
    300000,
  );
  const files = (await readdir(output))
    .filter((x) => /^\d+\.jpg$/.test(x))
    .sort();
  const stamp = (s: number) =>
    new Date(Math.floor(s * 1000)).toISOString().slice(11, 23);
  await writeFile(
    join(output, "previews.vtt"),
    "WEBVTT\n\n" +
      files
        .map(
          (f, i) =>
            `${stamp(i * interval)} --> ${stamp(Math.min(duration, (i + 1) * interval))}\n${f}\n`,
        )
        .join("\n"),
  );
}
export function subtitleVtt(input: string) {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (text.includes("<script") || text.includes("-->") === false)
    throw Error("INVALID_SUBTITLE");
  if (text.startsWith("WEBVTT")) return text;
  const converted = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  if (!/\d{2}:\d{2}:\d{2}\.\d{3} --> /.test(converted))
    throw Error("INVALID_SUBTITLE");
  return "WEBVTT\n\n" + converted;
}
export type TranscriptSegment = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

function cueSeconds(value: string) {
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3) throw Error("INVALID_SUBTITLE");
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  if (
    !Number.isFinite(seconds) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(hours) ||
    seconds < 0 ||
    minutes < 0 ||
    hours < 0
  )
    throw Error("INVALID_SUBTITLE");
  return hours * 3600 + minutes * 60 + seconds;
}

export function subtitleSegments(input: string): TranscriptSegment[] {
  const normalized = subtitleVtt(input).replace(/\r\n/g, "\n");
  const segments: TranscriptSegment[] = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [rawStart, rawEndWithSettings] = lines[timingIndex]!.split("-->");
    if (!rawStart || !rawEndWithSettings) throw Error("INVALID_SUBTITLE");
    const rawEnd = rawEndWithSettings.trim().split(/\s+/)[0]!;
    const startSeconds = cueSeconds(rawStart);
    const endSeconds = cueSeconds(rawEnd);
    if (endSeconds < startSeconds) throw Error("INVALID_SUBTITLE");
    const text = lines
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
    if (text) segments.push({ startSeconds, endSeconds, text });
  }
  if (!segments.length) throw Error("INVALID_SUBTITLE");
  return segments;
}

export async function validateHls(output: string, variants: Rendition[]) {
  const master = await readFile(join(output, "master.m3u8"), "utf8");
  if (!master.startsWith("#EXTM3U")) throw Error("INVALID_MASTER");
  for (const variant of variants) {
    const playlist = await readFile(
      join(output, variant.name, "index.m3u8"),
      "utf8",
    );
    if (!playlist.includes("#EXT-X-ENDLIST")) throw Error("INCOMPLETE_HLS");
    const files = playlist.split("\n").filter((s) => s && !s.startsWith("#"));
    if (!files.length) throw Error("EMPTY_HLS");
    for (const f of files) {
      if (!/^segment-\d+\.ts$/.test(f)) throw Error("UNSAFE_SEGMENT");
      await readFile(join(output, variant.name, f));
    }
  }
}
