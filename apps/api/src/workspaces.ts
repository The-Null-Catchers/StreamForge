import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { opaque, hash } from "../../../packages/shared/src/security.js";
import { actor, access, audit, ApiError, uuid } from "./context.js";
import { sendWorkspaceInvite } from "./mail.js";
export async function workspaceRoutes(app: FastifyInstance) {
  app.get("/api/v1/workspaces", async (req) => {
    const a = await actor(req);
    return (
      await db.query(
        "SELECT w.*,m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at",
        [a.userId],
      )
    ).rows;
  });
  app.post("/api/v1/workspaces", async (req, reply) => {
    const a = await actor(req);
    if (!a.userId) throw new ApiError(403, "USER_REQUIRED");
    const b = z
      .object({ name: z.string().trim().min(1).max(100) })
      .parse(req.body);
    return reply.code(201).send(
      await transaction(async (c) => {
        const r = await c.query(
          "INSERT INTO workspaces(name) VALUES($1) RETURNING *",
          [b.name],
        );
        await c.query("INSERT INTO workspace_members VALUES($1,$2,'owner')", [
          r.rows[0].id,
          a.userId,
        ]);
        return r.rows[0];
      }),
    );
  });
  app.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/members",
    async (req) => {
      await access(req, req.params.id);
      return (
        await db.query(
          "SELECT m.user_id,m.role,u.email FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1",
          [req.params.id],
        )
      ).rows;
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/invites",
    async (req) => {
      const a = await access(req, req.params.id, "admin");
      const b = z
        .object({
          email: z.email().transform((s) => s.toLowerCase()),
          role: z.enum(["admin", "editor", "viewer"]),
        })
        .parse(req.body);
      const token = opaque();
      const tokenHash = hash(token);
      const workspace = (
        await db.query("SELECT name FROM workspaces WHERE id=$1", [req.params.id])
      ).rows[0];
      await db.query(
        "INSERT INTO workspace_invites(workspace_id,email,role,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days')",
        [req.params.id, b.email, b.role, tokenHash],
      );
      try {
        await sendWorkspaceInvite({
          to: b.email,
          workspaceName: workspace.name,
          role: b.role,
          token,
        });
      } catch {
        await db.query(
          "DELETE FROM workspace_invites WHERE workspace_id=$1 AND token_hash=$2",
          [req.params.id, tokenHash],
        );
        throw new ApiError(502, "INVITE_EMAIL_FAILED");
      }
      await audit(req.params.id, a, "member.invited", b.email);
      return { token, expiresIn: 604800, delivered: true };
    },
  );
  app.post("/api/v1/invites/accept", async (req) => {
    const a = await actor(req);
    const b = z.object({ token: z.string().max(200) }).parse(req.body);
    return transaction(async (c) => {
      const r = await c.query(
        "DELETE FROM workspace_invites WHERE token_hash=$1 AND expires_at>now() AND email=(SELECT email FROM users WHERE id=$2) RETURNING *",
        [hash(b.token), a.userId],
      );
      if (!r.rowCount) throw new ApiError(400, "INVALID_INVITE");
      const i = r.rows[0];
      await c.query(
        "INSERT INTO workspace_members VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [i.workspace_id, a.userId, i.role],
      );
      return { workspaceId: i.workspace_id };
    });
  });
  app.patch<{ Params: { id: string; user: string } }>(
    "/api/v1/workspaces/:id/members/:user",
    async (req) => {
      const a = await access(req, req.params.id, "owner");
      uuid.parse(req.params.user);
      const { role } = z
        .object({ role: z.enum(["admin", "editor", "viewer"]) })
        .parse(req.body);
      await db.query(
        "UPDATE workspace_members SET role=$1 WHERE workspace_id=$2 AND user_id=$3 AND role<>'owner'",
        [role, req.params.id, req.params.user],
      );
      await audit(req.params.id, a, "member.role_changed", req.params.user);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string; user: string } }>(
    "/api/v1/workspaces/:id/members/:user/transfer-owner",
    async (req) => {
      const a = await access(req, req.params.id, "owner");
      uuid.parse(req.params.user);
      if (!a.userId) throw new ApiError(403, "USER_REQUIRED");
      if (a.userId === req.params.user)
        throw new ApiError(400, "OWNER_TRANSFER_TARGET_REQUIRED");

      await transaction(async (c) => {
        const members = await c.query(
          "SELECT user_id,role FROM workspace_members WHERE workspace_id=$1 FOR UPDATE",
          [req.params.id],
        );
        const currentOwner = members.rows.find(
          (member) => member.user_id === a.userId && member.role === "owner",
        );
        const target = members.rows.find(
          (member) => member.user_id === req.params.user,
        );
        if (!currentOwner) throw new ApiError(409, "OWNER_CHANGED");
        if (!target) throw new ApiError(404, "MEMBER_NOT_FOUND");
        if (target.role === "owner") throw new ApiError(409, "ALREADY_OWNER");

        await c.query(
          "UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",
          [req.params.id, a.userId],
        );
        await c.query(
          "UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",
          [req.params.id, req.params.user],
        );
      });

      await audit(
        req.params.id,
        a,
        "workspace.owner_transferred",
        req.params.user,
      );
      return { ok: true, ownerUserId: req.params.user };
    },
  );

  app.delete<{ Params: { id: string; user: string } }>(
    "/api/v1/workspaces/:id/members/:user",
    async (req) => {
      const a = await access(req, req.params.id, "owner");
      uuid.parse(req.params.user);
      await db.query(
        "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role<>'owner'",
        [req.params.id, req.params.user],
      );
      await audit(req.params.id, a, "member.removed", req.params.user);
      return { ok: true };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/usage",
    async (req) => {
      await access(req, req.params.id);
      return (
        await db.query(
          `SELECT
             w.storage_limit,
             w.video_limit,
             w.upload_bytes_monthly_limit,
             w.live_concurrency_limit,
             w.live_minutes_monthly_limit,
             (
               SELECT coalesce(sum(size),0)
               FROM videos
               WHERE workspace_id=w.id
                 AND deleted_at IS NULL
             ) AS source_bytes,
             (
               SELECT count(*)
               FROM videos
               WHERE workspace_id=w.id
                 AND deleted_at IS NULL
             ) AS videos,
             (
               SELECT coalesce(sum(uploaded_bytes),0)
               FROM uploads
               WHERE workspace_id=w.id
                 AND created_at>=date_trunc('month',now())
             )::bigint AS upload_bytes_this_month,
             (
               SELECT count(*)
               FROM live_streams
               WHERE workspace_id=w.id
                 AND status='live'
             ) AS active_live_streams,
             (
               coalesce(
                 (SELECT sum(amount)
                  FROM usage_records
                  WHERE workspace_id=w.id
                    AND kind='live_seconds'
                    AND created_at>=date_trunc('month',now())),
                 0
               )
               +
               coalesce(
                 (SELECT sum(
                    greatest(
                      0,
                      extract(epoch FROM (now()-lses.started_at))
                    )
                  )
                  FROM live_sessions lses
                  JOIN live_streams lstr ON lstr.id=lses.stream_id
                  WHERE lstr.workspace_id=w.id
                    AND lses.ended_at IS NULL),
                 0
               )
             )::bigint AS live_seconds_this_month
           FROM workspaces w
           WHERE w.id=$1`,
          [req.params.id],
        )
      ).rows[0];
    },
  );
  for (const resource of ["notifications", "audit_logs"] as const)
    app.get<{ Params: { id: string } }>(
      `/api/v1/workspaces/:id/${resource}`,
      async (req) => {
        await access(
          req,
          req.params.id,
          resource === "audit_logs" ? "admin" : "viewer",
        );
        return (
          await db.query(
            `SELECT * FROM ${resource} WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100`,
            [req.params.id],
          )
        ).rows;
      },
    );
}
