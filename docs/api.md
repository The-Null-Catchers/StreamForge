# REST API v1

Base: `/api/v1`. Authenticated requests use `Authorization: Bearer <access token or API key>`. JSON except raw binary upload parts. Errors return `{"error":{"code":"...","message":"...","requestId":"..."}}`. Production errors omit stack traces.

| Resource       | Operations                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Authentication | `POST /auth/register`, `/login`, `/refresh`, `/verify`, `/resend-verification`, `/forgot`, `/reset`, `/logout`, `/logout-all`               |
| Sessions       | `GET /auth/sessions`, `DELETE /auth/sessions/:id`                                                                   |
| Workspaces     | `GET/POST /workspaces`, `GET /workspaces/:id/members`, `POST /workspaces/:id/invites`, `POST /invites/accept`       |
| Membership     | `PATCH/DELETE /workspaces/:id/members/:user` (owner)                                                                |
| Workspace data | `GET /workspaces/:id/usage`, `/notifications`, `/audit_logs`, `/events`                                             |
| Videos         | `GET/POST /videos`, `GET/PATCH/DELETE /videos/:id`, `POST /videos/:id/retry`                                        |
| Uploads        | `POST /uploads`, `GET/DELETE /uploads/:id`, `PUT /uploads/:id/parts/:part`, `POST /uploads/:id/complete`            |
| Playback       | `GET /videos/:id/playback`, `GET /media/:id/*?token=...`                                                            |
| Watch position | `GET/PUT /videos/:id/progress` (user session)                                                                       |
| Subtitles      | `POST /videos/:id/subtitles`                                                                                        |
| Analytics      | `POST /analytics/events` (playback token), `GET /videos/:id/analytics`                                              |
| Keys           | `GET/POST /api-keys`, `DELETE /api-keys/:id`                                                                        |
| Webhooks       | `GET/POST /webhooks`, `DELETE /webhooks/:id`, `GET /webhooks/:id/deliveries`, `POST /webhook-deliveries/:id/resend` |

Collection routes for videos/keys/webhooks require `workspaceId`. Videos also accept `search`, `status`, `privacy`, `sort=latest|oldest|duration|size`, `limit=1..100`, `offset=0..100000`. Ordering has an ID tiebreaker; offset pagination can shift under concurrent insertion. Cursor pagination is future work.

```ts
import { StreamForge } from "@streamforge/sdk";
const sf = new StreamForge({
  apiKey: process.env.STREAMFORGE_API_KEY!,
  baseUrl: "https://streamforge.example",
});
const video = await sf.videos.create({ workspaceId, title: "Demo" });
const upload = await sf.uploads.create({
  workspaceId,
  videoId: video.id,
  filename: "demo.mp4",
  mimeType: "video/mp4",
  totalSize,
  checksum,
});
// Read at most upload.chunk_size bytes at a time; SHA-256 each chunk.
await sf.uploads.part(upload.id, 0, chunk, chunkChecksum);
await sf.uploads.complete(upload.id);
// Poll status or consume authenticated SSE, then:
const playback = await sf.playback(video.id);
```

SDK is a local monorepo workspace package, not a published npm release. Build with `npm run build` before importing its compiled entry. Never place API keys in browser bundles.

Video creation: `{workspaceId,title,privacy?}`. Metadata update: `{title,description?,privacy,tags?}`. Upload creation: `{workspaceId,videoId,filename,mimeType,totalSize,checksum}`. Subtitle upload: `{language,label,content,default?,forced?}`. API key creation: `{workspaceId,name,scopes,test?}`. Allowed scopes: `videos:read`, `videos:write`, `uploads:write`, `analytics:read`.

Unlisted links must first be minted by an authorized member/key, then the bearer token can be shared. Knowing a private/unlisted video UUID alone cannot mint a playback token. Public videos can mint tokens anonymously subject to rate limits.

## Analytics

Playback events carry `{id,token,event,position,watchSeconds?}`. IDs are client-generated UUIDs and deduplicated. Heartbeats contribute at most 15 seconds per event; other events contribute zero watch time. Heartbeats are sent every ten seconds while playing. Paused/buffering/seeking time is excluded on a best-effort client basis. Plays count play events, including resumed plays; completions count ended events. No unique-person claim is made.


