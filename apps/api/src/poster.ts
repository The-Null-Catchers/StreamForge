import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { transaction } from "../../../packages/shared/src/db.js";
import { enqueue, event } from "../../../packages/shared/src/events.js";
import { access, audit, ApiError, videoAccess } from "./context.js";

export async function posterRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>(
    "/api/v1/videos/:id/poster",
    async (req, reply) => {
      const video = await videoAccess(
        req,
        req.params.id,
        "editor",
        "videos:write",
      );
      if (video.status !== "ready" || !video.source_key || !video.output_prefix)
        throw new ApiError(409, "VIDEO_NOT_READY");

      const body = z
        .object({ timeSeconds: z.number().finite().min(0) })
        .parse(req.body);
      const duration = Number(video.metadata?.duration);
      if (!Number.isFinite(duration) || body.timeSeconds >= duration)
        throw new ApiError(422, "POSTER_TIME_OUT_OF_RANGE");

      const actor = await access(
        req,
        video.workspace_id,
        "editor",
        "videos:write",
      );
      await transaction(async (client) => {
        await enqueue(client, "poster-generation", {
          videoId: video.id,
          timeSeconds: body.timeSeconds,
        });
        await event(
          client,
          video.workspace_id,
          video.id,
          "video.poster.requested",
          "videoId",
          { timeSeconds: body.timeSeconds },
        );
      });
      await audit(video.workspace_id, actor, "video.poster.requested", video.id);
      return reply.code(202).send({
        queued: true,
        timeSeconds: body.timeSeconds,
      });
    },
  );
}
