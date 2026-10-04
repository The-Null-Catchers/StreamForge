import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { config } from "../../../packages/config/src/index.js";
import { access, actor, audit, ApiError, uuid } from "./context.js";

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

      const deleted = await transaction(async (c) => {
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

        await c.query(
          `UPDATE videos
           SET pre_delete_status=status,
               deleted_at=coalesce(deleted_at,now()),
               status='deleted'
           WHERE workspace_id=$1 AND deleted_at IS NULL`,
          [req.params.id],
        );
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
        return (
          await c.query(
            `UPDATE workspaces
             SET deleted_at=now(),
                 restore_until=now()+$2*interval '1 day',
                 purged_at=NULL
             WHERE id=$1
             RETURNING restore_until`,
            [req.params.id, config.WORKSPACE_RESTORE_GRACE_DAYS],
          )
        ).rows[0];
      });

      return reply.code(202).send({
        ok: true,
        status: "deletion_scheduled",
        workspaceId: req.params.id,
        restoreUntil: deleted.restore_until,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/restore",
    async (req) => {
      uuid.parse(req.params.id);
      const a = await actor(req);
      if (!a.userId) throw new ApiError(403, "FORBIDDEN");

      return transaction(async (c) => {
        const workspace = await c.query(
          `SELECT id,name,deleted_at,restore_until,purged_at
           FROM workspaces WHERE id=$1 FOR UPDATE`,
          [req.params.id],
        );
        if (!workspace.rowCount || workspace.rows[0].purged_at)
          throw new ApiError(404, "WORKSPACE_NOT_FOUND");
        if (!workspace.rows[0].deleted_at)
          throw new ApiError(409, "WORKSPACE_NOT_DELETED");
        if (
          !workspace.rows[0].restore_until ||
          new Date(workspace.rows[0].restore_until) <= new Date()
        )
          throw new ApiError(410, "WORKSPACE_RESTORE_WINDOW_EXPIRED");

        const membership = await c.query(
          "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
          [req.params.id, a.userId],
        );
        if (!membership.rowCount || membership.rows[0].role !== "owner")
          throw new ApiError(403, "FORBIDDEN");

        await c.query(
          `UPDATE workspaces
           SET deleted_at=NULL,restore_until=NULL,purged_at=NULL
           WHERE id=$1`,
          [req.params.id],
        );
        await c.query(
          `UPDATE videos
           SET deleted_at=NULL,
               status=pre_delete_status,
               pre_delete_status=NULL
           WHERE workspace_id=$1 AND deleted_at IS NOT NULL AND pre_delete_status IS NOT NULL`,
          [req.params.id],
        );
        await c.query(
          "INSERT INTO audit_logs(workspace_id,actor_id,action,target_id) VALUES($1,$2,'workspace.restored',$1)",
          [req.params.id, a.userId],
        );

        return {
          ok: true,
          status: "restored",
          workspaceId: req.params.id,
          name: workspace.rows[0].name,
        };
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
