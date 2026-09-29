import { db } from "../../../packages/shared/src/db.js";

export async function rollupAnalytics(videoId: string, day?: string) {
  const targetDay = day ?? new Date().toISOString().slice(0, 10);
  await db.query(
    `INSERT INTO analytics_daily(
       video_id,day,plays,unique_viewers,watch_seconds,completions,errors,
       buffer_starts,buffer_seconds,avg_startup_ms,updated_at
     )
     SELECT
       $1,
       $2::date,
       count(*) FILTER(WHERE e.event='play'),
       count(DISTINCT e.session_id),
       coalesce(sum(e.watch_seconds),0),
       count(*) FILTER(WHERE e.event='ended'),
       count(*) FILTER(WHERE e.event='error'),
       count(*) FILTER(WHERE e.event='buffer_start'),
       coalesce(
         sum(
           extract(epoch FROM (buffer_end.created_at-e.created_at))
         ) FILTER(WHERE e.event='buffer_start' AND buffer_end.created_at IS NOT NULL),
         0
       ),
       avg(e.startup_ms) FILTER(WHERE e.startup_ms IS NOT NULL),
       now()
     FROM analytics_events e
     LEFT JOIN LATERAL (
       SELECT e2.created_at
       FROM analytics_events e2
       WHERE e.event='buffer_start'
         AND e2.session_id=e.session_id
         AND e2.event='buffer_end'
         AND e2.created_at>=e.created_at
       ORDER BY e2.created_at
       LIMIT 1
     ) buffer_end ON true
     WHERE e.video_id=$1
       AND e.created_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
       AND e.created_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
     ON CONFLICT(video_id,day) DO UPDATE SET
       plays=excluded.plays,
       unique_viewers=excluded.unique_viewers,
       watch_seconds=excluded.watch_seconds,
       completions=excluded.completions,
       errors=excluded.errors,
       buffer_starts=excluded.buffer_starts,
       buffer_seconds=excluded.buffer_seconds,
       avg_startup_ms=excluded.avg_startup_ms,
       updated_at=now()`,
    [videoId, targetDay],
  );
}
