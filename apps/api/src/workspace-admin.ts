import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../../packages/shared/src/db.js";
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
        "UPDATE workspaces SET name=$2 WHERE id=$1 RETURNING id,name,created_at",
        [req.params.id, body.name],
      );
      if (!result.rowCount) throw new ApiError(404, "WORKSPACE_NOT_FOUND");
      await audit(req.params.id, a, "workspace.renamed", req.params.id);
      return result.rows[0];
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
