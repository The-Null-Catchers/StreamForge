import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const opaque = () => randomBytes(32).toString("base64url");
export const roles = ["viewer", "editor", "admin", "owner"] as const;
export type Role = (typeof roles)[number];
export const can = (role: Role, minimum: Role) =>
  roles.indexOf(role) >= roles.indexOf(minimum);
export function signature(secret: string, timestamp: string, body: string) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}
export function validSignature(
  secret: string,
  timestamp: string,
  body: string,
  given: string,
  now = Date.now(),
) {
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !/^[0-9a-f]{64}$/.test(given)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(signature(secret, timestamp, body), "hex"),
    Buffer.from(given, "hex"),
  );
}
export function expectedPartSize(total: number, chunk: number, part: number) {
  if (!Number.isInteger(part) || part < 0 || part >= Math.ceil(total / chunk))
    throw Error("INVALID_PART");
  return Math.min(chunk, total - part * chunk);
}
