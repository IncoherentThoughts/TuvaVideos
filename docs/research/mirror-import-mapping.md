# Mirror import mapping from the Supabase backup

Research for issue #7 (map #1). Question: which tables of the Tuvan Lyrics Archive backup the **Mirror** needs, how they relate, and what an importer must handle.

## Sources

All figures come from `python3 -I` scripts run directly against the backup JSON. Paths are relative to `/Users/evanwilliams/Desktop/Lyrics Website/`.

- **Backup in scope:** `Backups/supabase_backup_20261006_200025/`. It holds one JSON array per table, plus `manifest.json`, `openapi.json` and `media/` (133 images).
- **Newer backup used for comparison:** `Backups/supabase_backup_20261007_162813_no_media/`.
- **Schema:** `prisma/schema.prisma`. Its models are `Artist`, `Album`, `AlbumTrack`, `AlbumTrackArtist`, `AlbumArtist`, `SongLyrics` and `SongPerformance`.
- **Migrations:** `supabase/migrations/125_collapse_bands_into_artists.sql`, `126_album_track_artists.sql` and `129_drop_bands_and_song_credits.sql`.
- **Glossary:** `CONTEXT.md` in the archive repo, for the terms Artist, Credit, Various Artists, Track, Track artists, Version, Track Version, Footnote, Performance and Hidden.

## 1. The backup predates the schema

This is the headline finding.

The 2026-10-06 backup was taken just before the band-to-artist collapse:

- Migrations 125 to 129 landed on 2026-10-07 (git log of `supabase/migrations`).
- The header of 125 says its live diff was taken "Against live on 2026-10-06".
- So the backup has the **old** shape:
  - `albums.band_id`
  - `album_artists.band_id`
  - `artists.band_id`
  - `album_tracks.artist_id`
- It has **no** `artists`-keyed album credit and **no `album_track_artists` table**. That table appears neither in the backup files nor in `openapi.json` paths.
- `prisma/schema.prisma` describes the **post-129** shape:
  - `albums.artist_id`
  - `album_artists.artist_id`
  - the `album_track_artists` table
  - no `bands`, `band_songs`, `artist_bands` or `artist_songs`

**Tables the schema has that the backup lacks:** `album_track_artists`.

**Tables and columns the backup has that the schema dropped:** `bands`, `band_songs`, `artist_bands` (empty), `artist_songs`, every `band_id` column, and `album_tracks.artist_id`.

The newer backup `supabase_backup_20261007_162813_no_media` sits between migrations 126 and 129. Its manifest shows:

- 109 artists
- `album_track_artists` with 143 rows
- `albums.artist_id` and `album_artists.artist_id` already backfilled
- `band_id` still present

Every other count is identical to the 2026-10-06 backup.

**Recommendation:** the importer should target the post-129 shape. It should prefer a fresh post-129 backup, or the 2026-10-07 one. If it must read the 2026-10-06 backup, it should apply the band-to-artist mapping from migration 125 itself (§3).

## 2. Tables the Mirror needs

| Backup table | Rows | Needed | Why |
|---|---:|---|---|
| `songs` | 146 | yes | Song |
| `song_lyrics` | 161 | yes | Version, holding the Scripts and Footnotes |
| `artists` | 105 (109 in 10-07) | yes | Artist (people and groups alike) |
| `albums` | 96 | yes | Album, carrying its primary Credit |
| `album_artists` | 15 | yes | additional album Credits |
| `album_tracks` | 1176 | yes | Track |
| `album_track_artists` | absent (143 in 10-07) | yes | Track artists |
| `song_performances` | 1113 | yes | Performance, the source of YouTube ids |
| `composers` | 38 | optional | shown on a song page |
| `song_composers` | 51 | optional | |
| `tags` / `song_tags` | 4 / 132 | no | editorial workflow tags ("Finished", "Auto-Imported") |
| `bands`, `band_songs`, `artist_bands`, `artist_songs` | 148 / 9 / 0 / 10 | no | retired by ADR-0013/0014 and dropped in 129 |
| `song_edit_history`, `mentions`, `profiles`, `admin_audit_log`, `contact_*`, `song_contributor_*` | | no | staff, audit and personal data. Contains emails, so never import it |
| `song_sources` | 0 | no | empty legacy table |

### Relationships and row counts per join

All counts are from the 2026-10-06 backup. No dangling foreign keys exist anywhere in these joins.

- **Album to primary Credit.** Album → Artist via `albums.band_id`, which maps to an Artist through the §3 mapping. 96 of 96 albums resolve. 9 of them are Various Artists albums.
- **Album to additional Credits.** `album_artists`: 15 rows.
- **Album to Tracks.** `album_tracks.album_id`: 1176 tracks on 96 albums. Every album has at least one track.
  - `(album_id, track_number)` is unique.
  - 4 albums have gaps in their track numbers.
