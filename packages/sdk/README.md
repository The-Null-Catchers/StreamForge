# @streamforge/sdk

TypeScript SDK for StreamForge.

## Install

```bash
npm install @streamforge/sdk
```

## Create a client

```ts
import { StreamForge } from "@streamforge/sdk";

const streamforge = new StreamForge({
  apiKey: process.env.STREAMFORGE_API_KEY!,
  baseUrl: "https://streamforge.example.com",
});
```

The SDK accepts either a StreamForge scoped API key or another bearer credential accepted by the API.

## Videos

```ts
const video = await streamforge.videos.create({
  workspaceId: "workspace-uuid",
  title: "Product launch",
  privacy: "private",
});

const videos = await streamforge.videos.list("workspace-uuid");
```

## Resumable uploads

Use `uploads.create`, `uploads.part`, and `uploads.complete` to implement resumable chunked uploads. Each part requires its SHA-256 checksum.

## Live streaming

```ts
const live = await streamforge.live.create({
  workspaceId: "workspace-uuid",
  name: "Launch",
  liveProfile: "standard",
  dvrWindowSeconds: 600,
});

console.log(live.ingest.primaryRtmpStreamKey);
console.log(live.ingest.backupRtmpStreamKey);
```

## Analytics, transcripts, and AI

The client includes playback analytics, transcript search, automatic transcription, AI media helpers, playlists, versions, review comments, and live-to-VOD controls.

## API contract

The canonical OpenAPI 3.1 contract is available from a running StreamForge API at:

`GET /api/openapi.json`

The source contract lives in `docs/openapi.json`.
