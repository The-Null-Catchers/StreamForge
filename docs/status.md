# Capability matrix and verification scope

This document distinguishes code that performs real work from design groundwork and future work. It is not a claim that every item in the original product brief is finished.

| Area          | Current implementation                                                                                                       | Remaining work                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Auth          | Registration, verification/reset email, rotating refresh families, sessions/logout APIs, nonce-based CSP and browser security headers | External auth/security review |
| Workspaces    | Membership roles, member-management UI, owner-only role/remove API, atomic owner transfer with single-owner DB invariant, invitation email delivery/link acceptance, audit/notification API | Pending-invite revocation and workspace rename/delete UX |
| Uploads       | Real 8 MiB chunks, checksums, durable status, resume/retry, pause/cancel UI, resumed-session duplicate warning, cancel API, expiry | tus compatibility, direct S3 multipart |
| Media         | Real FFprobe, source-aware H.264/AAC HLS, selectable data-saver/balanced/high-quality transcoding profiles with profile-aware compute accounting, poster, timeline images/VTT | Multitrack audio, manual poster, sprites, CMAF |
| Reliability   | Durable outbox with completion acknowledgements and Redis-loss reconciliation, idempotent stages, leases, backoff, timeouts, progress, soft-delete cleanup, periodic stale worker-temp janitor, dedicated media/control worker pools | Pool autoscaling and per-queue SLO tuning |
| Playback      | Signed playlist/segment access, current-state delete revocation, automatic token renewal, shared-embed subtitle metadata, per-video embed origin restrictions, ABR/manual HLS.js, seek/speed/PiP, keyboard, saved position | Mobile subtitle selection |
| Library       | Actual API-driven grid/table, search, status filter, detail and metadata                                                     | Duration/resolution/date/privacy filters; API supports privacy and sorting       |
| Analytics     | Playback events/dedupe, plays, unique viewers, watch time, completion %, startup timing, buffering metrics, active viewers/live quality split, BullMQ daily rollups, dashboard charts, and coarse privacy-safe device/browser/OS breakdown | Privacy-safe country aggregation and longer-term aggregate retention tuning |
| Developer     | Hashed scoped keys, HMAC webhook retries/history/resend, OpenAPI 3.1 contract served by API and CI-validated, self-contained publish-ready TypeScript SDK with npm-pack validation and tagged release workflow | Actual npm publication/registry ownership and full webhook-browser E2E |
| Quotas        | Source-byte reservation, video-count enforcement, exact monthly uploaded-byte enforcement with serialized workspace accounting, current output-storage enforcement across HLS/thumbnails with per-video accounting, deterministic monthly encode-second reservations for processing compute, output-byte ledger reconciliation, live concurrency limits, monthly live-minute enforcement, owner quota administration API/page and idempotent live-session accounting | Object-store-level reconciliation and hosted-plan entitlement integration |
| Notifications | Verification/reset email, in-app ready/failure messages, idempotent 80/90/100% quota warnings reset by billing period or quota change | Media-status email, per-user read state, push |
| Observability | JSON logs, dependency readiness, worker heartbeat, HTTP/process metrics, BullMQ queue gauges, processing/live/storage gauges, Prometheus alert rules, provisioned Grafana dashboard, workspace-admin Operations console, output accounting drift reporting | External alert routing, SLO dashboards and centralized log aggregation |
| Flutter       | Source login/workspaces/cache/resumable foreground upload/HLS/progress/basic analytics                                       | Platform generation and device verification, OS background transfers, subtitles, push, SSE              |
| Advanced      | Chapters API/UI, ordered playlists, versions/review, transcript search, Whisper-compatible transcription, transcript-grounded AI helpers, authenticated RTMP/SRT ingest, automatic live-to-VOD, redundant primary/backup ingest, FFmpeg multi-bitrate live HLS, configurable DVR and failover webhooks | Speaker diarization/translation, multi-region ingest, hardware-accelerated live transcoding and origin/CDN failover |

## Local verification

- TypeScript checks and Next.js production build are run during implementation.
- Unit tests cover permissions, no-upscale profiles, configurable profile ladders, chunk boundaries, integrity/HMAC verification, replay window and Arabic subtitle conversion.
- Real FFmpeg tests generate a short 720p clip, produce renditions, decode each playlist, generate poster/preview assets, and process a silent small source.
- The Docker stack test covers real services and the core API/media workflow. Consult the repository's current CI status; local build success alone does not prove Docker startup.
- Flutter source is not claimed to have passed `flutter analyze` or device tests in an environment without Flutter.
- A full browser automation/accessibility suite and a public HTTPS webhook receiver test remain outstanding.

The initial release should be treated as a reviewable implementation of the core workflow, not a certification of production readiness or completion of all six phases.
