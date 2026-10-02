type OutboxRow = {
  id: string;
  queue: string;
};

type QueryResult<T = any> = {
  rows: T[];
  rowCount?: number | null;
};

type Queryable = {
  query<T = any>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
};

type QueueLookup = {
  getJob(id: string): Promise<unknown | null>;
};

export async function reconcileDispatchedOutbox(
  database: Queryable,
  queueLookup: (name: string) => QueueLookup | undefined,
  graceMs = 120_000,
) {
  const stale = await database.query<OutboxRow>(
    `SELECT id,queue
     FROM outbox
     WHERE dispatched_at IS NOT NULL
       AND acknowledged_at IS NULL
       AND dispatched_at < now() - ($1::bigint * interval '1 millisecond')
     ORDER BY dispatched_at
     LIMIT 100`,
    [graceMs],
  );

  let restored = 0;
  for (const row of stale.rows) {
    const queue = queueLookup(row.queue);
    if (!queue) continue;

    const job = await queue.getJob(row.id);
    if (job) continue;

    const reset = await database.query(
      `UPDATE outbox
       SET dispatched_at=NULL
       WHERE id=$1
         AND dispatched_at IS NOT NULL
         AND acknowledged_at IS NULL`,
      [row.id],
    );
    restored += reset.rowCount ?? 0;
  }

  return restored;
}
