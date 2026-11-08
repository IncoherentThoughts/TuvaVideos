-- 0023: the Downloader's key/value settings (docs/downloader-spec.md §4.1): `ytdlp_checked_at`, `deno_checked_at`, and
-- later the queue's `queue_paused`, `last_throughput_bps` and the Instagram keys. Local to this machine, never shared.
-- (0022 is reserved for another ticket; the queue tables follow in 0024.)
CREATE TABLE IF NOT EXISTS download_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
