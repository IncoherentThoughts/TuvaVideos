-- foreign_keys: off
-- 0015: the Local copy (docs/sharing-spec.md §6.1, ticket #112, ADR 0009). The library is rebuilt around uuid TEXT keys
-- so its link data has the shape of the Shared tables in the archive (§3.1-3.3):
--   - `video`, `chapter`, `video_artist`, `chapter_rejection`, `artist_rejection` become `videos`, `video_chapters`,
--     `video_artists`, `video_chapter_rejections`, `video_artist_rejections` under their Supabase names and columns
--     (pointer pairs, `poster_path`, the soft-delete columns, `updated_at`), plus the Proposed tables, the exposure list,
--     the edit history and `shared_tombstone`, all empty until a Sync fills them;
--   - the machine's own columns leave `video` and `chapter` for the side tables `video_local` and `chapter_local`;
--   - the Mirror tables become the `archive_*` tables (rows now arrive by Sync, src/server/localCopy/apply.ts), each with
--     `updated_at` for the apply's skip guard; `mirror_import` and the import go;
--   - the old `artist` table goes: an archive Artist is known by its archive uuid, a Local Artist moves to `local_artist`;
--     derived Latin names of every kind live in `artist_latin`;
--   - `song_all`, `version_all` and the new `artist_all` union archive, Proposed and local rows with `kind`;
--   - `meta` (`shared_schema`), `session_record` (the token-free Session record, §5.2) and `shelved_edit` (§2.3).
--
-- The integer -> uuid map is deterministic so the one-time migration script (§9.2, ticket #113) can recompute it:
-- printf('<prefix>-0000-8000-8000-%012x', id) with prefix 76696400 ("vid") for Videos, 63687000 ("chp") for Chapters and
-- 61727400 ("art") for Local Artists, an RFC 9562 version-8 (custom) uuid. The same function in TypeScript is
-- `legacyUuid` in src/server/localCopy/ids.ts; test/localCopy.test.ts checks that the two agree.
--
-- Thumbnail files are named by the integer id (`<id>.poster.webp`); the companion renames them to the uuid once at
-- startup (Thumbnails.renameLegacyFiles), since a migration file cannot touch the disk.

DROP VIEW IF EXISTS song_all;
DROP VIEW IF EXISTS version_all;

CREATE TEMP TABLE vid_map AS SELECT id AS old, printf('76696400-0000-8000-8000-%012x', id) AS new FROM video;
CREATE TEMP TABLE ch_map AS SELECT id AS old, printf('63687000-0000-8000-8000-%012x', id) AS new FROM chapter;
CREATE TEMP TABLE art_map AS
  SELECT id AS old, COALESCE(mirror_id, printf('61727400-0000-8000-8000-%012x', id)) AS new, mirror_id IS NULL AS local FROM artist;

-- ---------------------------------------------------------------------------------------------------------------
-- The video-side Shared tables (Supabase names and columns)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  youtube_id TEXT UNIQUE,                 -- identity when present
  content_hash TEXT UNIQUE,               -- SHA-256 of the file, only for id-less files
  instagram_id TEXT,                      -- provenance, not identity (ADR 0005)
  rutube_id TEXT,                         -- provenance, not identity (ADR 0008); filled by 0016
  title TEXT NOT NULL,
  title_latin TEXT,
  title_latin_source TEXT CHECK (title_latin_source IN ('archive','table','manual')),
  type TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('song','concert','interview','other')),
  type_suggested INTEGER NOT NULL DEFAULT 0,
  -- Pointer pairs (§3.3). `song_id` / `version_id` hold an archive row, or on an Unshared Video a `local_*` row (the
  -- Local copy has no foreign keys to the archive: RLS decides which archive rows a machine holds).
  song_id TEXT, proposed_song_id TEXT,
  version_id TEXT, proposed_version_id TEXT,
  song_suggested INTEGER NOT NULL DEFAULT 0,
  suggestion_source TEXT CHECK (suggestion_source IN ('manual','comment','description','performance','title')),
  poster_path TEXT,                       -- the Shared poster's object path in the `posters` bucket (§6.5)
  deleted_at TEXT, deleted_by TEXT, delete_reason TEXT,   -- soft delete (§4.5)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (youtube_id IS NOT NULL OR content_hash IS NOT NULL),
  CHECK (song_id IS NULL OR proposed_song_id IS NULL),
  CHECK (version_id IS NULL OR proposed_version_id IS NULL)
);
INSERT INTO videos (id, youtube_id, content_hash, instagram_id, title, title_latin, title_latin_source, type, type_suggested,
    song_id, version_id, song_suggested, suggestion_source, created_at, updated_at)
  SELECT m.new, v.youtube_id, v.content_hash, v.instagram_id, v.title, v.title_latin, v.title_latin_source, v.type, v.type_suggested,
    v.song_id, v.version_id, v.song_suggested, v.suggestion_source, v.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM video v JOIN vid_map m ON m.old = v.id;
