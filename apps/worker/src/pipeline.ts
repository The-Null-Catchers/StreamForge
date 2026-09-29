import type { Job } from "bullmq";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdtemp, rm, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { storage, videoPrefix } from "../../../packages/shared/src/storage.js";
import { enqueue, event } from "../../../packages/shared/src/events.js";
import { config } from "../../../packages/config/src/index.js";
import {
  probe,
  transcode,
  thumbnails,
  validateHls,
  type Metadata,
} from "../../../packages/media-core/src/index.js";
async function uploadDirectory(local: string, prefix: string) {
  let bytes = 0;
  for (const name of await readdir(local)) {
    const file = join(local, name);
    const s = await stat(file);
    if (s.isDirectory())
      bytes += await uploadDirectory(file, `${prefix}${name}/`);
    else {
      const type = name.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : name.endsWith(".ts")
          ? "video/mp2t"
          : name.endsWith(".vtt")
            ? "text/vtt"
            : "image/jpeg";
      await storage.put(prefix + name, createReadStream(file), type, s.size);
      if (!(await storage.exists(prefix + name)))
        throw Error("OUTPUT_VERIFICATION_FAILED");
      bytes += s.size;
    }
  }
  return bytes;
}
export async function mediaJob(job: Job) {
  const { videoId } = job.data;
  const lock = await db.connect();
  let dir: string | undefined;
  try {
    await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
      videoId,
    ]);
    const v = (await db.query("SELECT * FROM videos WHERE id=$1", [videoId]))
      .rows[0];
    if (!v) return;
    if (job.queueName === "cleanup") {
      if (!v.deleted_at) return;
      await storage.deletePrefix(videoPrefix(v.workspace_id, v.id));
      return;
    }
    if (v.deleted_at || v.status === "ready") return;
    const done = (
      await db.query("SELECT status FROM processing_jobs WHERE id=$1", [job.id])
    ).rows[0];
    if (done?.status === "complete") return;
    await db.query(
      "INSERT INTO processing_jobs(id,video_id,queue,status,attempt) VALUES($1,$2,$3,'running',$4) ON CONFLICT(id) DO UPDATE SET status='running',attempt=$4,updated_at=now()",
      [job.id, videoId, job.queueName, job.attemptsMade + 1],
    );
    dir = await mkdtemp(join(tmpdir(), "streamforge-"));
    const source = join(dir, "source.bin");
    const output = join(dir, "output");
    await mkdir(output);
    if (job.queueName === "media-probe") {
      await db.query(
        "UPDATE videos SET status='probing' WHERE id=$1 AND deleted_at IS NULL",
        [videoId],
      );
      const u = (
        await db.query("SELECT * FROM uploads WHERE id=$1", [job.data.uploadId])
      ).rows[0];
      if (!u || ["cancelled", "expired"].includes(u.status)) return;
      const parts = (
        await db.query(
          "SELECT * FROM upload_parts WHERE upload_id=$1 ORDER BY part_number",
          [u.id],
        )
      ).rows;
      const digest = createHash("sha256");
      let bytes = 0;
      for (const part of parts) {
        const readable = await storage.get(part.object_key);
        const partHash = createHash("sha256");
        readable.on("data", (b: Buffer) => {
          digest.update(b);
          partHash.update(b);
          bytes += b.length;
        });
        await pipeline(readable, createWriteStream(source, { flags: "a" }));
        if (partHash.digest("hex") !== part.checksum)
          throw Error("CHECKSUM_MISMATCH");
      }
      if (bytes !== Number(u.total_size) || digest.digest("hex") !== u.checksum)
        throw Error("CHECKSUM_MISMATCH");
      const metadata = await probe(source);
      if (metadata.duration > config.MAX_VIDEO_DURATION_HOURS * 3600)
        throw Error("DURATION_LIMIT");
      const key = videoPrefix(v.workspace_id, v.id) + "source/source.bin";
      await storage.put(key, createReadStream(source), u.mime_type, bytes);
      await transaction(async (c) => {
        await c.query(
          "UPDATE videos SET status='processing',source_key=$1,metadata=$2,checksum=$3,output_prefix=$4 WHERE id=$5 AND deleted_at IS NULL",
          [
            key,
            metadata,
            u.checksum,
            videoPrefix(v.workspace_id, v.id) + `outputs/${job.id}/`,
            videoId,
          ],
        );
        await c.query("UPDATE uploads SET status='complete' WHERE id=$1", [
          u.id,
        ]);
        await event(c, v.workspace_id, v.id, "video.upload.completed");
        await event(c, v.workspace_id, v.id, "video.processing.started");
        await enqueue(c, "video-transcode", { videoId });
        await c.query(
          "UPDATE processing_jobs SET status='complete' WHERE id=$1",
          [job.id],
        );
      });
    } else if (job.queueName === "video-transcode") {
      await pipeline(
        await storage.get(v.source_key),
        createWriteStream(source),
      );
      let lastWrite = 0;
      let pending = Promise.resolve();
      const variants = await transcode(
        source,
        output,
        v.metadata as Metadata,
        (name, pct) => {
          if (Date.now() - lastWrite > 1500 || pct === 100) {
            lastWrite = Date.now();
            pending = pending.then(async () => {
              await db.query(
                "UPDATE videos SET progress=jsonb_set(progress,ARRAY[$1],$2::jsonb),updated_at=now() WHERE id=$3 AND deleted_at IS NULL",
                [name, JSON.stringify(pct), videoId],
              );
              await job.updateProgress({ name, pct });
            });
          }
        },
      );
      await pending;
      await validateHls(output, variants);
      const bytes = await uploadDirectory(output, v.output_prefix + "hls/");
      await transaction(async (c) => {
        await c.query(
          "UPDATE videos SET renditions=$1 WHERE id=$2 AND deleted_at IS NULL",
          [JSON.stringify(variants), videoId],
        );
        await c.query(
          "INSERT INTO usage_records(workspace_id,video_id,kind,amount,idempotency_key) VALUES($1,$2,'output_bytes',$3,$4) ON CONFLICT DO NOTHING",
          [v.workspace_id, videoId, bytes, job.id],
        );
        await enqueue(c, "thumbnail-generation", { videoId });
        await c.query(
          "UPDATE processing_jobs SET status='complete' WHERE id=$1",
          [job.id],
        );
      });
    } else if (job.queueName === "thumbnail-generation") {
      await pipeline(
        await storage.get(v.source_key),
        createWriteStream(source),
      );
      await thumbnails(source, output, v.metadata.duration);
      await uploadDirectory(output, v.output_prefix + "thumbnails/");
      await transaction(async (c) => {
        await c.query(
          "UPDATE videos SET status='packaging' WHERE id=$1 AND deleted_at IS NULL",
          [videoId],
        );
        await enqueue(c, "hls-packaging", { videoId });
        await c.query(
          "UPDATE processing_jobs SET status='complete' WHERE id=$1",
          [job.id],
        );
      });
    } else if (job.queueName === "hls-packaging") {
      for (const key of [
        "hls/master.m3u8",
        "thumbnails/poster.jpg",
        ...v.renditions.map(
          (r: { name: string }) => `hls/${r.name}/index.m3u8`,
        ),
      ])
        if (!(await storage.exists(v.output_prefix + key)))
          throw Error("OUTPUT_MISSING");
      await transaction(async (c) => {
        const r = await c.query(
          "UPDATE videos SET status='ready',updated_at=now(),error_code=NULL WHERE id=$1 AND deleted_at IS NULL RETURNING id",
          [videoId],
        );
        if (r.rowCount) {
          await event(c, v.workspace_id, v.id, "video.processing.completed");
          await event(c, v.workspace_id, v.id, "video.ready");
          await c.query(
            "INSERT INTO notifications(workspace_id,video_id,message) VALUES($1,$2,$3)",
            [v.workspace_id, v.id, "Your video is ready to stream."],
          );
        }
        await c.query(
          "UPDATE processing_jobs SET status='complete' WHERE id=$1",
          [job.id],
        );
      });
      await storage.deletePrefix(videoPrefix(v.workspace_id, v.id) + "parts/");
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
    await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
      videoId,
    ]);
    lock.release();
  }
}
