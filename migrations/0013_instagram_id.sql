-- 0013: video.instagram_id, the shortcode of yt-dlp's `[instagram-<shortcode>]` filename suffix (ADR 0005). Provenance,
-- not identity: the Video stays known by its content hash, but a new file carrying a known shortcode joins that Video.
-- Not unique: while a duplicate is being cleaned up, the keeper may be given the shortcode before the other is deleted.
ALTER TABLE video ADD COLUMN instagram_id TEXT;
UPDATE video SET instagram_id = (
  SELECT substr(c.rel_path, instr(c.rel_path, '[instagram-') + 11,
                instr(substr(c.rel_path, instr(c.rel_path, '[instagram-') + 11), ']') - 1)
  FROM copy c WHERE c.video_id = video.id AND c.rel_path LIKE '%[instagram-%].%' ORDER BY c.id LIMIT 1);
CREATE INDEX video_instagram_id ON video (instagram_id) WHERE instagram_id IS NOT NULL;