- **Track to Song.** 237 of 1176 tracks link to a song (`song_id`), covering 78 distinct songs. The other 939 tracks are unlinked slots.
- **Track to Track artists.**
  - 143 tracks have `album_tracks.artist_id` set. All of them are on Various Artists albums.
  - 23 tracks on VA albums have no track artist.
  - In the 10-07 backup, `album_track_artists` holds the same 143 rows, all at `position = 0`.
- **Track to Version.** 12 tracks set `track_version_id`.
  - Every one resolves to a `song_lyrics` row of the **same** song, which is the composite FK documented in schema.prisma.
  - NULL means "the Song's default Version" (ADR-0009).
- **Song to Versions.** 161 `song_lyrics` rows across 143 songs.
  - 3 songs have no lyrics.
  - 12 songs have more than one Version.
  - 141 rows are labelled `Complete`.
  - `(song_id, version_label)` is unique.
- **Song to Performances.** 1113 rows across all 146 songs. 14 rows have `is_highlighted` set.
- **Song to Composers.** 51 `song_composers` rows, each with `is_lyrics` and `is_melody` flags.

## 3. Bands vs artists

**`artists` is current; `bands` is legacy.** The glossary entry for Artist covers people and groups. ADR-0013 and migration 125 collapse Band into Artist.

In the 2026-10-06 backup:

- **Every artist is bound to a band.** Each of the 105 artists carries a distinct, non-dangling `band_id`.
- **43 bands have no artist.**
  - 5 of them are credited on albums: Sergei Starostin, Группа Аян, Eres Xovalyg, Uvaŋ-Shu and Ug-Shig.
  - 38 are neither credited nor bound to an artist. These are leftovers such as "BTest", duplicate spellings and "feat." variants. Drop them.
- **7 band names are case-insensitive duplicates:** alash, test, hartyga, группа аян, sergei starostin, bady-dorzhu ondar and radik tyulyush.
- **4 bands are spelled differently from their artist.** Olchey→Ölchey, Ensemble Ene Say→Ensemble Ene-Sai, Igor Koshkendey→Igor Köshkendei, and Oorjak Hunashtaar-ool→Xunashtaar-ool Oorzhak. The artist's spelling wins (125 header, "Spellings").

To credit an album to an artist from this backup, replicate the mapping in 125:

1. Resolve the band to an artist by `artists.band_id`.
2. Otherwise, match on `lower(trim(name))`. This maps Starostin and Аян onto existing artists.
3. Otherwise, create an Artist. That applies to 3 bands: Eres Xovalyg, Uvaŋ-Shu and Ug-Shig.

Mint deterministic ids for the 3 created artists. A better option is to take the ids from a post-125 backup, so that re-imports stay stable.

**Track artists:** take them from the `album_track_artists` table when it is present. Fall back to `album_tracks.artist_id` stored at position 0. Empty Track artists means "same as the Album's Credit" (glossary).

**Not imported:** `artist_songs` (10 rows, all with role "lead") and `band_songs` (9 rows). They are retired song-performer credits, and a Song has no performer of its own (ADR-0014).

## 4. The Various Artists sentinel

- The sentinel is the Artist `b33e4b80-8951-4600-8d1e-031e7fe84ee9`, named "Various Artists" with `is_hidden = true`. Its bio is a pasted Last.fm warning; discard it.
- In this backup the sentinel is bound to the band `e9fdaf03-…`, and 9 albums use that band.
- After migration 125, `albums.is_various_artists` is a generated column, `artist_id = sentinel`.
- The importer should import the sentinel row and **derive** `is_various_artists` from the pointer. It must never test the name.
- The UI must render the sentinel as plain text, never as a link to an artist page (glossary: Various Artists).
- The sentinel's tracks are the only ones carrying Track artists today.

## 5. Hidden rows

There are 88 hidden songs out of 146. The hidden songs are mostly un-reviewed bulk imports:

- 74 carry only the "Auto-Imported" tag.
- 12 have no tags.
- 2 are tagged "Review needed".

Visible songs are tagged "Finished" or "Finished (review optional)".

Data belonging to hidden songs:

- 85 of the hidden songs have lyrics.
- 23 of them are linked from tracks.
- 433 of the 1113 performances belong to them.

Hidden songs also include test data: `zz_Bai-Taiga_test2_testestestest_overrun_test_`, its Versions "Testt" and "Completedd", and a performance pointing at `https://www.test.com`.

There are 54 hidden artists, including the sentinel. On an artist, hidden means the page is private but the name stays public (ADR-0015).

**Recommendation:** import hidden rows, with `is_hidden` kept as a column.

