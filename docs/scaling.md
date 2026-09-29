# Scaling and reliability

```bash
docker compose up -d --scale worker=4
```

There is no fixed worker container name. Each replica runs consumers for probe, transcode, thumbnail, packaging, webhook and cleanup queues plus a cooperative outbox dispatcher. `TRANSCODE_CONCURRENCY` applies per replica. Independent queue-only worker deployments, GPU scheduling and queue priority classes are not yet exposed by configuration.

API replicas share PostgreSQL, Redis and object storage; upload chunks do not depend on local API disk. Row locking serializes parts per upload and workspace quota reservations. It is intentional correctness-first backpressure; very high-throughput uploads may need S3 multipart/tus and a separate lease design.

Media stages serialize per video, while distinct videos process concurrently. FFmpeg uses two codec threads per rendition. Account for probe/thumbnail processes as well as transcode concurrency. Do not assume `replicas × concurrency` equals the only CPU load. Each stage downloads the source; this trades network traffic for clear restartable stage boundaries.

The current origin API proxies every segment and checks video state on every media request. This supports immediate delete revocation and simple private storage but can become a throughput bottleneck. For production CDN scale, move token validation and path scoping to an edge, establish cache-key rules that preserve authorization, use private origin authentication, and implement explicit revocation semantics. Do not merely strip tokens from cache keys or make the bucket public.

SSE currently polls PostgreSQL per open connection; move to a Redis pub/sub invalidation layer plus current-state snapshots at higher fan-out. Playback analytics currently writes raw events; batch through the reserved analytics queue and maintain daily rollups before large-volume deployment.

Outstanding billing-ready work: generated-byte quota enforcement, monthly upload/stream/processing budgets, true bandwidth accounting, rollups, retention configuration, usage reconciliation and billing events. The current UI labels original/source bytes accurately and does not pretend these advanced quotas are enforced.
