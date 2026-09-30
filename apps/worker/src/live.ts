import { transaction } from "../../../packages/shared/src/db.js";
import { event } from "../../../packages/shared/src/events.js";
import { config } from "../../../packages/config/src/index.js";

type MediaMtxPath = {
  name?: string;
  ready?: boolean;
  online?: boolean;
  source?: unknown;
};

export async function syncLiveStreams() {
  if (!config.LIVE_INGEST_ENABLED) return;
  const response = await fetch(`${config.LIVE_MEDIAMTX_API_URL}/v3/paths/list`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error(`MEDIAMTX_API_${response.status}`);
  const payload = (await response.json()) as { items?: MediaMtxPath[] };
  const active = new Set(
    (payload.items ?? [])
      .filter(
        (item) =>
          item.name &&
          (item.online === true || item.ready === true || item.source != null),
      )
      .map((item) => item.name!),
  );

  await transaction(async (client) => {
    const streams = (
      await client.query(
        `SELECT id,workspace_id,path,status
         FROM live_streams
         WHERE status<>'disabled'
         FOR UPDATE`,
      )
    ).rows;
    for (const stream of streams) {
      const isActive = active.has(stream.path);
      if (isActive && stream.status !== "live") {
        await client.query(
          `UPDATE live_streams
           SET status='live',last_started_at=now(),updated_at=now()
           WHERE id=$1`,
          [stream.id],
        );
        await client.query(
          `INSERT INTO live_sessions(stream_id)
           SELECT $1
           WHERE NOT EXISTS(
             SELECT 1 FROM live_sessions
             WHERE stream_id=$1 AND ended_at IS NULL
           )`,
          [stream.id],
        );
        await event(client, stream.workspace_id, stream.id, "live.started", "streamId");
      }
      if (!isActive && stream.status === "live") {
        await client.query(
          `UPDATE live_streams
           SET status='ended',last_ended_at=now(),updated_at=now()
           WHERE id=$1`,
          [stream.id],
        );
        await client.query(
          `UPDATE live_sessions
           SET ended_at=now()
           WHERE stream_id=$1 AND ended_at IS NULL`,
          [stream.id],
        );
        await event(client, stream.workspace_id, stream.id, "live.ended", "streamId");
      }
    }
  });
}