## Chapters

`GET /api/v1/videos/:id/chapters` returns chapters ordered by timestamp.

`PUT /api/v1/videos/:id/chapters` atomically replaces the chapter list. Requires editor access or a `videos:write` API key.

```json
{
  "chapters": [
    { "startSeconds": 0, "title": "Introduction" },
    { "startSeconds": 134, "title": "Setup" }
  ]
}
```

Duplicate timestamps are rejected.

## Playlists

- `GET /api/v1/playlists?workspaceId=...`
- `POST /api/v1/playlists`
- `GET /api/v1/playlists/:id`
- `PATCH /api/v1/playlists/:id`
- `PUT /api/v1/playlists/:id/items`
- `DELETE /api/v1/playlists/:id`

Ordered playlist membership is replaced atomically:

```json
{
  "videoIds": ["video-uuid-1", "video-uuid-2"]
}
```

Every referenced video must be active and belong to the playlist workspace. Duplicate video IDs are rejected. Playlist deletion never deletes videos.


## Video versions

- `GET /api/v1/videos/:id/versions`
- `POST /api/v1/videos/:id/versions`
- `PUT /api/v1/videos/:id/versions/:versionId/activate`
- `DELETE /api/v1/videos/:id/versions/:versionId`

Creating a version snapshots a processed replacement video's storage pointers and media metadata into the logical video's version history. The current asset is preserved as the initial version before the first replacement. Replacement media must be ready and belong to the same workspace.

```json
{
  "sourceVideoId": "processed-video-uuid",
  "label": "Client revision"
}
```

Activating a version switches the logical video's playback asset pointers back to that snapshot without changing the logical video ID. Inactive versions can be removed. A source video cannot be deleted while another video's version history still references its media, preventing broken playback pointers.

## Review workflow

- `GET /api/v1/videos/:id/review-comments`
- `POST /api/v1/videos/:id/review-comments`
- `PATCH /api/v1/videos/:id/review-comments/:commentId`
- `PUT /api/v1/videos/:id/review-status`

Comments can be general or timestamped, can target a specific version, and can reply to an existing comment. Editors can resolve or reopen comments.

Review status values:

```text
pending
approved
changes_requested
```


## Transcript search

Subtitle uploads are converted to WebVTT and indexed as timestamped transcript segments. This works without an AI provider and supports multilingual text such as Arabic and English.

- `GET /api/v1/videos/:id/transcript?search=...&language=...`
- `GET /api/v1/transcripts/search?workspaceId=...&q=...&language=...`

The per-video endpoint can return the full timestamped transcript when `search` is omitted. Workspace search returns matching video titles, timestamps, languages, and transcript text.

Automatic speech-to-text is intentionally separate from this capability: a future `TranscriptionProvider` can populate the same transcript segment model without changing search clients.


## Automatic transcription

Start a transcription job for a ready video:

`POST /api/v1/videos/:id/transcriptions`

Body:

```json
{ "language": "auto" }
```

Supported language modes are `auto`, `ar`, and `en`. Jobs are delivered through the durable outbox to the `subtitle-processing` BullMQ queue.

List recent jobs:

`GET /api/v1/videos/:id/transcriptions`

Read one job:

`GET /api/v1/videos/:id/transcriptions/:transcriptionId`

Successful jobs create a normal subtitle track and timestamped transcript segments, so the generated text is immediately available through the existing transcript search APIs and secure playback subtitle metadata.

Provider configuration:

- `TRANSCRIPTION_PROVIDER=openai-compatible`
- `TRANSCRIPTION_BASE_URL=https://api.openai.com/v1`
- `TRANSCRIPTION_API_KEY=...`
- `TRANSCRIPTION_MODEL=whisper-1`
- `TRANSCRIPTION_CHUNK_SECONDS=600`

The worker extracts mono 16 kHz audio with FFmpeg, chunks long media before provider calls, merges timestamps, generates WebVTT, and persists the subtitle/transcript atomically.


## AI media helpers

AI helpers use the existing indexed transcript as their only content source. They can generate a summary, metadata suggestions, chapter suggestions, or all of them together.

Start a generation:

`POST /api/v1/videos/:id/ai-generations`

