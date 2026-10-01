import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import pino from "pino";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { event } from "../../../packages/shared/src/events.js";
import { config } from "../../../packages/config/src/index.js";

const execFileAsync = promisify(execFile);
const logger = pino({ name: "streamforge-live-transcoder" });

type MediaMtxPath = {
  name?: string;
  ready?: boolean;
  online?: boolean;
  source?: unknown;
};

type Running = {
  source: string;
  child: ChildProcess;
};

const running = new Map<string, Running>();
let stopping = false;

async function availablePaths() {
  const response = await fetch(`${config.LIVE_MEDIAMTX_API_URL}/v3/paths/list`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error(`MEDIAMTX_API_${response.status}`);
  const payload = (await response.json()) as { items?: MediaMtxPath[] };
  return new Set(
    (payload.items ?? [])
      .filter(
        (item) =>
          item.name &&
          (item.online === true || item.ready === true || item.source != null),
      )
      .map((item) => item.name!),
  );
}

function sourceUrl(path: string) {
  return (
    `rtsp://mediamtx:8554/${path}?token=` +
    encodeURIComponent(config.LIVE_TRANSCODER_TOKEN)
  );
}

async function probeSource(path: string) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-rtsp_transport",
      "tcp",
      "-show_streams",
      "-of",
      "json",
      sourceUrl(path),
    ],
    {
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const raw = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
    }>;
  };
  const video = raw.streams?.find((stream) => stream.codec_type === "video");
  if (!video?.height || !video.width) throw Error("LIVE_VIDEO_STREAM_REQUIRED");
  return {
    width: Number(video.width),
    height: Number(video.height),
    hasAudio: raw.streams?.some((stream) => stream.codec_type === "audio") ?? false,
  };
}

function ladder(profile: string, sourceHeight: number) {
  if (profile === "source")
    return [{ name: "source", height: sourceHeight, bitrate: 4_000_000, copy: true }];
  const candidates =
    profile === "high"
      ? [
          { name: "360p", height: 360, bitrate: 800_000 },
          { name: "720p", height: 720, bitrate: 2_800_000 },
          { name: "1080p", height: 1080, bitrate: 5_000_000 },
        ]
      : [
          { name: "360p", height: 360, bitrate: 800_000 },
          { name: "720p", height: 720, bitrate: 2_800_000 },
        ];
  const selected = candidates.filter((variant) => variant.height <= sourceHeight);
  if (!selected.length)
    selected.push({
      name: `${Math.max(2, Math.floor(sourceHeight / 2) * 2)}p`,
      height: Math.max(2, Math.floor(sourceHeight / 2) * 2),
      bitrate: 500_000,
    });
  return selected.map((variant) => ({ ...variant, copy: false }));
}

