import { randomUUID } from "node:crypto";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { storage } from "../../../packages/shared/src/storage.js";

let objectStoreCursor: string | null = null;

export async function reconcileOutputAccounting() {
  const result = await db.query(
    `WITH expected AS (
       SELECT
         v.id,
         coalesce(sum(ur.amount) FILTER (WHERE ur.kind='output_bytes'),0)::bigint AS bytes
       FROM videos v
       LEFT JOIN usage_records ur ON ur.video_id=v.id
       WHERE v.deleted_at IS NULL
       GROUP BY v.id
     ), corrected AS (
       UPDATE videos v
       SET output_bytes=e.bytes,updated_at=now()
       FROM expected e
       WHERE v.id=e.id AND v.output_bytes<>e.bytes
       RETURNING v.id
     )
     SELECT count(*)::int AS corrected FROM corrected`,
  );
  const ledgerCorrected = Number(result.rows[0]?.corrected ?? 0);
  const objectStore = await reconcileObjectStoreOutputUsage(objectStoreCursor);
  objectStoreCursor = objectStore.nextCursor;
  return ledgerCorrected + objectStore.corrected;
}

export type ObjectStoreReconcileResult = {
  scanned: number;
  corrected: number;
  nextCursor: string | null;
};

export async function reconcileObjectStoreOutputUsage(
  afterId: string | null,
  limit = 25,
): Promise<ObjectStoreReconcileResult> {
  const videos = (
    await db.query(
      `SELECT id,workspace_id,output_prefix,output_bytes
       FROM videos
       WHERE deleted_at IS NULL
         AND output_prefix IS NOT NULL
         AND status IN ('ready','failed')
         AND ($1::uuid IS NULL OR id > $1::uuid)
       ORDER BY id
       LIMIT $2`,
      [afterId, limit],
    )
  ).rows as Array<{
    id: string;
    workspace_id: string;
    output_prefix: string;
    output_bytes: string | number;
  }>;

  if (!videos.length)
    return { scanned: 0, corrected: 0, nextCursor: afterId ? null : afterId };

  let corrected = 0;
  for (const video of videos) {
    const objects = await storage.listPrefix(video.output_prefix);
    const actualBytes = objects.reduce((sum, object) => sum + object.size, 0);
    if (actualBytes === Number(video.output_bytes)) continue;

    const changed = await transaction(async (client) => {
      const current = (
        await client.query(
          "SELECT output_bytes FROM videos WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
          [video.id],
        )
      ).rows[0];
      if (!current) return false;
      const trackedBytes = Number(current.output_bytes);
      const delta = actualBytes - trackedBytes;
      if (!delta) return false;
      await client.query(
        `INSERT INTO usage_records(
           workspace_id,video_id,kind,amount,idempotency_key
         ) VALUES($1,$2,'output_bytes',$3,$4)`,
        [
          video.workspace_id,
          video.id,
          delta,
          `object-store-reconcile:${video.id}:${randomUUID()}`,
        ],
      );
      await client.query(
        "UPDATE videos SET output_bytes=$1,updated_at=now() WHERE id=$2",
        [actualBytes, video.id],
      );
      return true;
    });
    if (changed) corrected++;
  }

  return {
    scanned: videos.length,
    corrected,
    nextCursor: videos.length < limit ? null : videos[videos.length - 1]!.id,
  };
}
