# tus resumable uploads

StreamForge exposes an additive tus 1.0-compatible upload endpoint at `/api/v1/tus`.

## Supported extensions

- Creation
- HEAD offset discovery
- PATCH resume/write
- Termination

Uploads use the existing 8 MiB StreamForge chunk model and feed the same media-probe pipeline used by proxy uploads. The worker verifies the complete source SHA-256 before processing.

## Creation

Send `POST /api/v1/tus` with:

- `Tus-Resumable: 1.0.0`
- `Upload-Length: <bytes>`
- `Upload-Metadata` containing base64 values for:
  - `workspaceId`
  - `videoId`
  - `filename`
  - `mimeType`
  - `checksum` (lowercase SHA-256 hex for the complete source)
- the normal StreamForge authorization header

The response is `201` with a `Location` header pointing at `/api/v1/tus/:id`.

## Resume

Use `HEAD /api/v1/tus/:id` to read `Upload-Offset` and `Upload-Length`.

PATCH requests must use `Content-Type: application/offset+octet-stream`, include `Tus-Resumable: 1.0.0` and the exact `Upload-Offset`, and send the next chunk. Chunks must align to StreamForge's 8 MiB chunk boundaries except for the final chunk.

When the final byte arrives, StreamForge automatically moves the upload to `finalizing` and enqueues media probing. No separate tus finalize call is required.

## Termination

`DELETE /api/v1/tus/:id` cancels an in-progress upload and schedules normal durable storage cleanup.

## Compatibility note

The existing `/api/v1/uploads` proxy protocol and direct S3 multipart protocol remain available. The tus endpoint is a compatibility layer over the existing durable upload state and media integrity pipeline rather than a separate storage subsystem.
