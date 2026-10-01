# Capability matrix and verification scope

This document distinguishes code that performs real work from design groundwork and future work. It is not a claim that every item in the original product brief is finished.

| Area          | Current implementation                                                                                                       | Remaining work                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Auth          | Registration, verification/reset email, rotating refresh families, sessions and logout APIs                                  | Hardened CSP, external auth/security review                                            |
| Workspaces    | Membership roles, owner-only role/remove API, invitation token acceptance, audit/notification API                            | Invitation email delivery, richer member-management UI, owner transfer                                  |
| Uploads       | Real 8 MiB chunks, checksums, durable status, resume/retry, pause UI, cancel API, expiry                                     | Cancel UI, duplicate warning UI, tus compatibility, direct S3 multipart                                 |
| Media         | Real FFprobe, source-aware H.264/AAC HLS, poster, timeline images/VTT                                                        | Configurable profiles, multitrack audio, manual poster, sprites, CMAF                                   |
| Reliability   | Outbox, idempotent stages, leases, backoff, timeouts, progress, soft-delete cleanup                                          | Automatic Redis-loss reconciliation, stale-temp janitor, dedicated worker pools                         |
| Playback      | Signed playlist/segment access, current-state delete revocation, ABR/manual HLS.js, seek/speed/PiP, keyboard, saved position | Automatic token renewal, shared-embed subtitle metadata, domain restrictions, mobile subtitle selection |
| Library       | Actual API-driven grid/table, search, status filter, detail and metadata                                                     | Duration/resolution/date/privacy filters; API supports privacy and sorting       |
| Analytics     | Playback events/dedupe, plays, unique viewers, watch time, completion %, startup timing, buffering metrics, active viewers/live quality split, BullMQ daily rollups, dashboard charts, and coarse privacy-safe device/browser/OS breakdown | Privacy-safe country aggregation and longer-term aggregate retention tuning |
| Developer     | Hashed scoped keys, local TypeScript SDK, HMAC webhook retries/history/resend API                                            | Published SDK package, OpenAPI spec, full webhook-browser E2E                                           |
| Quotas        | Source-byte reservation, video-count enforcement, output-byte ledger, live concurrency limits, monthly live-minute enforcement and idempotent live-session accounting | Output/monthly upload and processing-compute enforcement plus reconciliation |
| Notifications | Verification/reset email; in-app ready/failure messages                                                                      | Media-status email, quota notices, per-user read state, push                                            |
| Observability | JSON logs, HTTP/process Prometheus metrics, dependency readiness and worker heartbeat                                        | Queue/storage/job counters, dashboards, internal admin console                                          |
| Flutter       | Source login/workspaces/cache/resumable foreground upload/HLS/progress/basic analytics                                       | Platform generation and device verification, OS background transfers, subtitles, push, SSE              |
| Advanced      | Chapters API/UI, ordered playlists, versions/review, transcript search, Whisper-compatible transcription, transcript-grounded AI helpers, authenticated RTMP/SRT ingest, automatic live-to-VOD, redundant primary/backup ingest, FFmpeg multi-bitrate live HLS, configurable DVR and failover webhooks | Speaker diarization/translation, multi-region ingest, hardware-accelerated live transcoding and origin/CDN failover |

## Local verification

- TypeScript checks and Next.js production build are run during implementation.
- Unit tests cover permissions, no-upscale profiles, chunk boundaries, integrity/HMAC verification, replay window and Arabic subtitle conversion.
- Real FFmpeg tests generate a short 720p clip, produce three renditions, decode each playlist, generate poster/preview assets, and process a silent small source.
- The Docker stack test covers real services and the core API/media workflow. Consult the repository's current CI status; local build success alone does not prove Docker startup.
- Flutter source is not claimed to have passed `flutter analyze` or device tests in an environment without Flutter.
- A full browser automation/accessibility suite and a public HTTPS webhook receiver test remain outstanding.

The initial release should be treated as a reviewable implementation of the core workflow, not a certification of production readiness or completion of all six phases.