- The Mirror is for a single owner, and hidden songs carry 331 distinct YouTube ids. 297 of those appear on no visible song, so dropping hidden songs would lose a third of the auto-link coverage.
- The UI can badge hidden songs or filter them out by default.
- Exclude the `zz_…test…` song explicitly, by slug.

## 6. YouTube ids in performances

- **URLs:** 1049 rows have a URL. 64 have a NULL or empty URL.
- **Hosts:**
  - youtube.com: 848
  - youtu.be: 84
  - rutube: 35
  - instagram: 22
  - bandcamp: 15
  - soundcloud: 8
  - vk: 8
  - facebook: 7
  - spotify: 5
  - other: a handful
- **URL forms that carry an id:**
  - `watch?v=`: 842
  - `youtu.be/`: 84
  - `live/`: 5
  - `/watch/<id>`: 1 (non-standard)
  - `shorts/`: 0
  - `embed/`: 0
- **Totals:** 932 rows carry a YouTube id, with 851 distinct ids.
  - Rows on visible songs: 587, with 554 distinct ids.
  - Rows on hidden songs: 345, with 331 distinct ids.
  - 127 songs have at least one YouTube performance.
- **Ids that map to several songs:** 48 ids are linked to 2 or more songs, up to 10 songs for one id. These are concerts or compilations, so they are natural concert Videos and Chapter seeds. The same id appears twice on the same song 7 times.
- **Timestamps:** 115 YouTube URLs carry `t=`, a start offset. These are candidate Chapter starts.
- **Other query parameters:** `si`, `list` (5), `index` and `pp`. Ignore everything except `v` and `t`.
- **Parser regex** (id = 11 characters of `[A-Za-z0-9_-]`):

  ```
  (?:youtube\.com/(?:watch\?(?:[^#\s]*&)?v=|watch/|shorts/|live/|embed/|v/)|youtu\.be/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])
  ```

- **Malformed URL:** one url field holds two concatenated URLs plus a note (`…watch?v=bfR4wjeayGohttps://…watch?v=bfR4wjeayGo [new link nneeded]`). The regex still extracts `bfR4wjeayGo`.
- **No ids outside the url field:** no YouTube URL appears in a `description` or `label` when the url field lacks one.

## 7. Footnotes are real JSON, not Python repr

- The three `footnotes_*` columns are **native JSON arrays** in the backup files. The raw file text has `"footnotes_transliteration": [ { "id": 1, "text": "Alt: üngen" } ]`.
- The raw files contain 0 occurrences of `{'id'`.
- The single-quoted dicts in the sample came from printing a parsed Python object. They are not how the data is stored.
- Shape: a list of `{id: int, text: str}`. There are 299 footnotes across 40 Versions, and the 483 columns are all lists. Read them with `json.load` and store them as JSON text in SQLite.
- **Markers:** inline Markers live in the lyric HTML as `<sup data-fn="N" class="footnote-ref">N</sup>`. Footnote numbers need not be unique (glossary), so match markers to footnotes by `id` and tolerate both orphaned markers and unreferenced footnotes.

## 8. Data-quality issues the importer must handle

1. **Shape drift.**
   - Handle pre-125 backups (`band_id`) and post-129 backups (`artist_id`, `album_track_artists`). Detect which one you have from columns, not from the date.
   - The `manifest.json` `tables` list does not name `album_track_artists` in the 10-06 backup. Treat a missing file as "no rows".
2. **HTML in text fields.**
   - Lyrics are HTML with `<p>` and `<sup>` elements.
   - Performance descriptions are HTML: `<p>By … on <em>…</em>, 2007.</p>`, with `&amp;` entities and stray zero-width spaces (`​`).
   - Sanitise or strip the HTML. Never inject it raw.
3. **`song_performances.label` is legacy junk.** 146 rows are URL-like and 5 duplicate the description. Use `description` as the visible line (glossary: Performance).
4. **Test rows** (§5). Exclude the `zz_…test…` song and its children.
5. **Duplicate album name "Agitator".** Two albums with this name exist, 2016, under different bands. They are unique by (name, credit), so do not key albums by name.
6. **Odd characters in track names.** One track name ends in U+2028 (`Kaldak-Khamar `). Normalise with a trim that covers Unicode line separators.
7. **Track numbering.**
   - 4 albums have track-number gaps (Ancestors Call, More Live, Tuva: Voices from the Center of Asia, Spirits from Two). Keep the numbers as given.
   - 44 tracks have a NULL `duration`, which is stored in seconds and ranges from 16 to 1061.
8. **Images.**
   - Album and artist image URLs point to Last.fm, Supabase storage, Discogs, Spotify and Bandcamp.
   - `media/` holds 133 images. 131 of them match URL basenames from `albums.cover_image_url`, `artists.profile_picture_url` or `composers.profile_picture_url`. Map them by basename.
   - 6 Spotify files have no extension; their name is the image hash. Sniff their content type.
   - One album has no cover.
