-- 0003: the Mirror tables (ticket #25). DDL from docs/research/mirror-import-mapping.md section 9, minus `is_hidden`
-- on songs (hidden songs are not imported) and minus the optional composer tables. No foreign keys: a re-import
-- deletes and re-inserts every row, and local tables point here by uuid only (ADR-0001), so the REFERENCES clauses
-- of the research DDL are left out on purpose.
CREATE TABLE mirror_artist (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, is_hidden INTEGER NOT NULL,
  is_various_artists INTEGER NOT NULL,          -- derived: id = the sentinel, never by name
  country TEXT, bio TEXT, picture_url TEXT, picture_file TEXT
);
CREATE TABLE mirror_album (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  artist_id TEXT NOT NULL,                      -- primary Credit
  release_year INTEGER, cover_url TEXT, cover_file TEXT, notes TEXT
);
CREATE TABLE mirror_album_credit (               -- album_artists (additional Credits)
  album_id TEXT NOT NULL, artist_id TEXT NOT NULL,
  position INTEGER NOT NULL,                     -- order by created_at in the source
  PRIMARY KEY (album_id, artist_id)
);
CREATE TABLE mirror_song (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  english_name TEXT, alternate_titles TEXT, alternate_spellings TEXT,
  country TEXT, notes TEXT
);
CREATE TABLE mirror_version (                    -- song_lyrics
  id TEXT PRIMARY KEY, song_id TEXT NOT NULL,
  label TEXT NOT NULL, display_order INTEGER NOT NULL,
  cyrillic TEXT, transliteration TEXT, translation TEXT,      -- HTML
  footnotes_cyrillic TEXT NOT NULL DEFAULT '[]',              -- JSON [{id,text}]
  footnotes_transliteration TEXT NOT NULL DEFAULT '[]',
  footnotes_translation TEXT NOT NULL DEFAULT '[]',
  UNIQUE (song_id, label)
);
CREATE TABLE mirror_track (                      -- album_tracks
  id TEXT PRIMARY KEY, album_id TEXT NOT NULL,
  track_number INTEGER NOT NULL, name TEXT NOT NULL, duration_s INTEGER,
  song_id TEXT,
  version_id TEXT,                               -- NULL = the Song's default Version
  UNIQUE (album_id, track_number)
);
CREATE TABLE mirror_track_artist (               -- album_track_artists
  track_id TEXT NOT NULL, artist_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (track_id, artist_id), UNIQUE (track_id, position)
);
CREATE TABLE mirror_performance (                -- song_performances
  id TEXT PRIMARY KEY, song_id TEXT NOT NULL,
  description TEXT, url TEXT, display_order INTEGER NOT NULL,
  is_highlighted INTEGER NOT NULL,
  youtube_id TEXT, start_s INTEGER               -- parsed at import from the url (v=, t=)
);
CREATE INDEX mirror_performance_youtube ON mirror_performance(youtube_id);
CREATE INDEX mirror_performance_song ON mirror_performance(song_id);
CREATE INDEX mirror_version_song ON mirror_version(song_id);
CREATE INDEX mirror_track_album ON mirror_track(album_id);
CREATE INDEX mirror_track_song ON mirror_track(song_id);
