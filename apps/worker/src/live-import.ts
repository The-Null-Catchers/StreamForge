import type { Job } from "bullmq";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { storage, videoPrefix } from "../../../packages/shared/src/storage.js";
import { enqueue, event } from "../../../packages/shared/src/events.js";
import { probe, run } from "../../../packages/media-core/src/index.js";
import { config } from "../../../packages/config/src/index.js";

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

async function sha256(path: string) {
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return digest.digest("hex");
}

function quoteConcatPath(path: string) {
  return `file '${path.replace(/'/g, "'\\''")}'`;
}

export async function liveImportJob(job: Job) {
  const { sessionId } = job.data as { sessionId: string };
  const session = (
    await db.query(
      `SELECT
         s.*,ls.workspace_id,ls.name AS stream_name,ls.path,ls.auto_create_vod
       FROM live_sessions s
       JOIN live_streams ls ON ls.id=s.stream_id
       WHERE s.id=$1`,
      [sessionId],
    )
  ).rows[0];
  if (!session || session.promotion_status === "complete") return;
  if (!session.ended_at || !session.auto_create_vod) {
    await db.query(
      `UPDATE live_sessions
       SET promotion_status='skipped',promotion_error=NULL
       WHERE id=$1 AND promotion_status<>'complete'`,
      [sessionId],
    );
    return;
  }

  await db.query(
    `UPDATE live_sessions
     SET promotion_status='running',promotion_error=NULL
     WHERE id=$1`,
    [sessionId],
  );

  const recordingDir = join("/recordings", session.path);
  const started = new Date(session.started_at).getTime() - 5 * 60_000;
  const ended = new Date(session.ended_at).getTime() + 5 * 60_000;
  let files: string[] = [];
  try {
    files = (await walk(recordingDir))
      .filter((path) => path.endsWith(".mp4"))
      .sort();
  } catch {
    throw Error("LIVE_RECORDING_NOT_FOUND");
  }

  const matching: string[] = [];
  for (const path of files) {
    const info = await stat(path);
    if (info.size > 0 && info.mtimeMs >= started && info.mtimeMs <= ended)
      matching.push(path);
  }
  if (!matching.length) throw Error("LIVE_RECORDING_NOT_FOUND");

  const dir = await mkdtemp(join(tmpdir(), "streamforge-live-import-"));
  try {
    const source = join(dir, "recording.mp4");
    if (matching.length === 1) await copyFile(matching[0]!, source);
    else {
      const list = join(dir, "concat.txt");
      await writeFile(list, matching.map(quoteConcatPath).join("\n") + "\n");
      await run(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          list,
          "-c",
          "copy",
          source,
        ],
        7200000,
      );
    }

    const info = await stat(source);
    if (!info.size) throw Error("LIVE_RECORDING_EMPTY");
    const metadata = await probe(source);
    if (metadata.duration > config.MAX_VIDEO_DURATION_HOURS * 3600)
      throw Error("DURATION_LIMIT");
    const checksum = await sha256(source);
    const videoId = randomUUID();
    const sourceKey = videoPrefix(session.workspace_id, videoId) + "source/source.mp4";
    const outputPrefix =
      videoPrefix(session.workspace_id, videoId) + `outputs/live-${session.id}/`;

    await transaction(async (client) => {
      const lockedSession = (
        await client.query(
          "SELECT promotion_status FROM live_sessions WHERE id=$1 FOR UPDATE",
          [session.id],
        )
      ).rows[0];
      if (!lockedSession || lockedSession.promotion_status === "complete") return;

      const workspace = (
        await client.query(
          "SELECT storage_limit,video_limit FROM workspaces WHERE id=$1 FOR UPDATE",
          [session.workspace_id],
        )
      ).rows[0];
      if (!workspace) throw Error("WORKSPACE_NOT_FOUND");

      const usage = (
        await client.query(
          `SELECT
             coalesce(sum(size),0) AS bytes,
             count(*)::int AS videos
           FROM videos
           WHERE workspace_id=$1 AND deleted_at IS NULL`,
          [session.workspace_id],
        )
      ).rows[0];
      if (Number(usage.bytes) + info.size > Number(workspace.storage_limit))
        throw Error("STORAGE_QUOTA_EXCEEDED");
      if (Number(usage.videos) >= Number(workspace.video_limit))
        throw Error("VIDEO_QUOTA_EXCEEDED");

      await storage.put(
        sourceKey,
        createReadStream(source),
        "video/mp4",
        info.size,
      );
      if (!(await storage.exists(sourceKey)))
        throw Error("OUTPUT_VERIFICATION_FAILED");

      const title =
        `${session.stream_name} · ${new Date(session.started_at).toISOString()}`;
      await client.query(
        `INSERT INTO videos(
           id,workspace_id,title,filename,privacy,status,size,metadata,
           source_key,output_prefix,checksum
         ) VALUES($1,$2,$3,$4,'private','processing',$5,$6,$7,$8,$9)`,
        [
          videoId,
          session.workspace_id,
          title.slice(0, 200),
          `live-${session.id}.mp4`,
          info.size,
          metadata,
          sourceKey,
          outputPrefix,
          checksum,
        ],
      );
      await client.query(
        `INSERT INTO usage_records(
           workspace_id,video_id,kind,amount,idempotency_key
         ) VALUES($1,$2,'source_bytes',$3,$4)
         ON CONFLICT DO NOTHING`,
        [
          session.workspace_id,
          videoId,
          info.size,
          `live-import:${session.id}`,
        ],
      );
      await client.query(
        `UPDATE live_sessions
         SET promotion_status='complete',recording_video_id=$2,
             promoted_at=now(),promotion_error=NULL
         WHERE id=$1`,
        [session.id, videoId],
      );
      await event(
        client,
        session.workspace_id,
        session.stream_id,
        "live.vod.created",
        "streamId",
      );
      await event(
        client,
        session.workspace_id,
        videoId,
        "video.processing.started",
      );
      await client.query(
        `INSERT INTO notifications(workspace_id,video_id,message)
         VALUES($1,$2,$3)`,
        [
          session.workspace_id,
          videoId,
          "Live recording imported. Video processing has started.",
        ],
      );
      await enqueue(client, "video-transcode", { videoId });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
