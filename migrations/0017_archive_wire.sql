-- foreign_keys: off
-- 0017: the Local copy's Shared tables take the column names of archive migration 130 (Lyrics-Website PR #305; ticket
-- #126, docs/sharing-spec.md §3.1, §6.1). 0015 shaped them after the spec before the archive side existed; 130 is the
-- first live shape and `video_shared_schema()` returns 1 there, so `meta.shared_schema` stays 1 (nothing has synced
-- yet, no machine holds the older shape against a server). test/archiveWire.test.ts checks every column against
-- test/fixtures/migration-130-columns.json.
--   - `video_chapters`, `video_artists`: + `created_at`;
--   - both rejection lists: `rejected_at` -> `created_at`, + `created_by`;
--   - `video_proposed_songs`: - `alternate_spellings` (the archive has none), + `created_by`;
--   - `video_proposed_versions`: `version_label` -> `label`, - `display_order`, + `source`, `created_by`;
--   - `video_proposed_artists`: + `created_by`;
--   - `video_edit_history`: + `reverses` (undo, §4.7), `updated_at` (the pull's watermark column);
--   - `video_exposed_songs`: rebuilt with `song_id` / `artist_id` unique, exactly one set;
--   - `shared_tombstone`: rebuilt with the archive's `id` primary key and `replaced_by`.
-- Kept stricter here than in the archive: `videos.type` NOT NULL with its CHECK, `video_chapters.title` and `source`
-- NOT NULL (the companion is the only writer of those values). `video_chapters.title_latin_source` is a Local-only
-- column (§6.1): the archive's Chapters carry no source for the Latin title.

DROP VIEW IF EXISTS song_all;
DROP VIEW IF EXISTS version_all;

ALTER TABLE video_chapters ADD COLUMN created_at TEXT;
UPDATE video_chapters SET created_at = updated_at WHERE created_at IS NULL;
ALTER TABLE video_artists ADD COLUMN created_at TEXT;
UPDATE video_artists SET created_at = updated_at WHERE created_at IS NULL;

ALTER TABLE video_chapter_rejections RENAME COLUMN rejected_at TO created_at;
ALTER TABLE video_chapter_rejections ADD COLUMN created_by TEXT;
UPDATE video_chapter_rejections SET created_at = updated_at WHERE created_at IS NULL;
ALTER TABLE video_artist_rejections RENAME COLUMN rejected_at TO created_at;
ALTER TABLE video_artist_rejections ADD COLUMN created_by TEXT;

ALTER TABLE video_proposed_songs DROP COLUMN alternate_spellings;
ALTER TABLE video_proposed_songs ADD COLUMN created_by TEXT;
ALTER TABLE video_proposed_versions RENAME COLUMN version_label TO label;
ALTER TABLE video_proposed_versions DROP COLUMN display_order;
ALTER TABLE video_proposed_versions ADD COLUMN source TEXT;
ALTER TABLE video_proposed_versions ADD COLUMN created_by TEXT;
ALTER TABLE video_proposed_artists ADD COLUMN created_by TEXT;

ALTER TABLE video_edit_history ADD COLUMN reverses TEXT;
ALTER TABLE video_edit_history ADD COLUMN updated_at TEXT;
UPDATE video_edit_history SET updated_at = created_at WHERE updated_at IS NULL;

CREATE TABLE video_exposed_songs_new (
  id TEXT PRIMARY KEY,
  song_id TEXT UNIQUE,
  artist_id TEXT UNIQUE,
  exposed_by TEXT,
  exposed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((song_id IS NULL) <> (artist_id IS NULL))
);
INSERT INTO video_exposed_songs_new (id, song_id, artist_id, exposed_by, exposed_at, updated_at)
  SELECT id, song_id, artist_id, exposed_by, COALESCE(exposed_at, updated_at), updated_at FROM video_exposed_songs
  WHERE (song_id IS NULL) <> (artist_id IS NULL);
DROP TABLE video_exposed_songs;
ALTER TABLE video_exposed_songs_new RENAME TO video_exposed_songs;

-- Proposed rows deleted or elevated (§6.3). `replaced_by` names the archive row an elevated row became.
CREATE TABLE shared_tombstone_new (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL CHECK (table_name IN ('video_proposed_songs','video_proposed_versions','video_proposed_artists')),
  row_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deleted','elevated')),
  replaced_by TEXT,
  at TEXT NOT NULL,
  UNIQUE (table_name, row_id)
);
INSERT INTO shared_tombstone_new (id, table_name, row_id, kind, at)
  SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
               substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
    table_name, row_id, kind, at
  FROM shared_tombstone
  WHERE table_name IN ('video_proposed_songs','video_proposed_versions','video_proposed_artists');
DROP TABLE shared_tombstone;
ALTER TABLE shared_tombstone_new RENAME TO shared_tombstone;

CREATE VIEW song_all AS
  SELECT id, name, english_name, alternate_titles, alternate_spellings, is_hidden, 'archive' AS kind FROM archive_song
  UNION ALL
  SELECT id, name, english_name, alternate_titles, NULL, 0, 'proposed' FROM video_proposed_songs
  UNION ALL
  SELECT id, name, english_name, alternate_titles, alternate_spellings, 0, 'local' FROM local_song;
CREATE VIEW version_all AS
  SELECT id, song_id, label, display_order, cyrillic, transliteration, translation,
         footnotes_cyrillic, footnotes_transliteration, footnotes_translation, 'archive' AS kind FROM archive_version
  UNION ALL
  SELECT id, COALESCE(song_id, proposed_song_id), label, 0, lyrics_cyrillic, lyrics_transliteration, lyrics_translation,
         footnotes_cyrillic, footnotes_transliteration, footnotes_translation, 'proposed' FROM video_proposed_versions
  UNION ALL
  SELECT id, song_id, label, display_order, cyrillic, transliteration, translation,
         footnotes_cyrillic, footnotes_transliteration, footnotes_translation, 'local' FROM local_version;
