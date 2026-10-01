# Operations and monitoring

StreamForge ships an opt-in monitoring profile with Prometheus and Grafana.

## Start monitoring

```bash
docker compose --profile monitoring up -d prometheus grafana
```

Local endpoints:

- Prometheus: `http://127.0.0.1:9090`
- Grafana: `http://127.0.0.1:3001`

Set strong production values for:

- `GRAFANA_ADMIN_USER`
- `GRAFANA_ADMIN_PASSWORD`

## Alert rules

Prometheus loads `infra/monitoring/alerts.yml`.

Current rules cover:

- operational metrics refresh failure,
- missing worker heartbeats,
- sustained queue backlog,
- accumulated queue failures,
- elevated processing failures,
- live streams operating on backup ingest,
- high source-storage usage.

The bundled thresholds are safe defaults for development and small deployments. Production operators should tune them for actual worker concurrency, storage capacity, and plan limits.

## Grafana

Grafana is fully provisioned from source control:

- datasource: `infra/monitoring/grafana/provisioning/datasources/prometheus.yml`
- dashboard provider: `infra/monitoring/grafana/provisioning/dashboards/streamforge.yml`
- dashboard: `infra/monitoring/grafana/dashboards/streamforge-ops.json`

The dashboard includes worker health, active live streams, backup-ingest usage, queue backlog/failures, processing states, and storage growth.

## In-product operations console

Workspace admins can open **Operations** in the StreamForge dashboard.

The page uses:

`GET /api/v1/workspaces/:id/operations`

It provides a workspace-scoped operational snapshot without exposing the internal Prometheus or Grafana interfaces publicly. Global queue metrics remain available only through the internal Grafana/Prometheus stack.
