ALTER TABLE playback_sessions
  ADD COLUMN IF NOT EXISTS device_type text
    CHECK(device_type IS NULL OR device_type IN ('desktop','mobile','tablet','tv','other')),
  ADD COLUMN IF NOT EXISTS browser_family text
    CHECK(browser_family IS NULL OR browser_family IN ('chrome','firefox','safari','edge','other')),
  ADD COLUMN IF NOT EXISTS os_family text
    CHECK(os_family IS NULL OR os_family IN ('windows','macos','linux','android','ios','other'));

CREATE INDEX IF NOT EXISTS playback_sessions_video_dimensions
  ON playback_sessions(video_id,device_type,browser_family,os_family);
