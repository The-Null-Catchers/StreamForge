import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { enqueue } from "../../../packages/shared/src/events.js";
import { config } from "../../../packages/config/src/index.js";
import { actor, videoAccess, ApiError } from "./context.js";

const language = z.enum(["auto", "ar", "en"]);

export async function transcriptionRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>(
    "/api/v1/videos/:id/transcriptions",
    async (req, reply) => {
      const video = await videoAccess(
        req,
        req.params.id,
        "editor",
        "videos:write",
      );
      if (video.status !== "ready" || !video.source_key)
        throw new ApiError(409, "VIDEO_NOT_READY");
      if (config.TRANSCRIPTION_PROVIDER === "disabled")
        throw new ApiError(503, "TRANSCRIPTION_NOT_CONFIGURED");

      const body = z
        .object({
          language: language.default("auto"),
        })
        .parse(req.body ?? {});
      const a = await actor(req);
      try {
        const row = await transaction(async (client) => {
          const inserted = (
            await client.query(
              `INSERT INTO transcriptions(
                 video_id,requested_by,provider,model,language
               ) VALUES($1,$2,$3,$4,$5)
               RETURNING *`,
              [
                video.id,
                a.userId ?? null,
                config.TRANSCRIPTION_PROVIDER,
                config.TRANSCRIPTION_MODEL,
                body.language,
              ],
            )
          ).rows[0];
          await enqueue(client, "subtitle-processing", {
            transcriptionId: inserted.id,
            videoId: video.id,
          });
          return inserted;
        });
        return reply.code(202).send(row);
      } catch (error: any) {
        if (error?.code === "23505")
          throw new ApiError(409, "TRANSCRIPTION_ALREADY_RUNNING");
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/transcriptions",
    async (req) => {
      await videoAccess(req, req.params.id, "viewer", "videos:read");
      return (
        await db.query(
          `SELECT
             id,video_id,provider,model,language,status,progress,
             subtitle_id,error_code,created_at,started_at,completed_at,updated_at
           FROM transcriptions
           WHERE video_id=$1
           ORDER BY created_at DESC
           LIMIT 20`,
          [req.params.id],
        )
      ).rows;
    },
  );

  app.get<{ Params: { id: string; transcriptionId: string } }>(
    "/api/v1/videos/:id/transcriptions/:transcriptionId",
    async (req) => {
      await videoAccess(req, req.params.id, "viewer", "videos:read");
      const row = (
        await db.query(
          `SELECT
             id,video_id,provider,model,language,status,progress,
             subtitle_id,error_code,created_at,started_at,completed_at,updated_at
           FROM transcriptions
           WHERE id=$1 AND video_id=$2`,
          [req.params.transcriptionId, req.params.id],
        )
      ).rows[0];
      if (!row) throw new ApiError(404, "TRANSCRIPTION_NOT_FOUND");
      return row;
    },
  );
}
