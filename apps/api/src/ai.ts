import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { enqueue } from "../../../packages/shared/src/events.js";
import { config } from "../../../packages/config/src/index.js";
import { actor, audit, videoAccess, ApiError } from "./context.js";

const kind = z.enum(["summary", "metadata", "chapters", "all"]);
const language = z.enum(["auto", "ar", "en"]);

export async function aiRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>(
    "/api/v1/videos/:id/ai-generations",
    async (req, reply) => {
      const video = await videoAccess(
        req,
        req.params.id,
        "editor",
        "videos:write",
      );
      if (video.status !== "ready") throw new ApiError(409, "VIDEO_NOT_READY");
      if (config.AI_PROVIDER === "disabled")
        throw new ApiError(503, "AI_NOT_CONFIGURED");

      const transcript = await db.query(
        "SELECT 1 FROM transcript_segments WHERE video_id=$1 LIMIT 1",
        [video.id],
      );
      if (!transcript.rowCount) throw new ApiError(409, "TRANSCRIPT_REQUIRED");

      const body = z
        .object({
          kind: kind.default("all"),
          language: language.default("auto"),
        })
        .parse(req.body ?? {});
      const a = await actor(req);
      try {
        const row = await transaction(async (client) => {
          const inserted = (
            await client.query(
              `INSERT INTO ai_generations(
                 video_id,requested_by,kind,language,provider,model
               ) VALUES($1,$2,$3,$4,$5,$6)
               RETURNING *`,
              [
                video.id,
                a.userId ?? null,
                body.kind,
                body.language,
                config.AI_PROVIDER,
                config.AI_MODEL,
              ],
            )
          ).rows[0];
          await enqueue(client, "ai", {
            generationId: inserted.id,
            videoId: video.id,
          });
          return inserted;
        });
        return reply.code(202).send(row);
      } catch (error: any) {
        if (error?.code === "23505")
          throw new ApiError(409, "AI_GENERATION_ALREADY_RUNNING");
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/ai-generations",
    async (req) => {
      await videoAccess(req, req.params.id, "viewer", "videos:read");
      return (
        await db.query(
          `SELECT
             id,video_id,kind,language,provider,model,status,result,error_code,
             created_at,started_at,completed_at,updated_at
           FROM ai_generations
           WHERE video_id=$1
           ORDER BY created_at DESC
           LIMIT 20`,
          [req.params.id],
        )
      ).rows;
    },
  );

  app.get<{ Params: { id: string; generationId: string } }>(
    "/api/v1/videos/:id/ai-generations/:generationId",
    async (req) => {
      await videoAccess(req, req.params.id, "viewer", "videos:read");
      const row = (
        await db.query(
          `SELECT
             id,video_id,kind,language,provider,model,status,result,error_code,
             created_at,started_at,completed_at,updated_at
           FROM ai_generations
           WHERE id=$1 AND video_id=$2`,
          [req.params.generationId, req.params.id],
        )
      ).rows[0];
      if (!row) throw new ApiError(404, "AI_GENERATION_NOT_FOUND");
      return row;
    },
  );

  app.post<{ Params: { id: string; generationId: string } }>(
    "/api/v1/videos/:id/ai-generations/:generationId/apply",
    async (req) => {
      const video = await videoAccess(
        req,
        req.params.id,
        "editor",
        "videos:write",
      );
      const body = z
        .object({
          metadata: z.boolean().default(true),
          chapters: z.boolean().default(true),
        })
        .parse(req.body ?? {});
      const generation = (
        await db.query(
          `SELECT result
           FROM ai_generations
           WHERE id=$1 AND video_id=$2 AND status='complete'`,
          [req.params.generationId, video.id],
        )
      ).rows[0];
      if (!generation) throw new ApiError(409, "AI_GENERATION_NOT_READY");
      const result = generation.result ?? {};
      const a = await actor(req);

      await transaction(async (client) => {
        if (body.metadata) {
          const title =
            typeof result.title === "string" && result.title.trim()
              ? result.title.trim().slice(0, 200)
              : video.title;
          const description =
            typeof result.description === "string"
              ? result.description.slice(0, 10000)
              : video.description;
          const tags = Array.isArray(result.tags)
            ? result.tags
                .filter((tag: unknown) => typeof tag === "string")
                .map((tag: string) => tag.trim().slice(0, 50))
                .filter(Boolean)
                .slice(0, 30)
            : video.tags;
          await client.query(
            `UPDATE videos
             SET title=$1,description=$2,tags=$3,updated_at=now()
             WHERE id=$4`,
            [title, description, tags, video.id],
          );
        }

        if (body.chapters && Array.isArray(result.chapters)) {
          const chapters = result.chapters
            .filter(
              (chapter: any) =>
                Number.isFinite(Number(chapter?.startSeconds)) &&
                Number(chapter.startSeconds) >= 0 &&
                typeof chapter?.title === "string" &&
                chapter.title.trim(),
            )
            .map((chapter: any) => ({
              startSeconds: Number(chapter.startSeconds),
              title: chapter.title.trim().slice(0, 200),
            }))
            .sort((left: any, right: any) => left.startSeconds - right.startSeconds)
            .filter(
              (chapter: any, index: number, all: any[]) =>
                index === 0 ||
                chapter.startSeconds > all[index - 1]!.startSeconds,
            )
            .slice(0, 500);
          await client.query("DELETE FROM video_chapters WHERE video_id=$1", [
            video.id,
          ]);
          for (const chapter of chapters)
            await client.query(
              `INSERT INTO video_chapters(video_id,start_seconds,title)
               VALUES($1,$2,$3)`,
              [video.id, chapter.startSeconds, chapter.title],
            );
        }
      });

      await audit(video.workspace_id, a, "video.ai-generation.applied", video.id);
      return { ok: true };
    },
  );
}
