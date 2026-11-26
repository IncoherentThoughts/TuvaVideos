-- 0026: the home index on a Mac (docs/home-server-spec.md §5.1). What this Mac last fetched from its Home Server's
-- `GET /api/home/index`, replaced wholesale at every fetch. Separate tables, so nothing from the Home Server ever
-- touches this Mac's own rows, its Shared data or Sync. The fetch's ETag and time live in `download_setting`
-- (`home_index_etag`, `home_index_at`, `home_index_server`).

-- Every Copy on the Home Server: its id there, its Video's identity there, its facts and the browser decision.
CREATE TABLE home_copy (
  id INTEGER PRIMARY KEY,                -- the Copy's id on the Home Server (`/copy/:id` there)
  video_id TEXT NOT NULL,                -- the Video's id on the Home Server
  youtube_id TEXT,
  content_hash TEXT,
  size INTEGER NOT NULL,
  container TEXT,
  video_codec TEXT,
  audio_codec TEXT,
  width INTEGER,
  height INTEGER,
  duration_s REAL,
  available INTEGER NOT NULL,            -- its Root is mounted on the Home Server
  playback TEXT NOT NULL CHECK (playback IN ('native', 'remux', 'transcode'))
);
CREATE INDEX home_copy_video ON home_copy (video_id);

-- The Home Server's Videos this Mac did not know at the fetch: shown read-only with the Home Server's facts.
CREATE TABLE home_video (
  id TEXT PRIMARY KEY,                   -- the Video's id on the Home Server
  youtube_id TEXT,
  content_hash TEXT,
  shared INTEGER NOT NULL,
  title TEXT NOT NULL,
  title_latin TEXT,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  thumb TEXT,                            -- the poster's cache key on the Home Server, or NULL
  chapters TEXT NOT NULL DEFAULT '[]'    -- JSON: [{ startS, title, titleLatin }]
);
