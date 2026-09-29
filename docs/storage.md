# Storage

`ObjectStorage` exposes `put/get/delete/exists/getSignedUrl`. `S3Storage` implements the interface through the AWS SDK, accepting configurable endpoint, region, credentials, bucket, and path-style addressing. MinIO and R2 use the same S3-compatible implementation; no provider-specific code is needed in media stages.

```text
workspaces/{workspace UUID}/videos/{video UUID}/
  parts/{part number}
  source/source.bin
  outputs/{generation UUID}/
    hls/master.m3u8
    hls/360p/index.m3u8
    hls/360p/segment-00000.ts
    thumbnails/poster.jpg
    thumbnails/0001.jpg
    thumbnails/previews.vtt
  subtitles/{subtitle UUID}.vtt
```

User filenames are metadata only. All identifiers are server-generated UUIDs. A generation prefix permits retries to overwrite the same assets without exposing partial output. Only ready videos can be delivered. A complete new processing attempt creates a new generation prefix; delete cleanup removes every prefix under the logical video, including failed attempts.

The development initializer creates a private bucket. Production must create its bucket and restricted service credentials independently; do not use MinIO root credentials for an Internet deployment. Enable TLS, bucket encryption as required, object lifecycle/backup policy and capacity alerts. An origin bucket must not be public.

Soft deletion revokes API media access immediately, then cleanup deletes the entire video prefix, including the source. Analytics remain for the configured implementation retention of 90 days. Source retention policy is not yet selectable. Object deletion failures are retried; monitor final failed cleanup jobs.

S3 presigning is available on the adapter but deliberately not returned as permanent browser URLs. Current delivery proxies authorized bytes through the API; CDN edge token enforcement is an extension point, not already deployed CDN integration.

## Development MinIO image

MinIO community distribution moved to source-only. The development image builds the pinned `RELEASE.2025-10-15T17-29-55Z` source with Go and includes its AGPL license. The Node AWS SDK initializes a private bucket, avoiding unavailable historical Docker Hub server/client images. See the [upstream repository](https://github.com/minio/minio) for maintenance and licensing status. For production, use an actively maintained managed S3-compatible service or a separately reviewed storage deployment.
