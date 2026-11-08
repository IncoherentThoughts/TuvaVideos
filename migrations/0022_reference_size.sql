-- 0022: Reference size (downloader-spec §3.2). The Shared `videos` row gains `size_bytes`, `duration_s` and `height` (an
-- estimate of what a Download weighs, taken from one Video Editor's Copy); the Local copy holds them like any Shared
-- column. All nullable and positive. Standalone and Unshared rows never set them.
-- There is no `videos` `*_all` view (0021 rebuilt only `song_all`, `version_all` and `artist_all`; a Video's Local read
-- view is `video_full`), so no view is rebuilt here. This file was added after 0023 on a main that had it already:
-- `migrate()` records by name, so a lower number applied later runs once and is recorded.
ALTER TABLE videos ADD COLUMN size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes > 0);
ALTER TABLE videos ADD COLUMN duration_s REAL CHECK (duration_s IS NULL OR duration_s > 0);
ALTER TABLE videos ADD COLUMN height INTEGER CHECK (height IS NULL OR height > 0);
