CREATE TABLE IF NOT EXISTS live_streams(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  path text UNIQUE NOT NULL,
  stream_key_hash text UNIQUE NOT NULL,
  recording_enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'idle'
    CHECK(status IN ('idle','live','ended','disabled')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_started_at timestamptz,
  last_ended_at timestamptz
);

CREATE INDEX IF NOT EXISTS live_streams_workspace_created
  ON live_streams(workspace_id,created_at DESC);

CREATE TABLE IF NOT EXISTS live_sessions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  protocol text CHECK(protocol IN ('rtmp','srt','rtsp','webrtc')),
  publisher_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  bytes_received bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS live_sessions_stream_started
  ON live_sessions(stream_id,started_at DESC);