Example:

```json
{
  "kind": "all",
  "language": "auto"
}
```

Supported kinds are `summary`, `metadata`, `chapters`, and `all`. Supported language modes are `auto`, `ar`, and `en`.

List recent generations:

`GET /api/v1/videos/:id/ai-generations`

Read one generation:

`GET /api/v1/videos/:id/ai-generations/:generationId`

Apply a completed generation explicitly:

`POST /api/v1/videos/:id/ai-generations/:generationId/apply`

```json
{
  "metadata": true,
  "chapters": true
}
```

Generation never changes the video automatically. Metadata and chapters are only written after the explicit apply request.

Provider configuration:

- `AI_PROVIDER=openai-compatible`
- `AI_BASE_URL=https://api.openai.com/v1`
- `AI_API_KEY=...`
- `AI_MODEL=gpt-4.1-mini`
- `AI_MAX_TRANSCRIPT_CHARS=60000`

Jobs are dispatched through the durable outbox to the dedicated `ai` BullMQ queue. AI failures are isolated from the media processing lifecycle and never mark the underlying video as failed.


## Live ingest

StreamForge uses MediaMTX as the protocol edge while StreamForge remains the source of truth for workspace permissions, hashed stream keys, session state and webhooks. MediaMTX supports external HTTP authentication and exposes RTMP, SRT, HLS and a Control API.

Create a stream:

`POST /api/v1/live-streams`

```json
{
  "workspaceId": "workspace-uuid",
  "name": "Launch event"
}
```

The response contains the stream key and ingest URLs once. Only the SHA-256 hash of the stream key is persisted.

List workspace streams:

`GET /api/v1/live-streams?workspaceId=:workspaceId`

Inspect a stream and recent sessions:

`GET /api/v1/live-streams/:id`

Rotate the publish key:

`POST /api/v1/live-streams/:id/rotate-key`

Generate a short-lived signed HLS playback URL:

`GET /api/v1/live-streams/:id/playback`

Disable a stream:

`DELETE /api/v1/live-streams/:id`

### OBS / RTMP

Use the returned `rtmpServer` as the server and `rtmpStreamKey` as the stream key. MediaMTX accepts tokens on RTMP URLs and supports external HTTP authorization.

### SRT

The API returns an SRT URL that encodes the MediaMTX publish stream ID and stream credential. MediaMTX supports SRT publish URLs and credential-bearing stream IDs.

### HLS

HLS is reverse-proxied through Caddy under `/live/*`. Playback requires a StreamForge-issued token with a 15-minute TTL. MediaMTX calls `POST /api/v1/live/auth` to authorize publishing and reading.

### Session lifecycle and recording

A successful publisher authentication opens a StreamForge live session and emits `live.started`. The worker polls the MediaMTX Control API and closes sessions that disappear, emitting `live.ended`. Recording is enabled in MediaMTX and stored in the isolated `live_recordings` volume as fragmented MP4 segments. MediaMTX supports automatic recording and its Control API exposes recordings by path.

Live-to-VOD import into object storage remains separate work; recordings are not currently promoted into the normal VOD video pipeline automatically.


### Live-to-VOD promotion

Live streams can automatically promote completed recordings into normal StreamForge VOD assets.

When a live session ends:

1. the session moves to `queued` promotion state,
2. the durable outbox emits a `live-import` job,
3. the worker finds the fMP4 recording segments that overlap the session window,
4. multiple segments are concatenated losslessly with FFmpeg,
5. the recording is probed and checksummed,
6. workspace storage and video quotas are revalidated,
7. the source is copied into object storage,
8. a normal private video is created,
9. the existing `video-transcode` pipeline continues with renditions, thumbnails and HLS packaging.

Completed promotions emit `live.vod.created` and create an in-app notification.

Create streams with promotion disabled when required:

```json
{
  "workspaceId": "workspace-uuid",
  "name": "Launch event",
  "autoCreateVod": false
}
```

Update the setting later:

`PATCH /api/v1/live-streams/:id`

```json
{
  "autoCreateVod": true
}
```

Each live-session response includes `promotion_status`, `recording_video_id`,
`promotion_error`, and `promoted_at`.

Failed or skipped promotions can be explicitly requeued:

