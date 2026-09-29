ALTER TABLE playlists
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE video_chapters
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS playlists_workspace_created
  ON playlists(workspace_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS playlist_items_order
  ON playlist_items(playlist_id, position, video_id);

CREATE INDEX IF NOT EXISTS video_chapters_order
  ON video_chapters(video_id, start_seconds, id);
