-- 0002: columns the spec asks for in prose but the 0001 DDL (verbatim from docs/data-model.md) lacks.
-- copy.r_frame_rate: ffprobe's r_frame_rate string (e.g. "30000/1001"), for frame stepping (spec 3.2, 4.5).
-- video.strip_*: scrub-strip geometry per Video so the UI can map a timestamp to a tile (spec 3.5).
-- strip_frames = 0 means a poster-only Thumbnail (duration under 2 s or unknown).
ALTER TABLE copy ADD COLUMN r_frame_rate TEXT;
ALTER TABLE video ADD COLUMN strip_frames INTEGER;
ALTER TABLE video ADD COLUMN strip_columns INTEGER;
ALTER TABLE video ADD COLUMN strip_rows INTEGER;
ALTER TABLE video ADD COLUMN strip_frame_w INTEGER;
ALTER TABLE video ADD COLUMN strip_frame_h INTEGER;
CREATE INDEX copy_video ON copy(video_id);
