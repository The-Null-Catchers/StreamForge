import type { FastifyRequest } from "fastify";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { db } from "../../../packages/shared/src/db.js";
import { config } from "../../../packages/config/src/index.js";
import { can, hash, type Role } from "../../../packages/shared/src/security.js";
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export const uuid = z.uuid();
export const secret = new TextEncoder().encode(config.JWT_SECRET);
export const playbackSecret = new TextEncoder().encode(config.PLAYBACK_SECRET);
export type Actor = {
  userId?: string;
  sessionId?: string;
  keyId?: string;
  workspaceId?: string;
  scopes?: string[];
};
export async function actor(req: FastifyRequest): Promise<Actor> {
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  if (!token) throw new ApiError(401, "AUTH_REQUIRED");
  if (token.startsWith("sf_live_") || token.startsWith("sf_test_")) {
    const r = await db.query(
      `UPDATE api_keys k
       SET last_used_at=now()
       FROM workspaces w
       WHERE k.key_hash=$1 AND k.revoked_at IS NULL
         AND w.id=k.workspace_id AND w.deleted_at IS NULL
       RETURNING k.id,k.workspace_id,k.scopes`,
      [hash(token)],
    );
    if (!r.rowCount) throw new ApiError(401, "INVALID_KEY");
    return {
      keyId: r.rows[0].id,
      workspaceId: r.rows[0].workspace_id,
      scopes: r.rows[0].scopes,
    };
  }
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: "streamforge",
      audience: "api",
    });
    const r = await db.query(
      "SELECT user_id FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()",
      [payload.sid, payload.sub],
    );
    if (!r.rowCount) throw Error();
    return { userId: payload.sub, sessionId: payload.sid as string };
  } catch {
    throw new ApiError(401, "INVALID_SESSION");
  }
}
export async function access(
  req: FastifyRequest,
  workspace: string,
  minimum: Role = "viewer",
  scope = "videos:read",
) {
  uuid.parse(workspace);
  const a = await actor(req);
  const workspaceState = await db.query(
    "SELECT deleted_at FROM workspaces WHERE id=$1",
    [workspace],
  );
  if (workspaceState.rowCount && workspaceState.rows[0].deleted_at)
    throw new ApiError(404, "WORKSPACE_NOT_FOUND");
  if (!workspaceState.rowCount) throw new ApiError(403, "FORBIDDEN");
  if (a.keyId) {
    if (
      a.workspaceId !== workspace ||
      !a.scopes?.includes(scope) ||
      minimum === "owner" ||
      minimum === "admin"
    )
      throw new ApiError(403, "FORBIDDEN");
    return a;
  }
  const r = await db.query(
    "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
    [workspace, a.userId],
  );
  if (!r.rowCount || !can(r.rows[0].role, minimum))
    throw new ApiError(403, "FORBIDDEN");
  return a;
}
export async function videoAccess(
  req: FastifyRequest,
  id: string,
  minimum: Role = "viewer",
  scope = "videos:read",
) {
  uuid.parse(id);
  const r = await db.query(
    "SELECT * FROM videos WHERE id=$1 AND deleted_at IS NULL",
    [id],
  );
  if (!r.rowCount) throw new ApiError(404, "VIDEO_NOT_FOUND");
  await access(req, r.rows[0].workspace_id, minimum, scope);
  return r.rows[0];
}
export async function audit(
  workspace: string,
  a: Actor,
  action: string,
  target: string,
) {
  await db.query(
    "INSERT INTO audit_logs(workspace_id,actor_id,action,target_id) VALUES($1,$2,$3,$4)",
    [workspace, a.userId ?? a.keyId, action, target],
  );
}
export async function accessToken(user: string, session: string) {
  return new SignJWT({ sid: session })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user)
    .setIssuer("streamforge")
    .setAudience("api")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(secret);
}
