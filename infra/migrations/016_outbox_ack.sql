ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;

CREATE INDEX IF NOT EXISTS outbox_unacknowledged_dispatched
  ON outbox(dispatched_at)
  WHERE dispatched_at IS NOT NULL AND acknowledged_at IS NULL;
