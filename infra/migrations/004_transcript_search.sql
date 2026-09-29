CREATE TABLE transcript_segments(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  subtitle_id uuid NOT NULL REFERENCES subtitles(id) ON DELETE CASCADE,
  language text NOT NULL,
  start_seconds double precision NOT NULL CHECK(start_seconds >= 0),
  end_seconds double precision NOT NULL CHECK(end_seconds >= start_seconds),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transcript_segments_video_time
  ON transcript_segments(video_id,start_seconds,id);

CREATE INDEX transcript_segments_subtitle
  ON transcript_segments(subtitle_id);

CREATE INDEX transcript_segments_search
  ON transcript_segments
  USING gin(to_tsvector('simple',text));