9. **Free-text enums.** `songs.song_type` holds free text, including "draft" and "Unofficial". `country` is `tuvan`, `mongolian` or `other`.
10. **Sentinel bio.** The sentinel's bio is pasted Last.fm text. Do not display it.
11. **Recording Year is not stored.** Per the glossary it is parsed from the description on read. Copy that rule if needed.

## 9. Proposed minimal Mirror tables (SQLite)

Primary keys reuse the archive's UUIDs as `TEXT`, so a re-import is an upsert by id and Local data can point at Mirror ids stably.

```sql
CREATE TABLE mirror_artist (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, is_hidden INTEGER NOT NULL,
  is_various_artists INTEGER NOT NULL,          -- id = 'b33e4b80-…' (derived)
  country TEXT, bio TEXT, picture_url TEXT, picture_file TEXT  -- media/ basename
);
CREATE TABLE mirror_album (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  artist_id TEXT NOT NULL REFERENCES mirror_artist(id),  -- primary Credit
  release_year INTEGER, cover_url TEXT, cover_file TEXT, notes TEXT
);
CREATE TABLE mirror_album_credit (               -- album_artists (additional Credits)
  album_id TEXT NOT NULL REFERENCES mirror_album(id),
  artist_id TEXT NOT NULL REFERENCES mirror_artist(id),
  position INTEGER NOT NULL,                     -- order by created_at in source
  PRIMARY KEY (album_id, artist_id)
);
CREATE TABLE mirror_song (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  english_name TEXT, alternate_titles TEXT, alternate_spellings TEXT,
  country TEXT, is_hidden INTEGER NOT NULL, notes TEXT
);
CREATE TABLE mirror_version (                    -- song_lyrics
  id TEXT PRIMARY KEY, song_id TEXT NOT NULL REFERENCES mirror_song(id),
  label TEXT NOT NULL, display_order INTEGER NOT NULL,
  cyrillic TEXT, transliteration TEXT, translation TEXT,      -- HTML
  footnotes_cyrillic TEXT NOT NULL DEFAULT '[]',              -- JSON [{id,text}]
  footnotes_transliteration TEXT NOT NULL DEFAULT '[]',
  footnotes_translation TEXT NOT NULL DEFAULT '[]',
  UNIQUE (song_id, label)
);
CREATE TABLE mirror_track (                      -- album_tracks
  id TEXT PRIMARY KEY, album_id TEXT NOT NULL REFERENCES mirror_album(id),
  track_number INTEGER NOT NULL, name TEXT NOT NULL, duration_s INTEGER,
  song_id TEXT REFERENCES mirror_song(id),
  version_id TEXT REFERENCES mirror_version(id),   -- NULL = song default
  UNIQUE (album_id, track_number)
);
CREATE TABLE mirror_track_artist (               -- album_track_artists
  track_id TEXT NOT NULL REFERENCES mirror_track(id),
  artist_id TEXT NOT NULL REFERENCES mirror_artist(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (track_id, artist_id), UNIQUE (track_id, position)
);
CREATE TABLE mirror_performance (                -- song_performances
  id TEXT PRIMARY KEY, song_id TEXT NOT NULL REFERENCES mirror_song(id),
  description TEXT, url TEXT, display_order INTEGER NOT NULL,
  is_highlighted INTEGER NOT NULL,
  youtube_id TEXT, start_s INTEGER               -- parsed at import from url (v=, t=)
);
CREATE INDEX mirror_performance_youtube ON mirror_performance(youtube_id);
-- optional
CREATE TABLE mirror_composer (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_hidden INTEGER NOT NULL);
CREATE TABLE mirror_song_composer (song_id TEXT, composer_id TEXT, is_lyrics INTEGER, is_melody INTEGER,
  PRIMARY KEY (song_id, composer_id));
```

Columns deliberately dropped:

- `editors_notes`: internal to archive staff.
- `created_at` and `updated_at`: an import timestamp on a meta row suffices.
- `lastfm_id`.
- `album_tracks.country` and `notes`: always the album's value, or NULL.
- `song_lyrics.source`: NULL in every row.
- `songs.sources`, `transcription_note` (NULL in every row) and `song_type`.
- `song_performances.label`.
- Tags.
- Every staff or personal table.

## Open questions for the map

- **Which backup is canonical for v1?** Prefer taking a post-129 backup so that the importer never needs the band mapping. The alternative is to support the 125 mapping for older backups.
- **Should the 48 multi-song YouTube ids become concert-typed Videos automatically?** If so, should the 115 `t=` offsets seed Suggested Chapters?
