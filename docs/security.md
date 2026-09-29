# Security model and release gates

## Implemented boundaries

- Argon2id password hashing; verified email before login; one-use verification/reset token hashes with expiry.
- Fifteen-minute access JWTs backed by live session records. Thirty-day refresh families rotate transactionally; detected reuse revokes the family. Reset revokes all sessions.
- Bearer auth avoids ambient authentication-cookie CSRF. Web tokens live in sessionStorage; mobile refresh tokens use platform secure storage. XSS remains a token-theft risk, so do not render arbitrary HTML. Add a nonce-based CSP before public deployment.
- Every private video and upload operation checks current workspace role or scoped key. Owner-only role changes/removal prevent removal/demotion of the sole owner. Keys cannot administer memberships, keys or webhooks.
- API keys are random and stored as SHA-256 hashes; raw keys are displayed once. `sf_test_` is a label only; it is not an isolated billing/sandbox environment.
- Zod request validation, UUID checks, bounded body/chunk sizes, bounded pagination, strict CORS and Redis-backed rate limits. Caddy is the one trusted proxy hop; do not expose the API listener directly to an untrusted network.
- Signed playback with audience, expiry, video/generation scope and strict path allowlist. No public object bucket. Token URLs are excluded from normal request logs by disabling automatic URL logging. Protect error logs and configure any added proxy/CDN not to log query secrets.
- FFmpeg uses `spawn` argument arrays, no shell. Input formats are restricted to MOV/MP4 and Matroska/WebM; network input protocols are disabled. Treat demuxer/codec vulnerabilities as real: maintain patched FFmpeg, non-root workers, memory/CPU/PID limits and outbound network filtering.
- Webhooks require an operator-approved exact HTTPS hostname, resolve only public addresses, pin the checked IP for delivery while preserving TLS hostname verification, reject redirects, and use request timeouts. HMAC SHA-256 signs timestamp plus exact body; receivers must check replay window and delivery ID.
- Audit records cover key management, invitations/member updates, video updates/deletion and webhook creation/disabling.

## Operational gates

Use separate high-entropy signing secrets and scoped storage credentials. Require HTTPS and real SMTP in production. Restrict network access to PostgreSQL, Redis, S3, metrics and worker egress. Encrypt webhook secrets/database backups at rest; this implementation stores outbound webhook secrets in PostgreSQL because signing requires access to them. KMS envelope encryption is not implemented.

Run the full-stack suite, test failed/expired upload recovery and storage exhaustion, review dependency advisories, test restore from backups, and run device/browser accessibility checks. No claim is made of penetration testing, multi-region resilience, formal compliance, DRM, antivirus scanning, or complete abuse prevention.

Analytics are minimal first-party event counts. They do not fingerprint viewers, collect IP-derived geography or claim unique-person accuracy. A playback session is not a unique person. Client telemetry is untrusted and not suitable for billing. Retention currently deletes raw events after 90 days; daily durable rollups are not yet implemented.

Report suspected security problems privately to the repository owners. Do not include credentials or private media URLs in public issues.
