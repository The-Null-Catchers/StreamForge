import { db } from "../../../packages/shared/src/db.js";

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
  return Number(result.rows[0]?.corrected ?? 0);
}
