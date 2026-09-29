import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../../packages/shared/src/db.js";
import { access, videoAccess, uuid } from "./context.js";

export async function transcriptRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/transcript",
    async (req) => {
      const video = await videoAccess(req, req.params.id);
      const query = z
        .object({
          search: z.string().trim().max(200).default(""),
          language: z.string().max(20).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
        })
        .parse(req.query);

      const params: unknown[] = [
        video.id,
        query.language ?? null,
        query.search,
        query.limit,
        query.offset,
      ];
      return {
        items: (
          await db.query(
            `SELECT id,subtitle_id,language,start_seconds,end_seconds,text
             FROM transcript_segments
             WHERE video_id=$1
               AND ($2::text IS NULL OR language=$2)
               AND (
                 $3::text=''
                 OR to_tsvector('simple',text) @@ plainto_tsquery('simple',$3)
                 OR text ILIKE '%' || $3 || '%'
               )
             ORDER BY start_seconds,id
             LIMIT $4 OFFSET $5`,
            params,
          )
        ).rows,
        limit: query.limit,
        offset: query.offset,
      };
    },
  );

  app.get("/api/v1/transcripts/search", async (req) => {
    const query = z
      .object({
        workspaceId: uuid,
        q: z.string().trim().min(1).max(200),
        language: z.string().max(20).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(req.query);
    await access(req, query.workspaceId, "viewer", "videos:read");
    return (
      await db.query(
        `SELECT ts.id,ts.video_id,v.title,ts.subtitle_id,ts.language,
                ts.start_seconds,ts.end_seconds,ts.text
         FROM transcript_segments ts
         JOIN videos v ON v.id=ts.video_id
         WHERE v.workspace_id=$1
           AND v.deleted_at IS NULL
           AND ($2::text IS NULL OR ts.language=$2)
           AND (
             to_tsvector('simple',ts.text) @@ plainto_tsquery('simple',$3)
             OR ts.text ILIKE '%' || $3 || '%'
           )
         ORDER BY
           ts_rank(to_tsvector('simple',ts.text),plainto_tsquery('simple',$3)) DESC,
           v.created_at DESC,
           ts.start_seconds
         LIMIT $4`,
        [
          query.workspaceId,
          query.language ?? null,
          query.q,
          query.limit,
        ],
      )
    ).rows;
  });
}
