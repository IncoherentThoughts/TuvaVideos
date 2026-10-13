-- 0011: Videos deleted from the library while some of their files stay on disk (spec 2.3). The scanner skips a file
-- whose identity is here, so a deleted entry does not come back on the next scan. A Video whose every Copy was moved
-- to the Trash leaves no row: if the footage is downloaded again it is a new Video.
CREATE TABLE deleted_video (
  id INTEGER PRIMARY KEY,
  youtube_id TEXT UNIQUE,
  content_hash TEXT UNIQUE,
  title TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  CHECK (youtube_id IS NOT NULL OR content_hash IS NOT NULL)
);
