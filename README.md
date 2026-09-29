# StreamForge

**Media infrastructure, from first byte to first frame.**

StreamForge is a monorepo for resumable video ingestion, durable background processing, adaptive HLS delivery, and developer integrations. It is not a video-upload mockup or a YouTube clone: the API persists upload state, the workers run real FFprobe/FFmpeg, and the player reads the generated renditions from private object storage through expiring playback authorization.

> Initial implementation. The core workflow is implemented and media-tested. Production readiness is a deployment gate, not a label: run the full-stack CI, review the [capability matrix](docs/status.md), perform workload and security testing, and configure backups, TLS, mail, secrets, storage, and egress policy before exposing a deployment.

## Quick start

Requires Docker Engine with Compose v2, approximately 8 GB available memory, and sufficient free disk for originals plus temporary renditions. The default configuration is **local development only**.

```bash
git clone https://github.com/The-Null-Catchers/StreamForge.git
cd StreamForge
cp .env.example .env
docker compose up -d --build
```

- Dashboard: http://localhost:8080
- Development email inbox: http://localhost:8025
- Create an account, verify the Mailpit email, sign in, and create a workspace.
- Upload an MP4, MOV, WebM, or MKV. Pause and resume, or reload and select the same file to resume its server session.
- Watch processing status, open the ready video, choose Auto or a specific rendition, upload SRT/WebVTT subtitles, and copy a signed embed.
- Configure `WEBHOOK_ALLOWED_HOSTS` with your exact HTTPS receiver hostname before adding a webhook.

Generate a copyright-free test video:

```bash
sh infra/scripts/generate-sample.sh sample.mp4
# Or use the FFmpeg-equipped worker image:
docker compose exec worker sh infra/scripts/generate-sample.sh /tmp/sample.mp4
docker compose cp worker:/tmp/sample.mp4 ./sample.mp4
```

Never commit `.env` or video binaries. Originals are stored in the configured private S3 bucket, not in Git.

## Implemented core

- Argon2id passwords, email verification, reset email, short-lived access tokens, rotating refresh tokens with family revocation on reuse, per-device/all-device logout.
- Workspace ownership and role checks; invitations; audit records; hashed scoped API keys.
- 8 MiB resumable chunks persisted in S3, SHA-256 per part and whole-file verification, expiration, retries, cancellation API, quota reservation, idempotent part resend.
- PostgreSQL outbox → BullMQ workers; probing, source-aware 360p–2160p HLS, AAC audio, thumbnails and preview VTT, atomic readiness, retry/backoff and retained failed jobs.
- Authenticated SSE progress, private/unlisted/public videos, scoped expiring media tokens covering nested playlists and segments, deletion revocation.
- Browser HLS player, Auto/manual quality, speed, native accessible controls, subtitles, keyboard shortcuts, picture-in-picture, preview scrub strip, saved position.
- Idempotent playback events, plays/session/watch-time/completion/error summaries, developer SDK, signed webhooks with retries/history/resend API.
- Docker services, database migration runner, internal Prometheus endpoint, structured logs, dependency/worker readiness.
- Flutter source client with secure session storage, foreground resumable uploads, native HLS, cached metadata, and basic analytics; not a tested mobile release.

See [status and limitations](docs/status.md) for features deliberately not presented as complete.

## Repository

```text
apps/web          Next.js dashboard and embed player
apps/api          Fastify modules: auth, workspaces, uploads, videos, playback, platform
apps/worker       Outbox dispatcher, media stages, cleanup, webhook delivery
apps/mobile       Flutter client source
packages/config   Validated environment configuration
packages/shared   PostgreSQL, queues, storage, permissions, integrity, event outbox
packages/media-core  Safe process invocation, profiles, FFprobe/FFmpeg, subtitles
packages/sdk      TypeScript developer client
infra             Docker, Caddy, migrations, monitoring, test-media generation
docs              Architecture, operations, security, API and capability matrix
```

## Development and checks

Node.js 22 or newer; FFmpeg and FFprobe for media tests.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run test:media
npm run build
docker compose run --rm integration
```

`test:integration` exercises real PostgreSQL/Redis/MinIO/API/workers: registration, verified-account gating, workspace creation, integrity rejection, resumed/idempotent upload, HLS segments, subtitles, analytics, scoped keys and refresh-token reuse. Its verification fixture marks its generated user verified after checking the gate; browser/email-link E2E is still separate work.

Migrations are ordered, transactional SQL with a PostgreSQL advisory lock and applied-version table. Repeat `docker compose run --rm migrate` safely. Do not modify an already-applied migration; add a new one.

## Documentation

[Architecture](docs/architecture.md) · [Media pipeline](docs/media-pipeline.md) · [Uploads](docs/upload-system.md) · [Storage](docs/storage.md) · [HLS](docs/hls.md) · [Security](docs/security.md) · [API](docs/api.md) · [Webhooks](docs/webhooks.md) · [Deployment](docs/deployment.md) · [Scaling](docs/scaling.md) · [Status](docs/status.md)
