CREATE TABLE root (
  id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local','external'))
);

CREATE TABLE video (
  id INTEGER PRIMARY KEY,
  youtube_id TEXT UNIQUE,                 -- identity when present
  content_hash TEXT UNIQUE,               -- SHA-256 of the file, only for id-less files
  title TEXT NOT NULL,                    -- filename minus [id] at scan; edits are never overwritten
  title_latin TEXT,                       -- Latin title; NULL when title is already Latin
  title_latin_source TEXT CHECK (title_latin_source IN ('archive','table','manual')),
  type TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('song','concert','interview','other')),
  type_suggested INTEGER NOT NULL DEFAULT 0,
  song_id TEXT, version_id TEXT,          -- Mirror uuids, what a song Video performs
  song_suggested INTEGER NOT NULL DEFAULT 0,
  suggestion_source TEXT CHECK (suggestion_source IN ('manual','comment','description','performance')),
  favorited_at TEXT,
  resume_s REAL, last_played_at TEXT,
  thumbnail_generated_at TEXT, thumbnail_copy_id INTEGER,
  created_at TEXT NOT NULL,
  CHECK (youtube_id IS NOT NULL OR content_hash IS NOT NULL)
);

CREATE TABLE copy (
  id INTEGER PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES video(id),
  root_id INTEGER NOT NULL REFERENCES root(id),
  rel_path TEXT NOT NULL,                 -- relative to the Root
  size INTEGER NOT NULL, mtime TEXT NOT NULL,
  duration_s REAL, container TEXT, video_codec TEXT, audio_codec TEXT, width INTEGER, height INTEGER,
  playback TEXT NOT NULL CHECK (playback IN ('native','remux','transcode')),  -- from ffprobe at scan (#3)
  fallback_file TEXT,                     -- cached remux/transcode under remux/, when made
  content_hash TEXT,                      -- when computed
  missing_since TEXT,                     -- Root mounted, file gone; kept so it can revive
  UNIQUE (root_id, rel_path)
);

CREATE TABLE artist (                     -- Mirror Artists and Local Artists in one table
  id INTEGER PRIMARY KEY,
  mirror_id TEXT UNIQUE,                  -- NULL = Local Artist
  name TEXT NOT NULL, name_latin TEXT, name_latin_source TEXT
);
CREATE TABLE video_artist (
  video_id INTEGER NOT NULL REFERENCES video(id),
  artist_id INTEGER NOT NULL REFERENCES artist(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (video_id, artist_id)
);

CREATE TABLE chapter (
  id INTEGER PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES video(id),
  start_s REAL NOT NULL,                  -- no end: the next Chapter's start or the Video's end
  title TEXT NOT NULL, title_latin TEXT, title_latin_source TEXT,
  song_id TEXT, version_id TEXT,
  suggested INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('manual','comment','description','performance')),
  favorited_at TEXT,
  UNIQUE (video_id, start_s)
);

CREATE TABLE chapter_rejection (           -- tombstones so a rejected suggestion never returns (#16)
  video_id INTEGER NOT NULL REFERENCES video(id),
  source TEXT NOT NULL, start_s REAL NOT NULL,
  PRIMARY KEY (video_id, source, start_s)
);

CREATE TABLE studio_track (                -- Studio tracks of a Song (#15)
  id INTEGER PRIMARY KEY,
  song_id TEXT NOT NULL,                  -- Mirror song uuid, no FK (ADR-0001)
  mirror_track_id TEXT UNIQUE,            -- Mirror track uuid when this is that Track's match; NULL = Local Studio track
  persistent_id TEXT NOT NULL,            -- Music.app persistent ID
  suggested INTEGER NOT NULL DEFAULT 0,   -- 1 when found by the Studio matcher and not yet confirmed
  added_at TEXT NOT NULL
);

CREATE TABLE studio_last (                 -- which Studio track `t` starts for a Song
  song_id TEXT PRIMARY KEY, studio_track_id INTEGER NOT NULL REFERENCES studio_track(id)
);

CREATE TABLE mirror_import (
  id INTEGER PRIMARY KEY, backup_name TEXT NOT NULL, imported_at TEXT NOT NULL,
  row_counts TEXT NOT NULL,               -- JSON per table
  dangling_refs INTEGER NOT NULL          -- local rows whose song/version/artist uuid no longer exists
);
CREATE VIRTUAL TABLE search USING fts5(
  kind UNINDEXED,        -- video | chapter | artist | song | lyric
  ref_id UNINDEXED,      -- row id, or version_id:script:line for a lyric line
  text, text_folded,
  tokenize = 'unicode61 remove_diacritics 2'
);
