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

Creating a version snapshots a processed replacement video's storage pointers and media metadata into the logical video's version history. The current asset is preserved as the initial version before the first replacement. Replacement media must be ready and belong to the same workspace.

```json
{
  "sourceVideoId": "processed-video-uuid",
  "label": "Client revision"
}
```

Activating a version switches the logical video's playback asset pointers back to that snapshot without changing the logical video ID.

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
