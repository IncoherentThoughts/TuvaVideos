# Data model and SQLite schema

Decided in [issue #13](https://github.com/IncoherentThoughts/TuvaVideos/issues/13). Vocabulary is `CONTEXT.md`; the Mirror DDL builds on `docs/research/mirror-import-mapping.md` (branch `research/mirror-import`). See ADR-0001 for why local tables hold Mirror uuids without foreign keys.

## Storage

- One SQLite file plus caches under `~/Library/Application Support/TuvaVideos/` (`library.db`, `thumbs/`, `remux/`), overridable by an env var for tests.
- `bun:sqlite`, numbered `.sql` migration files applied at startup, tracked with `PRAGMA user_version`. No ORM.
- Thumbnails and remux files are files on disk named by Video id; the database records only that they exist and which Copy they came from.

## Library tables

```sql
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
  strip_frames INTEGER, strip_columns INTEGER, strip_rows INTEGER, strip_frame_w INTEGER, strip_frame_h INTEGER,  -- strip geometry (#22, migration 0002); 0 frames = poster only
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
  r_frame_rate TEXT,                      -- from ffprobe; frame step needs it (#10); added in migration 0002
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
```

Rules:

- **Identity**: YouTube id from the filename when present, otherwise SHA-256 of the whole file (computed only for id-less files). Several files with one id are Copies of one Video; cleanup of surplus Copies is #18.
- **Scan**: new file → new Copy, and a new Video unless identity matches. Type and Song default from the Mirror (id on exactly one Performance → `song` with that Song Suggested; id on 2+ Performances → `concert`), else `other`. Partials (`.fNNN`, `.temp`), `._*` and non-video files are skipped. A rescan never overwrites an edited title, Type, Song or Artists. A file gone from a mounted Root sets `missing_since`; an unmounted Root changes nothing.
- **Copy to play**: local Root first; then `playback = native`, then larger resolution, then smaller size. No per-Video pin.
- **Song pointers are columns**: one Song/Version per Video or Chapter. Every Suggested value records its source. There is no per-Video track link: a Video's Studio tracks are derived from its Song (#15 superseded #13's `track_id` columns).
- **Suggested Chapters** come from the pipeline in `docs/chapter-pipeline.md`; `chapter_rejection` holds the tombstones its re-runs honour.
- **Studio tracks** live in `studio_track`, keyed by Song uuid; the Studio matcher fills it after every Mirror import, a stale persistent id triggers a re-dump and re-match (a changed confirmed match drops to Suggested). Rules in `docs/studio-playback.md`.
- **Favorites** are `favorited_at` on Video and Chapter; the Favorites view orders by it. **Resume** is `resume_s` + `last_played_at` on Video. No play count.
- **Artists**: one table. A Local Artist has `mirror_id` NULL. Merging a Local Artist into a Mirror one is an update of `video_artist`. Chapters carry no Artists in v1.

## Mirror tables

Imported from a post-migration-129 backup only (the 2026-10-07 one or newer); the band mapping of older backups is not supported. Tables: `mirror_song`, `mirror_version`, `mirror_artist`, `mirror_album`, `mirror_album_credit`, `mirror_track`, `mirror_track_artist`, `mirror_performance`, with the DDL in the research doc, minus `is_hidden` on songs.

Dropped from the import: hidden songs and every row that belongs to them, composers, bands, tags, history, profiles and every staff or personal table, plus the columns the research doc lists (`editors_notes`, timestamps, `lastfm_id`, `label`, `source`, `sources`, `transcription_note`, `song_type`).

**Re-import** is one transaction: delete every `mirror_*` row, insert the new set, upsert `artist` rows by `mirror_id`, write a `mirror_import` row. Local tables are untouched; a dangling uuid stays and renders as "unknown song/artist" (ADR-0001).

## Latin titles

A one-time task fills `title_latin` on Videos and Chapters and `name_latin` on Local Artists, with `*_latin_source` = `archive` when the row is tied to a Mirror Song or Artist (the archive's own Latin spelling: alternate spellings or the transliteration Script, never `english_name`, which is a translation), else `table`. Titles already in Latin script stay NULL. Edits set `manual` and are never regenerated.

Transliteration table (case follows the source letter):

| Cyrillic | Latin | Cyrillic | Latin |
|---|---|---|---|
| А | A | П | P |
| Б | B | Р | R |
| В | V | С | S |
| Г | G | Т | T |
| Д | D | У | U |
| Е | E | Ү | Ü |
| Ё | Jo | Ф | F |
| Ж | Zh | Х | X |
| З | Z | Ц | Ts |
| И | I | Ч | Ch |
| Й | J before a vowel, else I | Ш | Sh |
| К | K | Щ | Sh |
| Л | L | Ъ | (dropped) |
| М | M | Ы | Y |
| Н | N | Ь | (dropped) |
| Ң | ŋ | Э | E |
| О | O | Ю | Ju |
| Ө | Ö | Я | Ja |

Vowels for the Й rule: а е ё и о ө у ү ы э ю я. Digraphs are lower-cased inside a word (`Жаа` → `Zhaa`).

## Search (FTS5)

One virtual table, rebuilt after every scan, import or Latin-title run (the library is small enough that external-content tables are not worth it):

```sql
CREATE VIRTUAL TABLE search USING fts5(
  kind UNINDEXED,        -- video | chapter | artist | song | lyric
  ref_id UNINDEXED,      -- row id, or version_id:script:line for a lyric line
  text, text_folded,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

- Rows: Video titles, Chapter titles, Artist names, Song names (plus alternate titles and spellings), and lyric text **one row per lyric line** per Script per Version, HTML stripped, so a hit returns the whole line for highlighting as the archive does.
- `text` holds the original and the Latin title together; `text_folded` holds a derived ASCII form of both: ŋ → ng, ö/ü → o/u, and `x` additionally indexed as `kh`, so `khoomei`, `xoomei` and `хөөмей` all match. No Cyrillic ↔ Latin folding beyond that: the transliteration Script and the Latin titles already cover Latin queries.
- Ranking and result grouping are left to #17.