async function startTranscoder(stream: {
  id: string;
  path: string;
  live_profile: string;
  dvr_window_seconds: number;
}, source: string, preserveDvr = false) {
  const metadata = await probeSource(source);
  const variants = ladder(stream.live_profile, metadata.height);
  const root = join(config.LIVE_HLS_ROOT, "live", stream.id);
  const recordRoot = join("/recordings", stream.path, "program");
  if (!preserveDvr) await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await mkdir(recordRoot, { recursive: true });
  for (const variant of variants)
    await mkdir(join(root, variant.name), { recursive: true });

  const segmentSeconds = 2;
  const listSize = Math.max(
    15,
    Math.ceil(Number(stream.dvr_window_seconds) / segmentSeconds),
  );
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostdin",
    "-rtsp_transport",
    "tcp",
    "-i",
    sourceUrl(source),
  ];

  if (stream.live_profile === "source") {
    args.push(
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-f",
      "hls",
      "-hls_time",
      String(segmentSeconds),
      "-hls_list_size",
      String(listSize),
      "-hls_flags",
      "delete_segments+independent_segments+program_date_time+append_list",
      "-start_number_source",
      "epoch",
      "-hls_segment_filename",
      join(root, "source", "segment-%010d.ts"),
      "-master_pl_name",
      "master.m3u8",
      "-var_stream_map",
      metadata.hasAudio ? "v:0,a:0,name:source" : "v:0,name:source",
      join(root, "%v", "index.m3u8"),
    );
  } else {
    const splitLabels = variants.map((_, index) => `[v${index}in]`).join("");
    const filters = [
      `[0:v:0]split=${variants.length}${splitLabels}`,
      ...variants.map(
        (variant, index) =>
          `[v${index}in]scale=-2:${variant.height}:flags=fast_bilinear[v${index}]`,
      ),
    ];
    args.push("-filter_complex", filters.join(";"));
    for (const [index, variant] of variants.entries()) {
      args.push("-map", `[v${index}]`);
      if (metadata.hasAudio) args.push("-map", "0:a:0");
      args.push(
        `-c:v:${index}`,
        "libx264",
        `-b:v:${index}`,
        String(variant.bitrate),
        `-maxrate:v:${index}`,
        String(Math.round(variant.bitrate * 1.1)),
        `-bufsize:v:${index}`,
        String(variant.bitrate * 2),
        `-preset:v:${index}`,
        "veryfast",
        `-profile:v:${index}`,
        "high",
        `-pix_fmt:v:${index}`,
        "yuv420p",
        `-g:v:${index}`,
        "60",
        `-keyint_min:v:${index}`,
        "60",
        `-sc_threshold:v:${index}`,
        "0",
      );
      if (metadata.hasAudio)
        args.push(
          `-c:a:${index}`,
          "aac",
          `-b:a:${index}`,
          "128k",
          `-ac:a:${index}`,
          "2",
        );
    }
    const varMap = variants
      .map((variant, index) =>
        metadata.hasAudio
          ? `v:${index},a:${index},name:${variant.name}`
          : `v:${index},name:${variant.name}`,
      )
      .join(" ");
    args.push(
      "-f",
      "hls",
      "-hls_time",
      String(segmentSeconds),
      "-hls_list_size",
      String(listSize),
      "-hls_flags",
      "delete_segments+independent_segments+program_date_time+append_list",
      "-start_number_source",
      "epoch",
      "-hls_segment_filename",
      join(root, "%v", "segment-%010d.ts"),
      "-master_pl_name",
      "master.m3u8",
      "-var_stream_map",
      varMap,
      join(root, "%v", "index.m3u8"),
    );
  }

  args.push(
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c",
    "copy",
    "-f",
    "segment",
    "-segment_time",
    "3600",
    "-reset_timestamps",
    "1",
    "-strftime",
    "1",
    join(recordRoot, "%Y-%m-%d_%H-%M-%S-%s.mp4"),
  );

  const child = spawn("ffmpeg", args, {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false,
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logger.debug({ streamId: stream.id, line: chunk.toString().trim() }, "ffmpeg");
  });
  child.on("exit", (code, signal) => {
    const current = running.get(stream.id);
    if (current?.child === child) running.delete(stream.id);
    logger.warn({ streamId: stream.id, source, code, signal }, "live transcoder exited");
  });
  child.on("error", (error) => {
    logger.error({ streamId: stream.id, source, err: error }, "live transcoder failed");
  });
  running.set(stream.id, { source, child });
  logger.info(
    {
      streamId: stream.id,
      source,
      profile: stream.live_profile,
      dvrWindowSeconds: stream.dvr_window_seconds,
      variants: variants.map((variant) => variant.name),
    },
    "live transcoder started",
  );
}

async function setActiveIngest(
  stream: { id: string; workspace_id: string; active_ingest: string | null },
  ingest: "primary" | "backup" | null,
) {
  if (stream.active_ingest === ingest) return;
  await transaction(async (client) => {
    await client.query(
      "UPDATE live_streams SET active_ingest=$2,updated_at=now() WHERE id=$1",
      [stream.id, ingest],
    );
    if (ingest === "backup")
      await event(
        client,
        stream.workspace_id,
        stream.id,
        "live.failover",
        "streamId",
      );
    if (ingest === "primary" && stream.active_ingest === "backup")
      await event(
        client,
        stream.workspace_id,
        stream.id,
        "live.primary.restored",
        "streamId",
      );
  });
}

async function reconcile() {
  const active = await availablePaths();
  const streams = (
    await db.query(
      `SELECT id,workspace_id,path,status,active_ingest,dvr_window_seconds,live_profile
       FROM live_streams
       WHERE status<>'disabled'`,
    )
  ).rows;

  const known = new Set(streams.map((stream) => stream.id));
  for (const [streamId, process] of running) {
    if (!known.has(streamId)) {
      process.child.kill("SIGTERM");
      running.delete(streamId);
    }
  }

  for (const stream of streams) {
    const primary = `${stream.path}/primary`;
    const backup = `${stream.path}/backup`;
    const selected = active.has(primary)
      ? { role: "primary" as const, path: primary }
      : active.has(backup)
        ? { role: "backup" as const, path: backup }
        : null;

    await setActiveIngest(stream, selected?.role ?? null);
    const current = running.get(stream.id);
    if (!selected) {
      if (current) {
        current.child.kill("SIGTERM");
        running.delete(stream.id);
      }
      continue;
    }
    if (current?.source === selected.path) continue;
    const preserveDvr = Boolean(current);
    if (current) current.child.kill("SIGTERM");
    try {
      await startTranscoder(stream, selected.path, preserveDvr);
    } catch (error) {
      logger.error(
        { streamId: stream.id, source: selected.path, err: error },
        "unable to start live transcoder",
      );
    }
  }
}

async function loop() {
  while (!stopping) {
    try {
      await reconcile();
    } catch (error) {
      logger.error({ err: error }, "live transcoder reconcile failed");
    }
    await new Promise((resolve) =>
      setTimeout(resolve, config.LIVE_POLL_INTERVAL_MS),
    );
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  for (const process of running.values()) process.child.kill("SIGTERM");
  await db.end();
}

process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
await loop();
