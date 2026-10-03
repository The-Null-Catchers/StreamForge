import { transaction } from "../../../packages/shared/src/db.js";

export function crossedThresholds(used: number, limit: number) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used < 0 || limit < 0)
    return [] as number[];
  if (limit === 0) return used > 0 ? [80, 90, 100] : [];
  const pct = (used / limit) * 100;
  return [80, 90, 100].filter((threshold) => pct >= threshold);
}

type QuotaMetric = {
  key: string;
  label: string;
  used: number;
  limit: number;
  periodKey: string;
};

function periodKey(month: string | null, limit: number) {
  return `${month ?? "current"}:${limit}`;
}

export async function emitQuotaNotices() {
  return transaction(async (c) => {
    const rows = (
      await c.query(
        `SELECT
           w.id,
           w.storage_limit,
           w.video_limit,
           w.upload_bytes_monthly_limit,
           w.output_storage_limit,
           w.processing_seconds_monthly_limit,
           w.live_minutes_monthly_limit,
           to_char(date_trunc('month',now()),'YYYY-MM') AS month_key,
           (SELECT coalesce(sum(size),0) FROM videos WHERE workspace_id=w.id AND deleted_at IS NULL)::bigint AS source_bytes,
           (SELECT count(*) FROM videos WHERE workspace_id=w.id AND deleted_at IS NULL)::bigint AS videos,
           (SELECT coalesce(sum(uploaded_bytes),0) FROM uploads WHERE workspace_id=w.id AND created_at>=date_trunc('month',now()))::bigint AS uploaded_bytes,
           (SELECT coalesce(sum(output_bytes),0) FROM videos WHERE workspace_id=w.id AND deleted_at IS NULL)::bigint AS output_bytes,
           (SELECT coalesce(sum(amount),0) FROM usage_records WHERE workspace_id=w.id AND kind='processing_seconds' AND created_at>=date_trunc('month',now()))::bigint AS processing_seconds,
           (
             coalesce((SELECT sum(amount) FROM usage_records WHERE workspace_id=w.id AND kind='live_seconds' AND created_at>=date_trunc('month',now())),0)
             + coalesce((
               SELECT sum(greatest(0,extract(epoch FROM (now()-lses.started_at))))
               FROM live_sessions lses
               JOIN live_streams lstr ON lstr.id=lses.stream_id
               WHERE lstr.workspace_id=w.id AND lses.ended_at IS NULL
             ),0)
           )::bigint AS live_seconds
         FROM workspaces w`,
      )
    ).rows;

    let created = 0;
    for (const row of rows) {
      const month = String(row.month_key);
      const metrics: QuotaMetric[] = [
        {
          key: "source_storage",
          label: "Source storage",
          used: Number(row.source_bytes),
          limit: Number(row.storage_limit),
          periodKey: periodKey(null, Number(row.storage_limit)),
        },
        {
          key: "video_count",
          label: "Video count",
          used: Number(row.videos),
          limit: Number(row.video_limit),
          periodKey: periodKey(null, Number(row.video_limit)),
        },
        {
          key: "monthly_upload",
          label: "Monthly upload bandwidth",
          used: Number(row.uploaded_bytes),
          limit: Number(row.upload_bytes_monthly_limit),
          periodKey: periodKey(month, Number(row.upload_bytes_monthly_limit)),
        },
        {
          key: "output_storage",
          label: "Output storage",
          used: Number(row.output_bytes),
          limit: Number(row.output_storage_limit),
          periodKey: periodKey(null, Number(row.output_storage_limit)),
        },
        {
          key: "processing_compute",
          label: "Monthly processing compute",
          used: Number(row.processing_seconds),
          limit: Number(row.processing_seconds_monthly_limit),
          periodKey: periodKey(month, Number(row.processing_seconds_monthly_limit)),
        },
        {
          key: "live_minutes",
          label: "Monthly live streaming",
          used: Number(row.live_seconds),
          limit: Number(row.live_minutes_monthly_limit) * 60,
          periodKey: periodKey(month, Number(row.live_minutes_monthly_limit)),
        },
      ];

      for (const metric of metrics) {
        for (const threshold of crossedThresholds(metric.used, metric.limit)) {
          const notice = await c.query(
            `INSERT INTO quota_notices(workspace_id,quota_key,period_key,threshold)
             VALUES($1,$2,$3,$4)
             ON CONFLICT DO NOTHING
             RETURNING threshold`,
            [row.id, metric.key, metric.periodKey, threshold],
          );
          if (!notice.rowCount) continue;
          await c.query(
            "INSERT INTO notifications(workspace_id,message) VALUES($1,$2)",
            [
              row.id,
              `${metric.label} has reached ${threshold}% of its workspace quota.`,
            ],
          );
          created++;
        }
      }
    }
    return created;
  });
}
