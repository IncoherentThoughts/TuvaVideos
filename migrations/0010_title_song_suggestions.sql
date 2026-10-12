-- foreign_keys: off
-- 0010: a Video's Song may be Suggested from its title (the Song matcher run on Video titles, spec 2.3), source
-- `title`. SQLite cannot alter a CHECK constraint, so `video` is rebuilt with the wider one (SQLite's 12-step table
-- rebuild): the runner turns foreign keys off around this file and runs foreign_key_check before COMMIT, so copy,
-- chapter, video_artist and the rest keep pointing at "video" through the swap.
-- Columns are named in the copy: databases that merged 0008_loop and 0009_views in either order differ in column order.
CREATE TABLE video_new (
  id INTEGER PRIMARY KEY,
  youtube_id TEXT UNIQUE,                 -- identity when present
  content_hash TEXT UNIQUE,               -- SHA-256 of the file, only for id-less files
  title TEXT NOT NULL,                    -- filename minus [id] at scan; edits are never overwritten
  title_latin TEXT,                       -- Latin title; NULL when title is already Latin
  title_latin_source TEXT CHECK (title_latin_source IN ('archive','table','manual')),
  type TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('song','concert','interview','other')),
  type_suggested INTEGER NOT NULL DEFAULT 0,
  song_id TEXT, version_id TEXT,          -- Mirror or Local uuids, what a song Video performs
  song_suggested INTEGER NOT NULL DEFAULT 0,
  suggestion_source TEXT CHECK (suggestion_source IN ('manual','comment','description','performance','title')),
  favorited_at TEXT,
  resume_s REAL, last_played_at TEXT,
  thumbnail_generated_at TEXT, thumbnail_copy_id INTEGER,
  created_at TEXT NOT NULL,
  strip_frames INTEGER, strip_columns INTEGER, strip_rows INTEGER, strip_frame_w INTEGER, strip_frame_h INTEGER,
  loop_a_s REAL, loop_b_s REAL,
  view_count INTEGER NOT NULL DEFAULT 0,
  CHECK (youtube_id IS NOT NULL OR content_hash IS NOT NULL)
);
INSERT INTO video_new (id, youtube_id, content_hash, title, title_latin, title_latin_source, type, type_suggested,
    song_id, version_id, song_suggested, suggestion_source, favorited_at, resume_s, last_played_at,
    thumbnail_generated_at, thumbnail_copy_id, created_at, strip_frames, strip_columns, strip_rows, strip_frame_w,
    strip_frame_h, loop_a_s, loop_b_s, view_count)
  SELECT id, youtube_id, content_hash, title, title_latin, title_latin_source, type, type_suggested,
    song_id, version_id, song_suggested, suggestion_source, favorited_at, resume_s, last_played_at,
    thumbnail_generated_at, thumbnail_copy_id, created_at, strip_frames, strip_columns, strip_rows, strip_frame_w,
    strip_frame_h, loop_a_s, loop_b_s, view_count
  FROM video;
DROP TABLE video;
ALTER TABLE video_new RENAME TO video;
