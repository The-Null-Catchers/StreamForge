import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { hash, opaque } from "../../../packages/shared/src/security.js";
import { enqueue } from "../../../packages/shared/src/events.js";
import { config } from "../../../packages/config/src/index.js";
import { access, audit, uuid, ApiError } from "./context.js";
export async function platformRoutes(app: FastifyInstance) {
  app.post("/api/v1/api-keys", async (req) => {
    const b = z
      .object({
        workspaceId: uuid,
        name: z.string().min(1).max(100),
        scopes: z
          .array(
            z.enum([
              "videos:read",
              "videos:write",
              "uploads:write",
              "analytics:read",
            ]),
          )
          .min(1),
        test: z.boolean().default(false),
      })
      .parse(req.body);
    const a = await access(req, b.workspaceId, "admin");
    const key = `sf_${b.test ? "test" : "live"}_${opaque()}`;
    const r = await db.query(
      "INSERT INTO api_keys(workspace_id,name,key_hash,scopes) VALUES($1,$2,$3,$4) RETURNING id,name,scopes,created_at",
      [b.workspaceId, b.name, hash(key), b.scopes],
    );
    await audit(b.workspaceId, a, "api_key.created", r.rows[0].id);
    return { ...r.rows[0], key };
  });
  app.get("/api/v1/api-keys", async (req) => {
    const b = z.object({ workspaceId: uuid }).parse(req.query);
    await access(req, b.workspaceId, "admin");
    return (
      await db.query(
        "SELECT id,name,scopes,created_at,last_used_at,revoked_at FROM api_keys WHERE workspace_id=$1",
        [b.workspaceId],
      )
    ).rows;
  });
  app.delete<{ Params: { id: string } }>(
    "/api/v1/api-keys/:id",
    async (req) => {
      uuid.parse(req.params.id);
      const r = await db.query(
        "SELECT workspace_id FROM api_keys WHERE id=$1",
        [req.params.id],
      );
      if (!r.rowCount) throw new ApiError(404, "KEY_NOT_FOUND");
      const a = await access(req, r.rows[0].workspace_id, "admin");
      await db.query("UPDATE api_keys SET revoked_at=now() WHERE id=$1", [
        req.params.id,
      ]);
      await audit(r.rows[0].workspace_id, a, "api_key.revoked", req.params.id);
      return { ok: true };
    },
  );
  app.post("/api/v1/webhooks", async (req) => {
    const b = z
      .object({ workspaceId: uuid, url: z.url().max(2000) })
      .parse(req.body);
    const a = await access(req, b.workspaceId, "admin");
    const u = new URL(b.url);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      (u.port && u.port !== "443") ||
      !config.WEBHOOK_ALLOWED_HOSTS.split(",").includes(u.hostname)
    )
      throw new ApiError(
        400,
        "WEBHOOK_HOST_NOT_ALLOWED",
        "Configure an exact approved HTTPS webhook hostname on the server.",
      );
    const secret = opaque();
    const r = await db.query(
      "INSERT INTO webhooks(workspace_id,url,secret) VALUES($1,$2,$3) RETURNING id,url",
      [b.workspaceId, b.url, secret],
    );
    await audit(b.workspaceId, a, "webhook.created", r.rows[0].id);
    return { ...r.rows[0], secret };
  });
  app.get("/api/v1/webhooks", async (req) => {
    const b = z.object({ workspaceId: uuid }).parse(req.query);
    await access(req, b.workspaceId, "admin");
    return (
      await db.query(
        "SELECT id,url,enabled,created_at FROM webhooks WHERE workspace_id=$1",
        [b.workspaceId],
      )
    ).rows;
  });
  app.get<{ Params: { id: string } }>(
    "/api/v1/webhooks/:id/deliveries",
    async (req) => {
      uuid.parse(req.params.id);
      const h = (
        await db.query("SELECT workspace_id FROM webhooks WHERE id=$1", [
          req.params.id,
        ])
      ).rows[0];
      if (!h) throw new ApiError(404, "WEBHOOK_NOT_FOUND");
      await access(req, h.workspace_id, "admin");
      return (
        await db.query(
          "SELECT * FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY created_at DESC LIMIT 100",
          [req.params.id],
        )
      ).rows;
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/webhooks/:id",
    async (req) => {
      uuid.parse(req.params.id);
      const h = (
        await db.query("SELECT workspace_id FROM webhooks WHERE id=$1", [
          req.params.id,
        ])
      ).rows[0];
      if (!h) throw new ApiError(404, "WEBHOOK_NOT_FOUND");
      const a = await access(req, h.workspace_id, "admin");
      await db.query("UPDATE webhooks SET enabled=false WHERE id=$1", [
        req.params.id,
      ]);
      await audit(h.workspace_id, a, "webhook.disabled", req.params.id);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/webhook-deliveries/:id/resend",
    async (req) => {
      uuid.parse(req.params.id);
      const d = (
        await db.query(
          "SELECT d.*,w.workspace_id FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE d.id=$1",
          [req.params.id],
        )
      ).rows[0];
      if (!d) throw new ApiError(404, "DELIVERY_NOT_FOUND");
      await access(req, d.workspace_id, "admin");
      await transaction(async (c) => {
        const r = await c.query(
          "INSERT INTO webhook_deliveries(webhook_id,event,payload) VALUES($1,$2,$3) RETURNING id",
          [d.webhook_id, d.event, d.payload],
        );
        await enqueue(c, "webhooks", { deliveryId: r.rows[0].id });
      });
      return { ok: true };
    },
  );
}
