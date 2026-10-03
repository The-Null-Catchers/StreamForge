# Quota administration

StreamForge enforces source storage, video-count, monthly upload bandwidth, output storage, monthly processing compute, live concurrency, and monthly live-minute limits.

Self-hosted workspace owners can manage these caps from `/quotas`. The API endpoint is `PUT /api/v1/workspaces/:id/quotas` and is owner-only. Lowering a cap below current usage never deletes data; it prevents additional work that would exceed the relevant limit.

The maintenance worker evaluates quota utilization periodically. Crossing 80%, 90%, or 100% creates an in-app notification exactly once for the relevant quota period and configured limit. Monthly quotas reset their notice scope each month; changing a quota limit also creates a new notice scope so a future crossing can warn again.

Owner-editable limits are intended for self-hosted deployments. A hosted commercial deployment should derive effective caps from trusted plan/entitlement data rather than allowing tenant owners to increase purchased capacity directly.
