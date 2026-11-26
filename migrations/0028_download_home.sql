-- 0028: Download from the Home Server (docs/home-server-spec.md §8).
-- The index now tells where the Home Server keeps each Copy (`rel_path`, relative to its Root), so a Download puts the
-- file at the same place in this Mac's Root. The stored index's ETag goes, so the next fetch brings the field in.
ALTER TABLE home_copy ADD COLUMN rel_path TEXT;
DELETE FROM download_setting WHERE key = 'home_index_etag';

-- `download_item.source` gains 'home'. SQLite cannot alter a CHECK, so the table is rebuilt (nothing points at it).
-- `home_json` is the Home Server item's snapshot taken when it was queued (the Copy, its size and hash, and for a
-- Video only the Home Server knows its titles, Type and Chapters): the run does not depend on the index staying put.
CREATE TABLE download_item_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES download_job(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('youtube', 'instagram', 'rutube', 'home')),
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  queue_pos REAL NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  error_line TEXT,
  est_bytes INTEGER, exact_bytes INTEGER, done_bytes INTEGER,
  speed_bps REAL, eta_s REAL,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,
  file_path TEXT,
  log_path TEXT NOT NULL,
  started_at TEXT, finished_at TEXT,
  home_json TEXT,
  UNIQUE (job_id, video_id)
);
INSERT INTO download_item_new (id, job_id, video_id, source, source_url, title, queue_pos, state, reason, error_line, est_bytes, exact_bytes, done_bytes,
    speed_bps, eta_s, attempts, not_before, file_path, log_path, started_at, finished_at)
  SELECT id, job_id, video_id, source, source_url, title, queue_pos, state, reason, error_line, est_bytes, exact_bytes, done_bytes,
    speed_bps, eta_s, attempts, not_before, file_path, log_path, started_at, finished_at FROM download_item;
DROP TABLE download_item;
ALTER TABLE download_item_new RENAME TO download_item;
CREATE INDEX download_item_runnable ON download_item(state, queue_pos);
CREATE UNIQUE INDEX download_item_one_live ON download_item(video_id)
  WHERE state IN ('queued', 'sizing', 'downloading', 'merging', 'scanning', 'waiting');
