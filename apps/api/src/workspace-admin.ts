import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { enqueue } from "../../../packages/shared/src/events.js";
import { access, audit, ApiError, uuid } from "./context.js";

export async function workspaceAdminRoutes(app: FastifyInstance) {
  app.patch<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id",
    async (req) => {
      uuid.parse(req.params.id);
      const a = await access(req, req.params.id, "owner");
      const body = z
        .object({ name: z.string().trim().min(1).max(100) })
        .parse(req.body);
      const result = await db.query(
        "UPDATE workspaces SET name=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING id,name,created_at",
        [req.params.id, body.name],
      );
      if (!result.rowCount) throw new ApiError(404, "WORKSPACE_NOT_FOUND");
      await audit(req.params.id, a, "workspace.renamed", req.params.id);
      return result.rows[0];
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id",
    async (req, reply) => {
      uuid.parse(req.params.id);
      const a = await access(req, req.params.id, "owner");
      const body = z.object({ confirmation: z.string().max(100) }).parse(req.body);

      await transaction(async (c) => {
        const workspace = await c.query(
          "SELECT name,deleted_at FROM workspaces WHERE id=$1 FOR UPDATE",
          [req.params.id],
        );
        if (!workspace.rowCount || workspace.rows[0].deleted_at)
          throw new ApiError(404, "WORKSPACE_NOT_FOUND");
        if (body.confirmation !== workspace.rows[0].name)
          throw new ApiError(
            400,
            "WORKSPACE_CONFIRMATION_MISMATCH",
            "Type the exact workspace name to confirm deletion.",
          );

        const videos = await c.query(
          `UPDATE videos
           SET deleted_at=coalesce(deleted_at,now()),status='deleted'
           WHERE workspace_id=$1
           RETURNING id`,
          [req.params.id],
        );
        for (const video of videos.rows)
          await enqueue(c, "cleanup", { videoId: video.id });

        await c.query(
          "UPDATE api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE workspace_id=$1",
          [req.params.id],
        );
        await c.query("UPDATE webhooks SET enabled=false WHERE workspace_id=$1", [
          req.params.id,
        ]);
        await c.query("DELETE FROM workspace_invites WHERE workspace_id=$1", [
          req.params.id,
        ]);
        await c.query(
          "INSERT INTO audit_logs(workspace_id,actor_id,action,target_id) VALUES($1,$2,'workspace.deletion_requested',$1)",
          [req.params.id, a.userId ?? a.keyId],
        );
        await c.query("UPDATE workspaces SET deleted_at=now() WHERE id=$1", [
          req.params.id,
        ]);
        await c.query("DELETE FROM workspace_members WHERE workspace_id=$1", [
          req.params.id,
        ]);
      });

      return reply.code(202).send({
        ok: true,
        status: "deletion_scheduled",
        workspaceId: req.params.id,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/invites",
    async (req) => {
      uuid.parse(req.params.id);
      await access(req, req.params.id, "admin");
      return (
        await db.query(
          `SELECT id,email,role,expires_at,
                  (expires_at <= now()) AS expired
           FROM workspace_invites
           WHERE workspace_id=$1
           ORDER BY expires_at ASC,email ASC`,
          [req.params.id],
        )
      ).rows;
    },
  );

  app.delete<{ Params: { id: string; inviteId: string } }>(
    "/api/v1/workspaces/:id/invites/:inviteId",
    async (req) => {
      uuid.parse(req.params.id);
      uuid.parse(req.params.inviteId);
      const a = await access(req, req.params.id, "admin");
      const result = await db.query(
        `DELETE FROM workspace_invites
         WHERE id=$1 AND workspace_id=$2
         RETURNING id,email,role`,
        [req.params.inviteId, req.params.id],
      );
      if (!result.rowCount) throw new ApiError(404, "INVITE_NOT_FOUND");
      await audit(
        req.params.id,
        a,
        "member.invite_revoked",
        req.params.inviteId,
      );
      return { ok: true, invite: result.rows[0] };
    },
  );
}
