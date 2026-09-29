import type { FastifyInstance } from "fastify";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { hash, opaque } from "../../../packages/shared/src/security.js";
import { config } from "../../../packages/config/src/index.js";
import { ApiError, actor, accessToken, uuid } from "./context.js";
const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((x) => x.toLowerCase()),
  password: z.string().min(12).max(128),
});
const mail = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_PORT === 465,
  auth: config.SMTP_USER
    ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
    : undefined,
});
async function sendToken(
  user: string,
  email: string,
  kind: "verify" | "reset",
) {
  const token = opaque();
  await db.query(
    "INSERT INTO auth_tokens(user_id,kind,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [user, kind, hash(token)],
  );
  await mail.sendMail({
    from: config.MAIL_FROM,
    to: email,
    subject:
      kind === "verify"
        ? "Verify your StreamForge email"
        : "Reset your StreamForge password",
    text: `Open ${config.PUBLIC_URL}/?${kind}=${token}`,
  });
}
async function newSession(user: string) {
  const token = opaque();
  const r = await db.query(
    "INSERT INTO sessions(user_id,family_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '30 days') RETURNING id",
    [user, randomUUID(), hash(token)],
  );
  return {
    accessToken: await accessToken(user, r.rows[0].id),
    refreshToken: token,
  };
}
export async function authRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = credentials.parse(req.body);
      const password = await argon2.hash(b.password, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
      });
      let id: string;
      try {
        const r = await db.query(
          "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
          [b.email, password],
        );
        id = r.rows[0].id;
      } catch (e) {
        if ((e as { code: string }).code === "23505")
          throw new ApiError(409, "EMAIL_UNAVAILABLE");
        throw e;
      }
      await sendToken(id, b.email, "verify");
      return reply
        .code(201)
        .send({ message: "Check your email to verify your account." });
    },
  );
  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const b = credentials.parse(req.body);
      const r = await db.query("SELECT * FROM users WHERE email=$1", [b.email]);
      const u = r.rows[0];
      if (!u || !(await argon2.verify(u.password_hash, b.password)))
        throw new ApiError(401, "INVALID_CREDENTIALS");
      if (!u.email_verified) throw new ApiError(403, "EMAIL_NOT_VERIFIED");
      return newSession(u.id);
    },
  );
  app.post("/api/v1/auth/refresh", async (req) => {
    const { refreshToken } = z
      .object({ refreshToken: z.string().min(20).max(200) })
      .parse(req.body);
    const next = opaque();
    const result = await transaction(async (c) => {
      const r = await c.query(
        "SELECT * FROM sessions WHERE token_hash=$1 FOR UPDATE",
        [hash(refreshToken)],
      );
      const s = r.rows[0];
      if (!s) return null;
      if (s.revoked_at) {
        await c.query(
          "UPDATE sessions SET revoked_at=now() WHERE family_id=$1",
          [s.family_id],
        );
        return null;
      }
      if (new Date(s.expires_at) < new Date()) return null;
      await c.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [s.id]);
      const n = await c.query(
        "INSERT INTO sessions(user_id,family_id,token_hash,expires_at) VALUES($1,$2,$3,$4) RETURNING id",
        [s.user_id, s.family_id, hash(next), s.expires_at],
      );
      return { user: s.user_id, id: n.rows[0].id };
    });
    if (!result) throw new ApiError(401, "INVALID_REFRESH_TOKEN");
    return {
      accessToken: await accessToken(result.user, result.id),
      refreshToken: next,
    };
  });
  app.post("/api/v1/auth/verify", async (req) => {
    const b = z.object({ token: z.string().max(200) }).parse(req.body);
    await transaction(async (c) => {
      const r = await c.query(
        "DELETE FROM auth_tokens WHERE token_hash=$1 AND kind='verify' AND expires_at>now() RETURNING user_id",
        [hash(b.token)],
      );
      if (!r.rowCount) throw new ApiError(400, "INVALID_TOKEN");
      await c.query("UPDATE users SET email_verified=true WHERE id=$1", [
        r.rows[0].user_id,
      ]);
    });
    return { ok: true };
  });
  app.post(
    "/api/v1/auth/forgot",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async (req) => {
      const { email } = z
        .object({ email: z.email().transform((x) => x.toLowerCase()) })
        .parse(req.body);
      const r = await db.query("SELECT id FROM users WHERE email=$1", [email]);
      if (r.rowCount) await sendToken(r.rows[0].id, email, "reset");
      return { message: "If the account exists, a reset email has been sent." };
    },
  );
  app.post("/api/v1/auth/reset", async (req) => {
    const b = z
      .object({
        token: z.string().max(200),
        password: z.string().min(12).max(128),
      })
      .parse(req.body);
    const password = await argon2.hash(b.password);
    await transaction(async (c) => {
      const r = await c.query(
        "DELETE FROM auth_tokens WHERE token_hash=$1 AND kind='reset' AND expires_at>now() RETURNING user_id",
        [hash(b.token)],
      );
      if (!r.rowCount) throw new ApiError(400, "INVALID_TOKEN");
      await c.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
        password,
        r.rows[0].user_id,
      ]);
      await c.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [
        r.rows[0].user_id,
      ]);
    });
    return { ok: true };
  });
  app.get("/api/v1/auth/sessions", async (req) => {
    const a = await actor(req);
    if (!a.userId) throw new ApiError(403, "USER_REQUIRED");
    return (
      await db.query(
        "SELECT id,created_at,expires_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL",
        [a.userId],
      )
    ).rows;
  });
  app.delete<{ Params: { id: string } }>(
    "/api/v1/auth/sessions/:id",
    async (req) => {
      const a = await actor(req);
      uuid.parse(req.params.id);
      await db.query(
        "UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2",
        [req.params.id, a.userId],
      );
      return { ok: true };
    },
  );
  app.post("/api/v1/auth/logout", async (req) => {
    const a = await actor(req);
    await db.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
      a.sessionId,
    ]);
    return { ok: true };
  });
  app.post("/api/v1/auth/logout-all", async (req) => {
    const a = await actor(req);
    await db.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [
      a.userId,
    ]);
    return { ok: true };
  });
}