`POST /api/v1/live-streams/:id/sessions/:sessionId/retry-promotion`

Promotion failures are isolated from the live stream and from the normal VOD media
pipeline. A failed import does not mark an unrelated video as failed.


### Live resilience and adaptive HLS

Each live stream now exposes independent primary and backup ingest credentials. Publishers can stay connected to both inputs; StreamForge always prefers the primary input and automatically switches the transcoder to backup when primary disappears.

Create a stream with a live profile and DVR window:

```json
{
  "workspaceId": "workspace-uuid",
  "name": "Launch event",
  "liveProfile": "standard",
  "dvrWindowSeconds": 600,
  "autoCreateVod": true
}
```

Profiles:

- `source` — source-quality HLS with no video re-encode.
- `standard` — adaptive ladder up to 360p and 720p, constrained by source height.
- `high` — adaptive ladder up to 360p, 720p and 1080p, constrained by source height.

The dedicated `live-transcoder` service reads the selected MediaMTX input over the internal RTSP network and writes a master HLS playlist plus variant playlists into the isolated `live_hls` volume. FFmpeg runs outside the API and VOD worker processes with separate CPU and memory limits.

DVR retention is implemented through the HLS media playlist length. StreamForge uses 2-second segments and derives the retained segment count from each stream's `dvrWindowSeconds` value. MediaMTX documents that retained HLS segments allow clients to seek backward through a live stream. The StreamForge transcoder preserves this window when failing over between primary and backup feeds.

Playback URLs put the short-lived live JWT in the URL path rather than only on the master-playlist query string. Relative variant and segment requests therefore retain authorization. Caddy validates the token through `GET /api/v1/live/playback-auth` and strips the token portion before serving files from the HLS volume.

Failover lifecycle webhooks:

- `live.failover` — primary disappeared and backup became active.
- `live.primary.restored` — primary returned and became active again.

The final program feed is also segmented into hourly MP4 recordings. Live-to-VOD promotion imports this program recording, so concurrently connected redundant ingest feeds never produce duplicate VOD content.


### Live usage and quotas

Each workspace has two live-stream limits:

- `live_concurrency_limit` — maximum number of logical live streams that can be active at once.
- `live_minutes_monthly_limit` — maximum live minutes consumed in the current calendar month. A value of `0` disables the monthly-minute cap.

Publish authentication checks both limits transactionally before opening a new live session. Primary and backup publishers for the same logical stream do not consume two concurrency slots.

When a live session ends, StreamForge writes one idempotent `usage_records` entry with kind `live_seconds`. The idempotency key is derived from the live-session ID, so reconciliation or repeated end processing cannot double bill a session.

Workspace usage:

`GET /api/v1/workspaces/:id/usage`

The response now includes:

- `active_live_streams`
- `live_concurrency_limit`
- `live_seconds_this_month`
- `live_minutes_monthly_limit`

Monthly usage includes both finalized session records and elapsed time from currently active sessions, so the publish gate cannot be bypassed by keeping long sessions open until month-end accounting.


## Operations diagnostics

Workspace admins can inspect a scoped operational snapshot:

`GET /api/v1/workspaces/:id/operations`

The response contains:

- database, Redis and object-storage health,
- recent worker-heartbeat count,
- BullMQ waiting/active/delayed/failed counts by queue,
- workspace processing-job states,
- live-stream state and active-ingest counts,
- recent failed processing jobs,
- recent failed webhook deliveries,
- source/output storage footprint,
- finalized live usage.

This endpoint is intentionally workspace scoped and requires the `admin` role.

### Prometheus and Grafana

The monitoring stack is opt-in:

```bash
docker compose --profile monitoring up -d prometheus grafana
```

Prometheus loads `infra/monitoring/alerts.yml` and scrapes the internal API metrics listener on port `9091`. Grafana is provisioned with the Prometheus datasource and the `StreamForge Operations` dashboard.

Grafana binds to `127.0.0.1:3001` by default and requires the configured admin credentials. Prometheus also binds to loopback only. Neither service is routed through the public Caddy listener.

Before production deployment, replace `GRAFANA_ADMIN_PASSWORD` and tune storage/queue alert thresholds to match the actual workspace plans and capacity.
