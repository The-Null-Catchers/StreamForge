import type { PoolClient } from "pg";
export async function enqueue(c: PoolClient, queue: string, payload: unknown) {
  await c.query("INSERT INTO outbox(queue,payload) VALUES($1,$2)", [
    queue,
    JSON.stringify(payload),
  ]);
}
export async function event(
  c: PoolClient,
  workspace: string,
  target: string,
  name: string,
  targetKey: "videoId" | "streamId" = "videoId",
) {
  const hooks = await c.query(
    "SELECT id FROM webhooks WHERE workspace_id=$1 AND enabled",
    [workspace],
  );
  for (const hook of hooks.rows) {
    const d = await c.query(
      "INSERT INTO webhook_deliveries(webhook_id,event,payload) VALUES($1,$2,$3) RETURNING id",
      [
        hook.id,
        name,
        JSON.stringify({
          event: name,
          [targetKey]: target,
          workspaceId: workspace,
        }),
      ],
    );
    await enqueue(c, "webhooks", { deliveryId: d.rows[0].id });
  }
}
