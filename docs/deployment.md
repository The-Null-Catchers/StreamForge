# Deployment

## Development

Copy `.env.example` to `.env`, then `docker compose up -d --build`. Compose waits for PostgreSQL/Redis, runs migrations, creates a private development bucket, and starts API, workers, web and Caddy. Mailpit captures email locally. Do not expose Mailpit or use its SMTP configuration in production.

Check:

```bash
curl -f http://localhost:8080/health
curl -f http://localhost:8080/health/ready
docker compose logs --tail=100 worker
docker compose run --rm integration
```

Readiness checks PostgreSQL, Redis, bucket access, queue connection and a worker heartbeat less than 30 seconds old. It verifies worker presence, not per-queue capacity or a synthetic successful transcode. Liveness intentionally does not depend on workers.

## Production configuration

1. Provision a private S3/R2 bucket, least-privilege credentials, database and Redis persistence/backups, and outbound SMTP.
2. Replace both JWT secrets independently using 32+ random bytes. Set a strong PostgreSQL password in both `POSTGRES_PASSWORD` and the URL. Set production storage secrets and endpoints, `NODE_ENV=production`, public HTTPS `PUBLIC_URL` and exact `WEB_ORIGIN`.
3. Replace the Caddy `:80` site label with your domain and publish ports 80/443. Point DNS to the host. Keep only Caddy public; never publish PostgreSQL/Redis/MinIO/API/metrics ports.
4. Remove development `storage-init`/Mailpit dependencies when using external storage/mail. Create the production bucket separately; the initializer specifically targets local MinIO.
5. Set worker concurrency according to CPU, RAM and ephemeral disk. The example 3 GB worker limit is a starting point, not a guarantee for 4K or six-hour media. Large originals are streamed into disk files; do not replace worker `/tmp` with a small tmpfs. Disk capacity should exceed maximum concurrent source+output working sets.
6. Configure webhook-approved hosts and network egress policy. Rotate signing/storage credentials with planned downtime or a future multi-key verifier; key IDs and rolling signing-secret rotation are not yet implemented.
7. Run migrations as a one-shot release job, validate readiness, then deploy web/API/workers. Migrations are forward-only; use backup restore or a reviewed corrective migration for rollback.

Graceful worker shutdown waits for active jobs. Compose has a two-hour grace period; forced shutdown can leave temporary files and relies on lease expiry/retry. API shutdown closes listeners and connections. Use an orchestrator with adequate termination grace, disk pressure alerts and secure non-root media isolation for production scale.

## Backups and recovery

Back up PostgreSQL and object storage consistently; Redis AOF reduces queue loss but does not replace the durable outbox. Test restoration into a separate environment. Redis loss after outbox dispatch needs an operator reconciliation/replay of incomplete videos; no automatic replay command is shipped yet. Do not clear Redis on a live deployment.

`docker compose --profile monitoring up -d` starts Prometheus. Metrics are accessible on host loopback port 9090; API `/metrics` is on internal port 9091 and blocked by Caddy. HTTP latency and process metrics are implemented; full queue/storage/failure dashboards remain work.

## Release checklist

Pass CI (including Docker full-stack integration), test browser upload interruption and actual receiver webhooks, validate mail delivery, validate production S3/R2 compatibility, run a representative media corpus including portrait/rotation and long silent content, verify backup restore, and review the capability matrix. No unattended public deployment is performed by the repository workflow.
