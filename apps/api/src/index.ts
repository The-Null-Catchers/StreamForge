import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { Registry, collectDefaultMetrics, Histogram } from "prom-client";
import { db } from "../../../packages/shared/src/db.js";
import { redis, queues } from "../../../packages/shared/src/queues.js";
import { storage } from "../../../packages/shared/src/storage.js";
import { config } from "../../../packages/config/src/index.js";
import { authRoutes } from "./auth.js";
import { workspaceRoutes } from "./workspaces.js";
import { videoRoutes } from "./videos.js";
import { uploadRoutes } from "./uploads.js";
import { playbackRoutes } from "./playback.js";
import { platformRoutes } from "./platform.js";
import { collectionRoutes } from "./collections.js";
import { reviewRoutes } from "./review.js";
import { transcriptRoutes } from "./transcripts.js";
import { transcriptionRoutes } from "./transcriptions.js";
import { aiRoutes } from "./ai.js";
import { access } from "./context.js";
export const app = Fastify({
  trustProxy: (_address, hop) => hop < 1,
  logger: {
    level: "info",
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "body.password",
      "body.refreshToken",
      "body.token",
    ],
  },
  disableRequestLogging: true,
  bodyLimit: 1048576,
  requestTimeout: 120000,
});
const registry = new Registry();
collectDefaultMetrics({ register: registry });
const latency = new Histogram({
  name: "streamforge_http_seconds",
  help: "Request duration",
  labelNames: ["route", "method", "status"],
  registers: [registry],
});
await app.register(cors, {
  origin: config.WEB_ORIGIN,
  allowedHeaders: ["Content-Type", "Authorization", "X-Checksum-Sha256"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});
await app.register(rateLimit, { max: 300, timeWindow: "1 minute", redis });
app.addHook("onResponse", async (req, reply) => {
  latency.observe(
    {
      route: req.routeOptions.url ?? "unknown",
      method: req.method,
      status: reply.statusCode,
    },
    reply.elapsedTime / 1000,
  );
  req.log.info(
    {
      requestId: req.id,
      route: req.routeOptions.url,
      statusCode: reply.statusCode,
    },
    "request completed",
  );
});
app.setErrorHandler((error, req, reply) => {
  const e = error as Error & { statusCode?: number; code?: string };
  const status = error instanceof ZodError ? 400 : (e.statusCode ?? 500);
  if (status >= 500)
    req.log.error({ requestId: req.id, err: e }, "request failed");
  reply.code(status).send({
    error: {
      code:
        error instanceof ZodError
          ? "VALIDATION_ERROR"
          : status >= 500
            ? "INTERNAL_ERROR"
            : (e.code ?? "REQUEST_FAILED"),
      message:
        status >= 500 ? "The request could not be completed." : e.message,
      requestId: req.id,
    },
  });
});
app.get("/health", async () => ({ status: "ok", service: "streamforge-api" }));
app.get("/health/ready", async (_req, reply) => {
  try {
    await Promise.all([
      db.query("SELECT 1"),
      redis.ping(),
      storage.ready(),
      queues["media-probe"].waitUntilReady(),
    ]);
    const workers = await redis.zrangebyscore(
      "streamforge:workers",
      Date.now() - 30000,
      "+inf",
    );
    if (!workers.length) throw Error("NO_WORKERS");
    return { status: "ready" };
  } catch {
    return reply.code(503).send({ status: "not_ready" });
  }
});
// Metrics are bound to an internal listener and are never proxied by Caddy.
const metrics = Fastify();
metrics.get("/metrics", async (_r, reply) =>
  reply.type(registry.contentType).send(await registry.metrics()),
);
await metrics.listen({ port: 9091, host: "0.0.0.0" });
await authRoutes(app);
await workspaceRoutes(app);
await videoRoutes(app);
await uploadRoutes(app);
await playbackRoutes(app);
await platformRoutes(app);
await collectionRoutes(app);
await reviewRoutes(app);
await transcriptRoutes(app);
await transcriptionRoutes(app);
await aiRoutes(app);
app.get<{ Params: { id: string } }>(
  "/api/v1/workspaces/:id/events",
  async (req, reply) => {
    await access(req, req.params.id);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    req.raw.on("close", () => {
      closed = true;
    });
    let ticks = 0;
    while (!closed && ticks++ < 60) {
      try {
        await access(req, req.params.id);
        const rows = (
          await db.query(
            "SELECT id,status,progress,error_code,updated_at FROM videos WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100",
            [req.params.id],
          )
        ).rows;
        reply.raw.write(`event: videos\ndata: ${JSON.stringify(rows)}\n\n`);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    reply.raw.end();
  },
);
await app.listen({ port: config.PORT, host: "0.0.0.0" });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all([app.close(), metrics.close()]);
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await redis.quit();
  await db.end();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
