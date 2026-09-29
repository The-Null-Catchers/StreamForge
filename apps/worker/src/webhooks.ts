import { lookup } from "node:dns/promises";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { db } from "../../../packages/shared/src/db.js";
import { config } from "../../../packages/config/src/index.js";
import { signature } from "../../../packages/shared/src/security.js";
export function publicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export async function deliver(deliveryId: string) {
  const r = await db.query(
    "SELECT d.*,w.url,w.secret,w.enabled FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE d.id=$1",
    [deliveryId],
  );
  const d = r.rows[0];
  if (!d || !d.enabled || d.status === "delivered") return;
  const url = new URL(d.url);
  if (
    url.protocol !== "https:" ||
    !config.WEBHOOK_ALLOWED_HOSTS.split(",").includes(url.hostname)
  )
    throw Error("WEBHOOK_HOST_NOT_ALLOWED");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw Error("WEBHOOK_PRIVATE_ADDRESS");
  const pinned = addresses[0];
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ id: d.id, ...d.payload });
  const status = await new Promise<number>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        timeout: 10000,
        lookup: (_hostname, _options, cb) =>
          cb(null, pinned.address, pinned.family),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-StreamForge-Id": d.id,
          "X-StreamForge-Timestamp": timestamp,
          "X-StreamForge-Signature": `v1=${signature(d.secret, timestamp, body)}`,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 500);
      },
    );
    req.on("timeout", () => req.destroy(Error("WEBHOOK_TIMEOUT")));
    req.on("error", reject);
    req.end(body);
  });
  await db.query(
    "UPDATE webhook_deliveries SET attempts=attempts+1,response_status=$1,status=$2 WHERE id=$3",
    [
      status,
      status >= 200 && status < 300 ? "delivered" : "failed",
      deliveryId,
    ],
  );
  if (status < 200 || status >= 300) throw Error("WEBHOOK_REJECTED");
}
