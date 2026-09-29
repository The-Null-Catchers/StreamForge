import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { access, audit, uuid, videoAccess, ApiError } from "./context.js";

async function playlistAccess(
  req: FastifyRequest,
  id: string,
  minimum: "viewer" | "editor" = "viewer",
  scope = "videos:read",
) {
  uuid.parse(id);
  const r = await db.query("SELECT * FROM playlists WHERE id=$1", [id]);
  if (!r.rowCount) throw new ApiError(404, "PLAYLIST_NOT_FOUND");
  await access(req, r.rows[0].workspace_id, minimum, scope);
  return r.rows[0];
}

export async function collectionRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/chapters",
    async (req) => {
      await videoAccess(req, req.params.id);
      return (
        await db.query(
          "SELECT id,start_seconds,title FROM video_chapters WHERE video_id=$1 ORDER BY start_seconds,id",
          [req.params.id],
        )
      ).rows;
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/videos/:id/chapters",
    async (req) => {
      const video = await videoAccess(
        req,
        req.params.id,
        "editor",
        "videos:write",
      );
      const body = z
        .object({
          chapters: z
            .array(
              z.object({
                startSeconds: z.number().finite().min(0).max(86400),
                title: z.string().trim().min(1).max(200),
              }),
            )
            .max(500),
        })
        .parse(req.body);
      const sorted = [...body.chapters].sort(
        (a, b) => a.startSeconds - b.startSeconds,
      );
      if (
        sorted.some(
          (chapter, index) =>
            index > 0 &&
            chapter.startSeconds === sorted[index - 1]!.startSeconds,
        )
      )
        throw new ApiError(409, "DUPLICATE_CHAPTER_TIME");

      const a = await access(
        req,
        video.workspace_id,
        "editor",
        "videos:write",
      );
      await transaction(async (c) => {
        await c.query("DELETE FROM video_chapters WHERE video_id=$1", [
          video.id,
        ]);
        for (const chapter of sorted)
          await c.query(
            "INSERT INTO video_chapters(video_id,start_seconds,title) VALUES($1,$2,$3)",
            [video.id, chapter.startSeconds, chapter.title],
          );
      });
      await audit(video.workspace_id, a, "video.chapters.updated", video.id);
      return { ok: true, chapters: sorted };
    },
  );

  app.get("/api/v1/playlists", async (req) => {
    const query = z.object({ workspaceId: uuid }).parse(req.query);
    await access(req, query.workspaceId);
    return (
      await db.query(
        `SELECT p.id,p.workspace_id,p.name,p.created_at,count(pi.video_id)::int AS item_count
         FROM playlists p
         LEFT JOIN playlist_items pi ON pi.playlist_id=p.id
         WHERE p.workspace_id=$1
         GROUP BY p.id
         ORDER BY p.created_at DESC,p.id DESC`,
        [query.workspaceId],
      )
    ).rows;
  });

  app.post("/api/v1/playlists", async (req, reply) => {
    const body = z
      .object({
        workspaceId: uuid,
        name: z.string().trim().min(1).max(200),
      })
      .parse(req.body);
    const a = await access(req, body.workspaceId, "editor", "videos:write");
    const playlist = (
      await db.query(
        "INSERT INTO playlists(workspace_id,name) VALUES($1,$2) RETURNING id,workspace_id,name,created_at",
        [body.workspaceId, body.name],
      )
    ).rows[0];
    await audit(body.workspaceId, a, "playlist.created", playlist.id);
    return reply.code(201).send({ ...playlist, item_count: 0 });
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/playlists/:id",
    async (req) => {
      const playlist = await playlistAccess(req, req.params.id);
      const items = (
        await db.query(
          `SELECT v.id,v.title,v.status,v.privacy,v.filename,v.size,v.metadata,pi.position
           FROM playlist_items pi
           JOIN videos v ON v.id=pi.video_id
           WHERE pi.playlist_id=$1 AND v.deleted_at IS NULL
           ORDER BY pi.position,v.id`,
          [playlist.id],
        )
      ).rows;
      return { ...playlist, items };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/playlists/:id",
    async (req) => {
      const playlist = await playlistAccess(
        req,
        req.params.id,
        "editor",
        "videos:write",
      );
      const body = z
        .object({ name: z.string().trim().min(1).max(200) })
        .parse(req.body);
      const a = await access(
        req,
        playlist.workspace_id,
        "editor",
        "videos:write",
      );
      await db.query("UPDATE playlists SET name=$1 WHERE id=$2", [
        body.name,
        playlist.id,
      ]);
      await audit(playlist.workspace_id, a, "playlist.updated", playlist.id);
      return { ok: true };
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/playlists/:id/items",
    async (req) => {
      const playlist = await playlistAccess(
        req,
        req.params.id,
        "editor",
        "videos:write",
      );
      const body = z
        .object({ videoIds: z.array(uuid).max(500) })
        .parse(req.body);
      if (new Set(body.videoIds).size !== body.videoIds.length)
        throw new ApiError(409, "DUPLICATE_PLAYLIST_VIDEO");

      const a = await access(
        req,
        playlist.workspace_id,
        "editor",
        "videos:write",
      );
      await transaction(async (c) => {
        if (body.videoIds.length) {
          const valid = await c.query(
            "SELECT id FROM videos WHERE workspace_id=$1 AND deleted_at IS NULL AND id = ANY($2::uuid[])",
            [playlist.workspace_id, body.videoIds],
          );
          if (valid.rowCount !== body.videoIds.length)
            throw new ApiError(400, "PLAYLIST_VIDEO_INVALID");
        }
        await c.query("DELETE FROM playlist_items WHERE playlist_id=$1", [
          playlist.id,
        ]);
        for (const [position, videoId] of body.videoIds.entries())
          await c.query(
            "INSERT INTO playlist_items(playlist_id,video_id,position) VALUES($1,$2,$3)",
            [playlist.id, videoId, position],
          );
      });
      await audit(
        playlist.workspace_id,
        a,
        "playlist.items.updated",
        playlist.id,
      );
      return { ok: true, itemCount: body.videoIds.length };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/playlists/:id",
    async (req) => {
      const playlist = await playlistAccess(
        req,
        req.params.id,
        "editor",
        "videos:write",
      );
      const a = await access(
        req,
        playlist.workspace_id,
        "editor",
        "videos:write",
      );
      await transaction(async (c) => {
        await c.query("DELETE FROM playlist_items WHERE playlist_id=$1", [
          playlist.id,
        ]);
        await c.query("DELETE FROM playlists WHERE id=$1", [playlist.id]);
      });
      await audit(playlist.workspace_id, a, "playlist.deleted", playlist.id);
      return { ok: true };
    },
  );
}
