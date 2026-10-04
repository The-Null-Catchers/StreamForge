import { db, transaction } from "../../../packages/shared/src/db.js";
import { enqueue } from "../../../packages/shared/src/events.js";

export async function purgeExpiredWorkspaces(limit = 25) {
  return transaction(async (c) => {
    const due = await c.query(
      `SELECT id
       FROM workspaces
       WHERE deleted_at IS NOT NULL
         AND purged_at IS NULL
         AND restore_until IS NOT NULL
         AND restore_until <= now()
       ORDER BY restore_until ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );

    let purged = 0;
    for (const workspace of due.rows) {
      const videos = await c.query(
        `SELECT id
         FROM videos
         WHERE workspace_id=$1 AND deleted_at IS NOT NULL`,
        [workspace.id],
      );
      for (const video of videos.rows)
        await enqueue(c, "cleanup", { videoId: video.id });

      await c.query(
        "DELETE FROM workspace_members WHERE workspace_id=$1",
        [workspace.id],
      );
      await c.query(
        `UPDATE workspaces
         SET purged_at=now(),restore_until=NULL
         WHERE id=$1 AND purged_at IS NULL`,
        [workspace.id],
      );
      await c.query(
        "INSERT INTO audit_logs(workspace_id,actor_id,action,target_id) VALUES($1,'system:retention','workspace.purge_scheduled',$1)",
        [workspace.id],
      );
      purged += 1;
    }

    return purged;
  });
}

export async function countExpiredWorkspaces() {
  return Number(
    (
      await db.query(
        `SELECT count(*) AS count
         FROM workspaces
         WHERE deleted_at IS NOT NULL
           AND purged_at IS NULL
           AND restore_until IS NOT NULL
           AND restore_until <= now()`,
      )
    ).rows[0]?.count ?? 0,
  );
}