CREATE INDEX videos_instagram_id ON videos (instagram_id) WHERE instagram_id IS NOT NULL;
CREATE INDEX videos_rutube_id ON videos (rutube_id) WHERE rutube_id IS NOT NULL;
CREATE INDEX videos_song ON videos (song_id) WHERE song_id IS NOT NULL;
CREATE INDEX videos_proposed_song ON videos (proposed_song_id) WHERE proposed_song_id IS NOT NULL;

CREATE TABLE video_chapters (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_s REAL NOT NULL,                  -- no end: the next Chapter's start or the Video's end
  title TEXT NOT NULL,
  title_latin TEXT,
  title_latin_source TEXT CHECK (title_latin_source IN ('archive','table','manual')),
  song_id TEXT, proposed_song_id TEXT,
  version_id TEXT, proposed_version_id TEXT,
  suggested INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('manual','comment','description','performance')),
  updated_at TEXT NOT NULL,
  UNIQUE (video_id, start_s),
  CHECK (song_id IS NULL OR proposed_song_id IS NULL),
  CHECK (version_id IS NULL OR proposed_version_id IS NULL)
);
INSERT INTO video_chapters (id, video_id, start_s, title, title_latin, title_latin_source, song_id, version_id, suggested, source, updated_at)
  SELECT cm.new, vm.new, c.start_s, c.title, c.title_latin, c.title_latin_source, c.song_id, c.version_id, c.suggested, c.source,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM chapter c JOIN ch_map cm ON cm.old = c.id JOIN vid_map vm ON vm.old = c.video_id;
CREATE INDEX video_chapters_song ON video_chapters (song_id) WHERE song_id IS NOT NULL;

CREATE TABLE video_artists (
  id TEXT PRIMARY KEY,                    -- surrogate key
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  artist_id TEXT,                         -- an archive Artist, or on an Unshared Video a local_artist
  proposed_artist_id TEXT,
  position INTEGER NOT NULL,
  suggested INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  CHECK ((artist_id IS NULL) <> (proposed_artist_id IS NULL))
);
INSERT INTO video_artists (id, video_id, artist_id, position, suggested, updated_at)
  SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
               substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
    vm.new, am.new, va.position, va.suggested, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM video_artist va JOIN vid_map vm ON vm.old = va.video_id JOIN art_map am ON am.old = va.artist_id;
CREATE UNIQUE INDEX video_artists_artist ON video_artists (video_id, artist_id) WHERE artist_id IS NOT NULL;
CREATE UNIQUE INDEX video_artists_proposed ON video_artists (video_id, proposed_artist_id) WHERE proposed_artist_id IS NOT NULL;
CREATE INDEX video_artists_by_artist ON video_artists (artist_id);

-- Tombstones for rejected suggestions (§3.1): Shared, so one rejection holds for every machine.
CREATE TABLE video_chapter_rejections (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  start_s REAL NOT NULL,
  rejected_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (video_id, source, start_s)
);
INSERT INTO video_chapter_rejections (id, video_id, source, start_s, updated_at)
  SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
               substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
    vm.new, r.source, r.start_s, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM chapter_rejection r JOIN vid_map vm ON vm.old = r.video_id;

