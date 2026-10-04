CREATE OR REPLACE FUNCTION streamforge_direct_upload_part()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.upload_mode = 'direct' AND NEW.object_key IS NOT NULL THEN
    INSERT INTO upload_parts(upload_id,part_number,object_key,size,checksum)
    VALUES(NEW.id,0,NEW.object_key,NEW.total_size,NEW.checksum)
    ON CONFLICT(upload_id,part_number) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS uploads_direct_pipeline_part ON uploads;
CREATE TRIGGER uploads_direct_pipeline_part
AFTER INSERT ON uploads
FOR EACH ROW EXECUTE FUNCTION streamforge_direct_upload_part();
