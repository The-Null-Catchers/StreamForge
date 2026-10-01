import type { FastifyInstance } from "fastify";
import { db } from "../../../packages/shared/src/db.js";
import { redis } from "../../../packages/shared/src/queues.js";
import { storage } from "../../../packages/shared/src/storage.js";
import { access, uuid } from "./context.js";

export async function operationsRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/operations",
    async (req) => {
      uuid.parse(req.params.id);
      await access(req, req.params.id, "admin");

      const [database, redisState, storageState, workerIds] = await Promise.all([
        db
          .query("SELECT 1")
          .then(() => "ok")
          .catch(() => "error"),
        redis
          .ping()
          .then(() => "ok")
          .catch(() => "error"),
        storage
          .ready()
          .then(() => "ok")
          .catch(() => "error"),
        redis
          .zrangebyscore(
            "streamforge:workers",
            Date.now() - 30000,
            "+inf",
          )
          .catch(() => []),
      ]);

      const [processing, live, failedJobs, failedWebhooks, usage] =
        await Promise.all([
          db.query(
            `SELECT pj.status,count(*)::int AS count
             FROM processing_jobs pj
             JOIN videos v ON v.id=pj.video_id
             WHERE v.workspace_id=$1
             GROUP BY pj.status
             ORDER BY pj.status`,
            [req.params.id],
          ),
          db.query(
            `SELECT status,active_ingest,count(*)::int AS count
             FROM live_streams
             WHERE workspace_id=$1
             GROUP BY status,active_ingest
             ORDER BY status,active_ingest`,
            [req.params.id],
          ),
          db.query(
            `SELECT pj.id,pj.video_id,pj.queue,pj.status,pj.error_code,pj.updated_at
             FROM processing_jobs pj
             JOIN videos v ON v.id=pj.video_id
             WHERE v.workspace_id=$1 AND pj.status='failed'
             ORDER BY pj.updated_at DESC
             LIMIT 20`,
            [req.params.id],
          ),
          db.query(
            `SELECT d.id,d.event,d.attempts,d.response_status,d.created_at
             FROM webhook_deliveries d
             JOIN webhooks w ON w.id=d.webhook_id
             WHERE w.workspace_id=$1
               AND d.status='failed'
             ORDER BY d.created_at DESC
             LIMIT 20`,
            [req.params.id],
          ),
          db.query(
            `SELECT
               coalesce(sum(v.size),0)::bigint AS source_bytes,
               count(v.id)::int AS videos,
               coalesce(
                 (SELECT sum(amount)
                  FROM usage_records
                  WHERE workspace_id=$1 AND kind='output_bytes'),
                 0
               )::bigint AS output_bytes,
               coalesce(
                 (SELECT sum(amount)
                  FROM usage_records
                  WHERE workspace_id=$1
                    AND kind='live_seconds'
                    AND created_at>=date_trunc('month',now())),
                 0
               )::bigint AS finalized_live_seconds
             FROM videos v
             WHERE v.workspace_id=$1 AND v.deleted_at IS NULL`,
            [req.params.id],
          ),
        ]);

      return {
        dependencies: {
          database,
          redis: redisState,
          storage: storageState,
          workers: workerIds.length ? "ok" : "error",
        },
        processing: processing.rows,
        live: live.rows,
        recentFailures: {
          processing: failedJobs.rows,
          webhooks: failedWebhooks.rows,
        },
        usage: usage.rows[0] ?? {
          source_bytes: 0,
          output_bytes: 0,
          videos: 0,
          finalized_live_seconds: 0,
        },
        generatedAt: new Date().toISOString(),
      };
    },
  );
}
