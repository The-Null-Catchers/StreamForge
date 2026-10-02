import { Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { db, transaction } from "../../../packages/shared/src/db.js";
import {
  redis,
  queues,
  type QueueName,
} from "../../../packages/shared/src/queues.js";
import { enqueue, event } from "../../../packages/shared/src/events.js";
import { config } from "../../../packages/config/src/index.js";
import { mediaJob } from "./pipeline.js";
import { deliver } from "./webhooks.js";
import { rollupAnalytics } from "./analytics.js";
import { transcriptionJob } from "./transcription.js";
import { aiGenerationJob } from "./ai.js";
import { syncLiveStreams } from "./live.js";
import { liveImportJob } from "./live-import.js";
import { cleanupStaleTempDirs } from "./temp-janitor.js";
const logger = pino();
const workerId = randomUUID();
let stopping = false;
let dispatching = false;
const names: QueueName[] = [
  "media-probe",
  "video-transcode",
  "thumbnail-generation",
  "hls-packaging",
  "subtitle-processing",
  "webhooks",
  "analytics",
  "ai",
  "live-import",
  "cleanup",
];
const workers = names.map((name) => {
  const worker = new Worker(
    name,
    async (job) => {
      logger.info(
        { workerId, jobId: job.id, videoId: job.data.videoId, queue: name },
        "job started",
      );
      if (name === "webhooks") await deliver(job.data.deliveryId);
      else if (name === "analytics")
        await rollupAnalytics(job.data.videoId, job.data.day);
      else if (name === "subtitle-processing") await transcriptionJob(job);
      else if (name === "ai") await aiGenerationJob(job);
      else if (name === "live-import") await liveImportJob(job);
      else await mediaJob(job);
    },
    {
      connection: redis,
      concurrency:
        name === "video-transcode" ? config.TRANSCODE_CONCURRENCY : 2,
      lockDuration: 60000,
      maxStalledCount: 2,
    },
  );
  worker.on("error", (err) => logger.error({ err, workerId }, "worker error"));
  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, workerId, err: error }, "job failed");
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    void transaction(async (c) => {
      if (name === "subtitle-processing" && job.data.transcriptionId) {
        await c.query(
          `UPDATE transcriptions
           SET status='failed',error_code=$2,updated_at=now()
           WHERE id=$1 AND status<>'complete'`,
          [
            job.data.transcriptionId,
            String(error?.message ?? "TRANSCRIPTION_FAILED").slice(0, 120),
          ],
        );
        return;
      }
      if (name === "ai" && job.data.generationId) {
        await c.query(
          `UPDATE ai_generations
           SET status='failed',error_code=$2,updated_at=now()
           WHERE id=$1 AND status<>'complete'`,
          [
            job.data.generationId,
            String(error?.message ?? "AI_GENERATION_FAILED").slice(0, 120),
          ],
        );
        return;
      }
      if (name === "live-import" && job.data.sessionId) {
        await c.query(
          `UPDATE live_sessions
           SET promotion_status='failed',promotion_error=$2
           WHERE id=$1 AND promotion_status<>'complete'`,
          [
            job.data.sessionId,
            String(error?.message ?? "LIVE_IMPORT_FAILED").slice(0, 120),
          ],
        );
        return;
      }
      if (
        job.data.videoId &&
        !["cleanup", "analytics", "ai", "live-import", "webhooks"].includes(name)
      ) {
        await c.query(
          "UPDATE processing_jobs SET status='dead_letter',error_code='PROCESSING_FAILED' WHERE id=$1",
          [job.id],
        );
        const v = await c.query(
          "UPDATE videos SET status='failed',error_code='PROCESSING_FAILED' WHERE id=$1 AND deleted_at IS NULL AND status<>'ready' RETURNING workspace_id",
          [job.data.videoId],
        );
        if (v.rowCount) {
          await event(
            c,
            v.rows[0].workspace_id,
            job.data.videoId,
            "video.processing.failed",
          );
          await c.query(
            "INSERT INTO notifications(workspace_id,video_id,message) VALUES($1,$2,$3)",
            [
              v.rows[0].workspace_id,
              job.data.videoId,
              "Processing failed. Retry or inspect worker logs.",
            ],
          );
        }
      }
    }).catch((err) => logger.error({ err }, "failed-state persistence error"));
  });
  return worker;
});
async function dispatch() {
  if (dispatching || stopping) return;
  dispatching = true;
  try {
    await transaction(async (c) => {
      const pending = await c.query(
        "SELECT * FROM outbox WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED",
      );
      for (const row of pending.rows) {
        const queue = queues[row.queue as QueueName];
        if (!queue) throw Error("UNKNOWN_QUEUE");
        await queue.add(row.queue, row.payload, { jobId: row.id });
        await c.query("UPDATE outbox SET dispatched_at=now() WHERE id=$1", [
          row.id,
        ]);
      }
    });
  } catch (err) {
    logger.error({ err }, "outbox dispatch failed");
  } finally {
    dispatching = false;
  }
}
async function maintenance() {
  try {
    await redis.zadd("streamforge:workers", Date.now(), workerId);
    await redis.zremrangebyscore(
      "streamforge:workers",
      "-inf",
      Date.now() - 60000,
    );
    await transaction(async (c) => {
      const expired = await c.query(
        "UPDATE uploads SET status='expired' WHERE status='uploading' AND expires_at<now() RETURNING video_id",
      );
      for (const u of expired.rows) {
        await c.query(
          "UPDATE videos SET deleted_at=now(),status='deleted' WHERE id=$1",
          [u.video_id],
        );
        await enqueue(c, "cleanup", { videoId: u.video_id });
      }
    });
    await syncLiveStreams();
    await db.query(
      "DELETE FROM analytics_events WHERE created_at<now()-interval '90 days'",
    );
    await db.query("DELETE FROM auth_tokens WHERE expires_at<now()");
    const removedTempDirs = await cleanupStaleTempDirs();
    if (removedTempDirs)
      logger.info({ removedTempDirs }, "stale worker temp directories removed");
  } catch (err) {
    logger.error({ err }, "maintenance failed");
  }
}
const dispatchTimer = setInterval(() => void dispatch(), 1000);
const heartbeatTimer = setInterval(() => void maintenance(), 10000);
await maintenance();
await dispatch();
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(dispatchTimer);
  clearInterval(heartbeatTimer);
  await Promise.all(workers.map((w) => w.close()));
  while (dispatching) await new Promise((r) => setTimeout(r, 100));
  await redis.zrem("streamforge:workers", workerId);
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await redis.quit();
  await db.end();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
