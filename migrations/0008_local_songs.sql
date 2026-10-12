-- 0008: Local Songs and Local Versions. A Local Song is a Song created here because the Mirror has none (the Song
-- counterpart of a Local Artist); a Local Version is a lyrics Version written here, attached to a Mirror Song or a
-- Local Song. Both live outside the mirror_* tables so an import (which wipes those, ADR-0001) leaves them alone, and
-- both are referenced by uuid from video/chapter/studio_track exactly like Mirror rows. The two views present Mirror
-- and local rows as one list with a `local` flag; readers query the views, the import still writes only mirror_*.
CREATE TABLE local_song (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  english_name TEXT, alternate_titles TEXT, alternate_spellings TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE local_version (
  id TEXT PRIMARY KEY, song_id TEXT NOT NULL,                -- a Mirror Song or a Local Song uuid
  label TEXT NOT NULL, display_order INTEGER NOT NULL,
  cyrillic TEXT, transliteration TEXT, translation TEXT,      -- HTML, same shape as mirror_version
  footnotes_cyrillic TEXT NOT NULL DEFAULT '[]',              -- JSON [{id,text}]
  footnotes_transliteration TEXT NOT NULL DEFAULT '[]',
  footnotes_translation TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (song_id, label)
);
CREATE INDEX local_version_song ON local_version(song_id);
CREATE VIEW song_all AS
  SELECT id, name, english_name, alternate_titles, alternate_spellings, is_hidden, 0 AS local FROM mirror_song
  UNION ALL
  SELECT id, name, english_name, alternate_titles, alternate_spellings, 0, 1 FROM local_song;
CREATE VIEW version_all AS
  SELECT id, song_id, label, display_order, cyrillic, transliteration, translation,
         footnotes_cyrillic, footnotes_transliteration, footnotes_translation, 0 AS local FROM mirror_version
  UNION ALL
  SELECT id, song_id, label, display_order, cyrillic, transliteration, translation,
         footnotes_cyrillic, footnotes_transliteration, footnotes_translation, 1 FROM local_version;