CREATE TABLE video_artist_rejections (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  artist_id TEXT,
  proposed_artist_id TEXT,
  rejected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((artist_id IS NULL) <> (proposed_artist_id IS NULL))
);
INSERT INTO video_artist_rejections (id, video_id, artist_id, rejected_at, updated_at)
  SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
               substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
    vm.new, am.new, r.rejected_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM artist_rejection r JOIN vid_map vm ON vm.old = r.video_id JOIN art_map am ON am.old = r.artist_id;
CREATE UNIQUE INDEX video_artist_rejections_artist ON video_artist_rejections (video_id, artist_id) WHERE artist_id IS NOT NULL;
CREATE UNIQUE INDEX video_artist_rejections_proposed ON video_artist_rejections (video_id, proposed_artist_id) WHERE proposed_artist_id IS NOT NULL;

-- Proposed rows (§3.4): a Video Editor's new Song, Version or Artist. Versions keep `song_lyrics`'s column names.
CREATE TABLE video_proposed_songs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  english_name TEXT, alternate_titles TEXT, alternate_spellings TEXT, notes TEXT,
  created_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE video_proposed_versions (
  id TEXT PRIMARY KEY,
  song_id TEXT, proposed_song_id TEXT,    -- exactly one parent
  version_label TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  lyrics_cyrillic TEXT, lyrics_transliteration TEXT, lyrics_translation TEXT,   -- HTML
  footnotes_cyrillic TEXT NOT NULL DEFAULT '[]',                                 -- JSON [{id,text}]
  footnotes_transliteration TEXT NOT NULL DEFAULT '[]',
  footnotes_translation TEXT NOT NULL DEFAULT '[]',
  created_at TEXT, updated_at TEXT NOT NULL,
  CHECK ((song_id IS NULL) <> (proposed_song_id IS NULL))
);
CREATE TABLE video_proposed_artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT, updated_at TEXT NOT NULL
);
-- Hidden archive Songs (and Artists) the archive's admin made readable to Members (§3.5).
CREATE TABLE video_exposed_songs (
  id TEXT PRIMARY KEY,
  song_id TEXT, artist_id TEXT,
  exposed_by TEXT, exposed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE video_edit_history (         -- §3.6; append-only, so no updated_at
  id TEXT PRIMARY KEY,
  video_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT,
  editor_id TEXT,
  event_type TEXT NOT NULL,
  field_name TEXT,
  old_value TEXT, new_value TEXT,         -- JSON
  description TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX video_edit_history_video ON video_edit_history (video_id, created_at);
-- Proposed rows deleted or elevated (§6.3); `table_name` is the spec's `table` (a reserved word).
CREATE TABLE shared_tombstone (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deleted','elevated')),
  at TEXT NOT NULL,
  PRIMARY KEY (table_name, row_id)
);

-- A local edit of a Shared table stamps `updated_at` unless the statement set it (an apply always sets it).
CREATE TRIGGER videos_touch AFTER UPDATE ON videos WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE videos SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER video_chapters_touch AFTER UPDATE ON video_chapters WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE video_chapters SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER video_artists_touch AFTER UPDATE ON video_artists WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE video_artists SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

-- ---------------------------------------------------------------------------------------------------------------
-- This machine's own columns and rows
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE video_local (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  favorited_at TEXT,
  resume_s REAL, last_played_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  loop_a_s REAL, loop_b_s REAL,
  thumbnail_generated_at TEXT, thumbnail_copy_id INTEGER,
  strip_frames INTEGER, strip_columns INTEGER, strip_rows INTEGER, strip_frame_w INTEGER, strip_frame_h INTEGER,
  poster_hash TEXT,                       -- which Shared poster object the local poster file is (null = generated here)
  pending_share INTEGER NOT NULL DEFAULT 0,   -- a Video Editor's scanned Video waiting to be shared (§6.6)
  shared INTEGER NOT NULL DEFAULT 0       -- 1 once a Sync or a cache apply delivered the row: a Shared Video, not an Unshared one
);
INSERT INTO video_local (video_id, favorited_at, resume_s, last_played_at, view_count, loop_a_s, loop_b_s,
    thumbnail_generated_at, thumbnail_copy_id, strip_frames, strip_columns, strip_rows, strip_frame_w, strip_frame_h)
  SELECT m.new, v.favorited_at, v.resume_s, v.last_played_at, v.view_count, v.loop_a_s, v.loop_b_s,
    v.thumbnail_generated_at, v.thumbnail_copy_id, v.strip_frames, v.strip_columns, v.strip_rows, v.strip_frame_w, v.strip_frame_h
  FROM video v JOIN vid_map m ON m.old = v.id;

CREATE TABLE chapter_local (
  chapter_id TEXT PRIMARY KEY REFERENCES video_chapters(id) ON DELETE CASCADE,
  favorited_at TEXT
);
INSERT INTO chapter_local (chapter_id, favorited_at)
  SELECT cm.new, c.favorited_at FROM chapter c JOIN ch_map cm ON cm.old = c.id WHERE c.favorited_at IS NOT NULL;

CREATE TABLE local_artist (               -- an Artist created on this machine, pointed at by Unshared Videos only
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO local_artist (id, name, created_at)
  SELECT am.new, a.name, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM artist a JOIN art_map am ON am.old = a.id WHERE am.local;

CREATE TABLE artist_latin (               -- derived (or manual) Latin names of Artists of every kind
  artist_id TEXT PRIMARY KEY,
  name_latin TEXT,
  name_latin_source TEXT CHECK (name_latin_source IN ('archive','table','manual'))
);
INSERT INTO artist_latin (artist_id, name_latin, name_latin_source)
  SELECT am.new, a.name_latin, a.name_latin_source FROM artist a JOIN art_map am ON am.old = a.id
  WHERE a.name_latin IS NOT NULL OR a.name_latin_source IS NOT NULL;

CREATE TABLE copy_new (
  id INTEGER PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id),
  root_id INTEGER NOT NULL REFERENCES root(id),
  rel_path TEXT NOT NULL,
  size INTEGER NOT NULL, mtime TEXT NOT NULL,
  duration_s REAL, container TEXT, video_codec TEXT, audio_codec TEXT, width INTEGER, height INTEGER,
  r_frame_rate TEXT,
  playback TEXT NOT NULL CHECK (playback IN ('native','remux','transcode')),
  fallback_file TEXT,
  content_hash TEXT,
  missing_since TEXT,
  keyframes BLOB,
  tv_playback TEXT, tv_profile_version INTEGER,
  UNIQUE (root_id, rel_path)
);
INSERT INTO copy_new (id, video_id, root_id, rel_path, size, mtime, duration_s, container, video_codec, audio_codec, width, height,
    r_frame_rate, playback, fallback_file, content_hash, missing_since, keyframes, tv_playback, tv_profile_version)
  SELECT c.id, m.new, c.root_id, c.rel_path, c.size, c.mtime, c.duration_s, c.container, c.video_codec, c.audio_codec, c.width, c.height,
    c.r_frame_rate, c.playback, c.fallback_file, c.content_hash, c.missing_since, c.keyframes, c.tv_playback, c.tv_profile_version
  FROM copy c JOIN vid_map m ON m.old = c.video_id;

CREATE TABLE video_audio_new (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO video_audio_new (video_id, state, updated_at)
  SELECT m.new, a.state, a.updated_at FROM video_audio a JOIN vid_map m ON m.old = a.video_id;

DROP TABLE copy;
DROP TABLE video_audio;
DROP TABLE chapter_rejection;
DROP TABLE artist_rejection;
DROP TABLE video_artist;
DROP TABLE chapter;
DROP TABLE artist;
DROP TABLE video;
DROP TABLE mirror_import;
ALTER TABLE copy_new RENAME TO copy;
ALTER TABLE video_audio_new RENAME TO video_audio;
CREATE INDEX copy_video ON copy (video_id);

-- ---------------------------------------------------------------------------------------------------------------
-- The archive's rows (the Mirror, renamed; ADR 0009)
-- ---------------------------------------------------------------------------------------------------------------

DROP INDEX IF EXISTS mirror_performance_youtube;
DROP INDEX IF EXISTS mirror_performance_song;
DROP INDEX IF EXISTS mirror_version_song;
DROP INDEX IF EXISTS mirror_track_album;
DROP INDEX IF EXISTS mirror_track_song;
ALTER TABLE mirror_song RENAME TO archive_song;
ALTER TABLE mirror_version RENAME TO archive_version;
ALTER TABLE mirror_artist RENAME TO archive_artist;
ALTER TABLE mirror_album RENAME TO archive_album;
ALTER TABLE mirror_album_credit RENAME TO archive_album_credit;
ALTER TABLE mirror_track RENAME TO archive_track;
ALTER TABLE mirror_track_artist RENAME TO archive_track_artist;
ALTER TABLE mirror_performance RENAME TO archive_performance;
-- NULL = held since before Sync (the Mirror): any incoming row replaces it.
ALTER TABLE archive_song ADD COLUMN updated_at TEXT;
ALTER TABLE archive_version ADD COLUMN updated_at TEXT;
ALTER TABLE archive_artist ADD COLUMN updated_at TEXT;
ALTER TABLE archive_album ADD COLUMN updated_at TEXT;
ALTER TABLE archive_album_credit ADD COLUMN updated_at TEXT;
ALTER TABLE archive_track ADD COLUMN updated_at TEXT;
ALTER TABLE archive_track_artist ADD COLUMN updated_at TEXT;
ALTER TABLE archive_performance ADD COLUMN updated_at TEXT;
ALTER TABLE archive_performance ADD COLUMN rutube_id TEXT;   -- the 32-hex id of a rutube.ru URL, filled by 0016 (§4.3)
CREATE INDEX archive_performance_youtube ON archive_performance (youtube_id);
CREATE INDEX archive_performance_rutube ON archive_performance (rutube_id);
CREATE INDEX archive_performance_song ON archive_performance (song_id);
CREATE INDEX archive_version_song ON archive_version (song_id);
CREATE INDEX archive_track_album ON archive_track (album_id);
CREATE INDEX archive_track_song ON archive_track (song_id);

-- ---------------------------------------------------------------------------------------------------------------
-- One list per entity over the three sources: kind archive | proposed | local
-- ---------------------------------------------------------------------------------------------------------------

CREATE VIEW song_all AS
  SELECT id, name, english_name, alternate_titles, alternate_spellings, is_hidden, 'archive' AS kind FROM archive_song
  UNION ALL
  SELECT id, name, english_name, alternate_titles, alternate_spellings, 0, 'proposed' FROM video_proposed_songs
  UNION ALL
  SELECT id, name, english_name, alternate_titles, alternate_spellings, 0, 'local' FROM local_song;
CREATE VIEW version_all AS
  SELECT id, song_id, label, display_order, cyrillic, transliteration, translation,
         footnotes_cyrillic, footnotes_transliteration, footnotes_translation, 'archive' AS kind FROM archive_version
  UNION ALL
  SELECT id, COALESCE(song_id, proposed_song_id), version_label, display_order, lyrics_cyrillic, lyrics_transliteration, lyrics_translation,
         footnotes_cyrillic, footnotes_transliteration, footnotes_translation, 'proposed' FROM video_proposed_versions
  UNION ALL
  SELECT id, song_id, label, display_order, cyrillic, transliteration, translation,
         footnotes_cyrillic, footnotes_transliteration, footnotes_translation, 'local' FROM local_version;
-- The Various Artists sentinel is a plain-text credit, never a Video's Artist.
CREATE VIEW artist_all AS
  SELECT a.id, a.name, l.name_latin, l.name_latin_source, a.is_hidden, a.kind FROM (
    SELECT id, name, is_hidden, 'archive' AS kind FROM archive_artist WHERE is_various_artists = 0
    UNION ALL
    SELECT id, name, 0, 'proposed' FROM video_proposed_artists
    UNION ALL
    SELECT id, name, 0, 'local' FROM local_artist
  ) a LEFT JOIN artist_latin l ON l.artist_id = a.id;

-- Read views for the companion's own queries: a Video or Chapter with this machine's columns, one effective pointer
-- per pair (song_all / version_all / artist_all say which kind it is), soft-deleted Videos left out (§4.5).
CREATE VIEW video_full AS
  SELECT v.id, v.youtube_id, v.content_hash, v.instagram_id, v.rutube_id, v.title, v.title_latin, v.title_latin_source,
    v.type, v.type_suggested, COALESCE(v.song_id, v.proposed_song_id) AS song_id, COALESCE(v.version_id, v.proposed_version_id) AS version_id,
    v.song_suggested, v.suggestion_source, v.poster_path, v.created_at, v.updated_at,
    l.favorited_at, l.resume_s, l.last_played_at, COALESCE(l.view_count, 0) AS view_count, l.loop_a_s, l.loop_b_s,
    l.thumbnail_generated_at, l.thumbnail_copy_id, l.strip_frames, l.strip_columns, l.strip_rows, l.strip_frame_w, l.strip_frame_h,
    l.poster_hash, COALESCE(l.pending_share, 0) AS pending_share, COALESCE(l.shared, 0) AS shared
  FROM videos v LEFT JOIN video_local l ON l.video_id = v.id
  WHERE v.deleted_at IS NULL;
CREATE VIEW chapter_full AS
  SELECT c.id, c.video_id, c.start_s, c.title, c.title_latin, c.title_latin_source,
    COALESCE(c.song_id, c.proposed_song_id) AS song_id, COALESCE(c.version_id, c.proposed_version_id) AS version_id,
    c.suggested, c.source, c.updated_at, l.favorited_at
  FROM video_chapters c JOIN videos v ON v.id = c.video_id AND v.deleted_at IS NULL
  LEFT JOIN chapter_local l ON l.chapter_id = c.id;
CREATE VIEW video_artist_full AS
  SELECT va.id AS link_id, va.video_id, COALESCE(va.artist_id, va.proposed_artist_id) AS artist_id, va.position, va.suggested
  FROM video_artists va JOIN videos v ON v.id = va.video_id AND v.deleted_at IS NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- Meta, the Session record, Shelved edits
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- The Shared schema this checkout's Local copy has (§6.4). A migration that reshapes a Shared table bumps it in the
-- same file, together with SHARED_SCHEMA in src/server/localCopy/meta.ts.
INSERT INTO meta (key, value) VALUES ('shared_schema', '1');

-- Who this machine is signed in as (§5.2): token-free, one row or none. Written at each Sync, cleared only by Sign
-- out, a SIGNED_OUT event or a cancelled reconciliation.
CREATE TABLE session_record (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  grant_level TEXT CHECK (grant_level IN ('member','editor')),   -- NULL = an account without the grant
  archive_role TEXT,
  last_verified_at TEXT,
  last_sync_at TEXT,
  watermark TEXT                          -- max updated_at seen, from the server
);

-- The link data a Video carried here before sign-in reconciliation replaced it with the Shared row (§2.3, §7.4).
-- Read-only, never synced; `payload` is JSON in the shape of the replaced values (a Chapter keeps its favorited_at).
CREATE TABLE shelved_edit (
  id INTEGER PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('title','type','song','artists','chapter')),
  payload TEXT NOT NULL,
  shelved_at TEXT NOT NULL
);
CREATE INDEX shelved_edit_video ON shelved_edit (video_id);

-- The index rows carried integer ids; the companion rebuilds the index at startup.
DELETE FROM search;

DROP TABLE vid_map;
DROP TABLE ch_map;
DROP TABLE art_map;
