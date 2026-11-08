-- 0024: the Download queue (docs/downloader-spec.md §4.1): one row per Download job and per Video in it.
-- `download_setting` is 0023's. Local to this machine, never shared.
CREATE TABLE IF NOT EXISTS download_job (
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- never reused: a deleted job's log directory and a tab's job id stay unambiguous
  kind TEXT NOT NULL CHECK (kind IN ('bulk', 'card')),
  option TEXT,                 -- 'full' | 'random' | 'type' | 'artist' | 'favorites'; NULL for a card
  quality TEXT NOT NULL CHECK (quality IN ('720', '1080', 'best')),
  dest_dir TEXT NOT NULL,      -- absolute path
  dest_root_id INTEGER REFERENCES root(id),  -- NULL when the folder is outside every Root
  created_at TEXT NOT NULL,
  finished_at TEXT,
  cancelled_at TEXT
);
CREATE TABLE IF NOT EXISTS download_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES download_job(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('youtube', 'instagram', 'rutube')),
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,         -- snapshot for the Failure report
  queue_pos REAL NOT NULL,     -- lower runs first; a card click takes min - 1
  state TEXT NOT NULL,         -- §4.2
  reason TEXT,                 -- failure class, §4.4
  error_line TEXT,             -- last ERROR: line verbatim
  est_bytes INTEGER, exact_bytes INTEGER, done_bytes INTEGER,
  speed_bps REAL, eta_s REAL,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,             -- backoff deadline
  file_path TEXT,              -- final file, once known
  log_path TEXT NOT NULL,      -- per-item yt-dlp output
  started_at TEXT, finished_at TEXT,
  UNIQUE (job_id, video_id)
);
CREATE INDEX IF NOT EXISTS download_item_runnable ON download_item(state, queue_pos);
-- A Video is in at most one live item at a time across jobs (§4.1).
CREATE UNIQUE INDEX IF NOT EXISTS download_item_one_live ON download_item(video_id)
  WHERE state IN ('queued', 'sizing', 'downloading', 'merging', 'scanning', 'waiting');
