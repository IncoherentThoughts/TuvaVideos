# TuvaVideos sharing specification

Assembled 2026-10-17 in [issue #95](https://github.com/IncoherentThoughts/TuvaVideos/issues/95) from every closed ticket on [map #82](https://github.com/IncoherentThoughts/TuvaVideos/issues/82). Normative for the build tickets in §10. Vocabulary: `CONTEXT.md`, the **Sharing** section (Shared, Standalone, Member, Video Editor, Unshared, Proposed, Elevate, Exposed, Repoint, Sync, Session record, Local copy, Shelved, Unmounted, Not on this machine) and the amended **Root** and **Video** terms. The v1 spec (`docs/spec.md`) is the baseline: everything not said here is as the app does it today. The TV spec (`docs/tv-spec.md`) is unchanged except §7.6 below.

Where a ticket's resolution and this document disagree, this document wins; where two tickets disagreed, the later one won and the superseded point is named in place. Sources folded in: [#83](https://github.com/IncoherentThoughts/TuvaVideos/issues/83) where the Shared tables live ([research/shared-schema.md](research/shared-schema.md)), [#84](https://github.com/IncoherentThoughts/TuvaVideos/issues/84) Supabase Auth from the app ([research/app-auth.md](research/app-auth.md)), [#85](https://github.com/IncoherentThoughts/TuvaVideos/issues/85) hosting posters ([research/posters.md](research/posters.md)), [#86](https://github.com/IncoherentThoughts/TuvaVideos/issues/86) keeping the cache coherent ([research/cache-sync.md](research/cache-sync.md)), [#87](https://github.com/IncoherentThoughts/TuvaVideos/issues/87) how the Local rows overlap the archive ([research/local-overlap.md](research/local-overlap.md)), [#88](https://github.com/IncoherentThoughts/TuvaVideos/issues/88#issuecomment-6229891158) the three modes, [#89](https://github.com/IncoherentThoughts/TuvaVideos/issues/89#issuecomment-6230041453) the Shared schema and migration, [#90](https://github.com/IncoherentThoughts/TuvaVideos/issues/90#issuecomment-6237604017) the write model and accounts ([ADR 0007](adr/0007-video-library-access-is-a-grant-apart-from-the-archive-role.md)), [#91](https://github.com/IncoherentThoughts/TuvaVideos/issues/91#issuecomment-6240038985) sign-in and session, [#92](https://github.com/IncoherentThoughts/TuvaVideos/issues/92#issuecomment-6241544058) the Local copy, Sync and the grid, [#93](https://github.com/IncoherentThoughts/TuvaVideos/issues/93#issuecomment-6242245414) onboarding, [#94](https://github.com/IncoherentThoughts/TuvaVideos/issues/94#issuecomment-6230081491) the Member's grid prototype (branch `prototype/member-grid`, variant A, commit 93094df), [#104](https://github.com/IncoherentThoughts/TuvaVideos/issues/104#issuecomment-6242887805) Rutube ids ([ADR 0008](adr/0008-rutube-id-is-provenance-like-the-instagram-shortcode.md)). Decision records written with this spec: [ADR 0009](adr/0009-the-mirror-retires-archive-rows-arrive-by-sync.md) (the Mirror retires) and [ADR 0010](adr/0010-shared-link-data-lives-in-the-archive-written-through-rpcs.md) (writing to a database outside the machine); [ADR 0006](adr/0006-shared-tables-reference-the-archive-with-real-foreign-keys.md) covers the foreign keys.

---

## 1. Product, people and constraints

The link data of the library (what ties each Video to a Song, Artist, Chapter and Version, never the files) moves into the Tuvan Lyrics Archive's Supabase project, where every Member reads it and Video Editors maintain it, while the app keeps working with no account at all. Each machine still holds its own files, thumbnails and playback state; what it shares is the knowledge about the Videos.

### Three kinds of people

- **Standalone**: no Member session on this machine. Everything local; the Shared data held is whatever the last Sync left, read-only, and nothing on a machine that never signed in.
- **Member**: an archive account with a video grant (`video_access`, level `member`). Reads the Shared data live through Sync, browses it with their own Copies, Favorites and Resume positions, cannot change it.
- **Video Editor**: grant level `editor`. Changes the Shared data with history; their scans add unknown Videos for everyone.

Two more capabilities ride on the archive's own roles and are shown only to accounts that hold them: an **archive moderator who is also a Video Editor** may Elevate Proposed rows (§4.4); an **archive admin** may Expose hidden Songs (§3.5). The grant is independent of the archive's roles both ways (ADR 0007): a Video Editor holds nothing on the lyrics website by virtue of it, and an archive moderator with no grant is not a Member.

### Standing constraints

- **Writes go through functions, never direct table writes**; every Shared write carries its edit history in the same transaction, the archive's shape (archive ADR-0011). RLS reading `video_access` is the real gate; hidden or disabled controls in the app are courtesy.
- **The browser writes, the companion caches.** The Preact app talks to Supabase with the public key and the user's session; the Bun companion holds the Local copy and is Supabase-blind except for Sync, which receives the access token per call and never stores it (ADR 0010 supersedes v1's "the app never touches the network" and "SQLite is the only store").
- **Nothing about files leaves the machine.** Copies, Roots, scrub strips, Fallbacks, Audio settings, Resume, view counts, Favorites, Studio tracks and the search index are local. Posters are the one hosted asset (§6.5).
- **Offline is read-only.** A Member without a connection browses and plays from the Local copy; every edit control is disabled with a notice. No queued edits, no conflict resolution later.
- **Shared wins.** At sign-in reconciliation and in every Sync, the archive's row replaces the local one; what loses is Shelved, never merged.
- **Nothing a Video Editor does is visible on, or a permission on, the lyrics website.** Proposed rows live in video-side tables; only Elevation moves a row into the archive, and it lands hidden.
- **One account per machine**, one Local copy, one data directory. Favorites and Resume are per machine, not per account.
- **Load is negligible, egress is the metered line.** The Free plan suffices (#85): about 36 MB of posters per Member once, 2 MB of link data, a few MB a month after.
- **The Mirror retires** (ADR 0009): archive rows arrive by Sync into the Local copy; the backup import and `mirror_import` go.

### Sizing facts (2026-10-13 and 2026-10-17)

| Thing | Count |
|---|---|
| Videos / Chapters / Video-Artist links | 2,166 / 926 / 1,548 (2,210 / 939 / 1,573 at charting) |
| Local Songs / Versions / Artists to carry as Proposed | 61 / 73 / 43 (of 63 / 73 / 49; 1 true duplicate, 5 near-duplicates, 2 junk, #87) |
| Videos pointing at hidden archive Songs | 351 (the initial exposure list) |
| Posters | 2,166 live, 36.3 MB, 480 px WebP q75 |
| Rutube Copies | 34, all on archive performances |
| Archive accounts | 5 (3 admin, 2 moderator); database 20 MB |

---

## 2. Modes

### 2.1 The mode is a fact about the machine

A machine is in one mode, owned by the companion's data directory: **Session record present or not** (§5.2), and if present, **grant or not**. Every browser tab and the TV Server reflect it; the browser performs the sign-in and the writes. No "work locally" toggle: three modes plus the offline condition, nothing else. Signing in as someone else is Sign out then Sign in.

### 2.2 The chip

One account chip at the header's right, the archive's circular profile icon at 34 px with an almond-tinted border and `profiles.avatar_url` as the image (initials when there is none), no role text: the role shows through whether edit controls exist. No session: a plain "Sign in" button and nothing else, so the app looks as today. Signed in, the chip's menu holds: display name; role pill (or "No video library access" for an account without the grant); "Last Sync …" with a **Sync** button and, during a Sync, "Syncing…" and "posters n of m"; the last Sync error in one line; **Share n new Videos…** while an editor's `pending_share` queue is non-empty (§6.6); **Edits** (§4.8); **Sign out**; **Clear Shelved edits** with the count and one confirmation. Offline: a small slashed dot on the chip and the Sync row says the archive cannot be reached.

As built (#131, `src/web/chipView.ts`): until `/api/session` first answers the header shows neither chip nor button, so a signed-in machine never flashes "Sign in". A record with an unsettled browser session renders the chip with the offline dot (§5.3: unsettled counts as offline); once settled, a browser with no session of its own shows "Sign in" and leaves the record alone. The Sync row reads "Syncing…" during a Sync, else "The archive can't be reached" when offline, else "Last Sync <age>" from the record's `last_sync_at` ("never" until #115 writes it); an error line identical to the offline line is not repeated. "posters n of m", **Share n new Videos…**, **Edits** and **Clear Shelved edits** arrive with #115/#116/#117, which own their data.

### 2.3 Signing in with an existing library: reconciliation

- Local Videos are matched to Shared Videos in the scan's order: **YouTube id, then content hash, then Instagram shortcode or Rutube id** (§3.2). A provenance match with a different hash joins the Shared Video as a new Copy.
- A Video the Shared set knows takes the Shared row. **Shared wins.** An unknown Video is added as a scan would: to the Shared data for a Video Editor (through the `pending_share` queue, §6.6), as an Unshared Video otherwise.
- The local link data that loses (title, Type, Song and Version pointers, Artists, Chapters) becomes **Shelved** edits: kept on the machine, read-only, never synced, shown in a drawer on the Video with a small marker. A Video Editor can copy a Shelved Chapter or pointer back into the Shared set as an ordinary write with history. Shelved edits never expire; they are clearable per Video from the drawer and all at once from the chip menu after one confirmation. Reconciliation is the only path that shelves anything.
- A Favorite Chapter whose Chapter is shelved leaves the Favorites list; the Shelved Chapter remembers the star and copying it back re-stars it. Video Favorites are untouched.
- `local_*` Songs, Versions and Artists pointed at only by Videos that reconcile to Shared rows are shelved with those tags; those pointed at by an unknown Video a Video Editor shares become Proposed rows (§4.3) with it; a Member's stay local, pointed at by Unshared Videos only.
- A confirmation before reconciliation counts what will be shelved. **Cancel signs out again** and clears the Session record: no half-signed-in state.
- Sign-in never pushes link data for Videos the Shared set already knows. The one-time migration (§9) is the only bulk push that ever exists.

### 2.4 Signing out

No confirmation; `signOut({ scope: 'local' })`; Session record cleared. The Local copy stays **read-only**; Favorites, Resume, Copies, Roots, Thumbnails, Audio settings and Studio tracks are untouched; Exposed Songs' text stays in the Local copy. Unknown files scanned while signed out become Unshared Videos, as for an offline Member. No purge.

### 2.5 Losing the grant

A Video Editor who loses the grant is a Member: edit controls on Shared Videos go away, Unshared Videos stay taggable locally, no local forks. The grant is re-read through `video_whoami()` at sign-in and at every Sync; a permission error during a write re-reads it at once. Edit controls are **hidden** for a Member and **disabled with a notice** for a Video Editor who is offline or whose session is unsettled.

---

## 3. The Shared schema

All in the archive's `public` schema (#83: every safety net the archive has is scoped there), uuid primary keys that the client may mint, `updated_at` on every row, RLS on every table, `revoke all … from public, anon, authenticated`, `grant select, insert, update, delete … to authenticated` (no TRUNCATE, no anon read), read policies `(select is_video_member())`, write policies `(select is_video_editor())`. The archive's conventions bind the migration: numbered file in `supabase/migrations/`, one pgTAP file per function plus an "anon reads no `video_*` table" test, the `live-rls-snapshot.json` refresh at the live apply, and the drift check against `list_migrations` before touching the directory.

### 3.1 Tables

| Table | Holds |
|---|---|
| `video_access` | `profile_id → profiles`, `level in ('member','editor')`, `granted_at`. Console-only: no policies, no grants; read by `is_video_member()` / `is_video_editor()` (definer, `SET search_path = public`, revoked from anon) and by the owner's grant script. |
| `videos` | Identity (§3.2), `title`, `title_latin` + `title_latin_source`, `type` + `type_suggested`, `song_id` / `proposed_song_id`, `version_id` / `proposed_version_id`, `song_suggested`, `suggestion_source`, `poster_path`, `deleted_at` / `deleted_by → profiles` / `delete_reason`, `updated_at`. |
| `video_chapters` | `video_id` (cascade), `start_s`, `title`, `title_latin`, the same two pointer pairs, `suggested`, `source`, `UNIQUE (video_id, start_s)`. |
| `video_artists` | surrogate key, `video_id` (cascade), `artist_id → artists` **or** `proposed_artist_id`, `position`, `suggested`. |
| `video_chapter_rejections`, `video_artist_rejections` | Tombstones for rejected suggestions, Shared so one rejection holds for all. |
| `video_proposed_songs` | `name`, `english_name`, `alternate_titles`, `notes`, `created_by`. |
| `video_proposed_versions` | The archive's `song_lyrics` column names: `label`, `lyrics_cyrillic` / `lyrics_transliteration` / `lyrics_translation`, `source`, `footnotes_cyrillic` / `footnotes_transliteration` / `footnotes_translation` (jsonb, `[]`), `created_by`; parent is `song_id → songs` **or** `proposed_song_id`, exactly one (both cascade). *(amended in #126)* |
| `video_proposed_artists` | `name`, `created_by`. |
| `video_exposed_songs` | `id`, `song_id → songs` (unique, cascade) **or** `artist_id → artists` (unique, cascade), exactly one; `exposed_by`, `exposed_at`, `updated_at`; admin-written (§3.5). *(amended in #126)* |
| `video_edit_history` | §3.6. Adds `reverses → video_edit_history(id)` (undo, §4.7) and `updated_at` (the pull's watermark column); `video_id` is nullable, for rows about Proposed rows and exposure. *(amended in #126)* |
| `shared_tombstone` | `(id, table_name, row_id, kind deleted\|elevated, replaced_by, at)` for Proposed rows only. `replaced_by` names the archive row an elevated row became (its own id, or the `use_existing` row). 90-day retention (§6.3). *(amended in #126)* |

Every Shared row also carries `created_at`; Chapters, Artist links and both rejection lists carry `created_at` and the rejections `created_by` (no `rejected_at`). The checked-in column list is `test/fixtures/migration-130-columns.json` in the companion, extracted from archive migration 130. *(amended in #126)*

Performances, tracks and albums are the archive's own tables, read by every Member (#92). `video_deletions` and `video_editors` from #89 are replaced by the soft-delete columns and `video_access` (#90).

### 3.2 Identity and provenance

- `youtube_id` unique; `content_hash` unique; `CHECK (youtube_id IS NOT NULL OR content_hash IS NOT NULL)`. The hash is Shared so a Member's hash-only file matches.
- `instagram_id` and `rutube_id`: non-unique **provenance** (ADR 0005, ADR 0008). A new id-less file whose bytes match no Video but whose shortcode or Rutube id is known joins that Video as another Copy; a hash match lacking the id picks up the file's; an entry-only delete tombstones the hash, not the id. Both are parsed from yt-dlp's filename suffixes `[instagram-<shortcode>]` and `[rutube-<32 hex>]`; the Rutube column is backfilled from Copy filenames by migration and the suffix stripped from the five titles that still carry it.
- Per-platform columns stay until the in-app downloader effort decides on a general source (#104).

### 3.3 Pointers and foreign keys (ADR 0006, amended by ADR 0007)

Real foreign keys: `song_id → songs(id) ON DELETE SET NULL`; the composite `(song_id, version_id) → song_lyrics(song_id, id) ON DELETE SET NULL (version_id)` with `CHECK (version_id IS NULL OR song_id IS NOT NULL)`; `video_artists.artist_id → artists(id) ON DELETE CASCADE`; `proposed_* → video_proposed_*(id) ON DELETE SET NULL` on Videos and Chapters; `video_artists.proposed_artist_id`, the Artist rejections' `proposed_artist_id` and `video_proposed_versions`' parents **cascade** instead (a link must name exactly one Artist; a Proposed Artist is deleted only when nothing links it, or after Elevation has repointed every link). A pointer-tidy trigger nulls `version_id` whenever `song_id` goes null, so an archive Song delete never breaks `version_id IS NULL OR song_id IS NOT NULL`. *(amended in #126)* Each pointer pair carries `CHECK (num_nonnulls(song_id, proposed_song_id) <= 1)` and likewise for versions and artists. Indexes on every referencing column. An archive delete that nulls a pointer leaves no history row; accepted (archive ADR-0005 forbids automatic Song deletes; the Video degrades to "unknown song" as today). The client sees one `song` field with `proposed: boolean`.

### 3.4 Proposed rows

A Video Editor's new Song, Version or Artist is a Proposed row, Member-readable, Video-Editor-written, never visible on the lyrics website, marked **Proposed** wherever its name appears in the app, pointable by Videos and Chapters like any archive row. Creating one dedupes by folded name against the archive rows the caller can read plus Proposed rows; a hit raises `duplicate-candidate` with the ids and the UI asks "use existing / create anyway". Editing: any Video Editor, with history. Deleting: only when nothing points at it; the UI shows the count and offers to Repoint first. Unverified, the promote RPCs and the badge on both sites (#89) are dropped.

### 3.5 Reading the archive: Exposed Songs

Members read the live archive rows as of their last Sync: everything non-hidden plus **Exposed** hidden Songs. The read policies on `songs`, `song_lyrics` and `song_edit_history` gain one arm: `OR ((select is_video_member()) AND song_id IN (select song_id from video_exposed_songs))`. *(amended in #126)* The arm is a **separate permissive `SELECT … TO authenticated` policy**, not an edit to the existing policies (that keeps `is_video_member()`, revoked from anon, off anon's path and leaves the live definitions untouched), and it also covers `artists` (an elevated Artist lands hidden and Exposed, §4.4). `set_song_exposure(op expose|unexpose)` is gated `get_my_role() = 'admin'`; the toggle lives in TuvaVideos and is shown to archive admins only. The migration script's preflight lists the 351 Videos on hidden Songs as the initial exposure list for the owner to confirm. No copy of lyrics lives anywhere but each machine's Local copy. Collaborators receive no archive role (#89's reviewer idea is withdrawn).

### 3.6 Edit history

*(amended in #126: the registry is now fixed by archive migration 130's CHECK, below; `video_id` is nullable; `reverses` and `updated_at` are added.)* `video_edit_history`, modelled on `song_edit_history`: `video_id` (cascade, null for rows about Proposed rows and exposure), `target_type` CHECK in (video, chapter, artist_link, chapter_rejection, artist_rejection, proposed_song, proposed_version, proposed_artist, exposure), `target_id`, `editor_id → profiles` (set null), `event_type` from a fixed registry (`video.scanned`, `video.title_changed`, `video.song_changed`, `video.deleted`, `video.restored`, `video.migrated`, `chapter.added`, `chapter.changed`, `chapter.deleted`, `chapter.confirmed`, `chapter.rejected`, `chapter.unrejected`, `artists.replaced`, `artist_link.rejected`, `artist_link.repointed`, `proposed.song_created`, `proposed.song_elevated`, …), `field_name`, `old_value` / `new_value` jsonb sufficient to invert (each at most 256 KiB), `description` (required), `reverses`, `created_at`, `updated_at`. Read policy `is_video_member()`. A new event type widens the SQL CHECK in the same change (archive rule).

The full registry (migration 130's CHECK; `EVENT_TYPES` in `src/shared/archiveWire.ts`) *(amended in #126)*:

- `video.scanned`, `video.migrated`, `video.title_changed`, `video.type_changed`, `video.song_changed`, `video.version_changed`, `video.title_latin_changed`, `video.provenance_changed`, `video.poster_changed`, `video.suggested`, `video.deleted`, `video.restored`;
- `chapter.added`, `chapter.changed`, `chapter.deleted`, `chapter.suggested`, `chapter.confirmed`, `chapter.rejected`, `chapter.unrejected`;
- `artists.replaced`, `artists.suggested`, `artists.confirmed`, `artist_link.rejected`, `artist_link.unrejected`, `artist_link.repointed`;
- `proposed.song_created` / `_changed` / `_deleted` / `_elevated`, the same four for `version` and `artist`, and `proposed.migrated`;
- `exposure.exposed`, `exposure.unexposed`.

On the archive side Song elevation writes a new `song_edit_history` event, `metadata.elevated` (CHECK widened); Version elevation writes the existing `lyrics_version.added`; Artist elevation writes no archive history (the archive has no artist history table).

### 3.7 The lyrics website

Two changes only: the Users section gets a "Video library" filter (one `RoleFilter` value, no schema change) listing profiles that hold a grant through a definer `video_access_profile_ids()`; and the three read policies gain the exposure arm. Nothing else on the site shows or edits video data.

---

## 4. The write model

### 4.1 Functions

Nothing is written directly. Ten functions in archive ADR-0011 shape: `SECURITY INVOKER` unless noted, gate first (`42501`), static column list, `P0002` on zero rows, history in the same transaction, `revoke execute from anon`, one pgTAP file each. Common signature `(p_op text, p_target uuid, p_payload jsonb, p_expected_updated_at timestamptz, p_edits jsonb)`.

| Function | Ops |
|---|---|
| `write_videos` | insert (scan), update (title, type, song, version, title_latin + source, instagram_id, rutube_id, poster_path), delete (reason required), restore |
| `write_video_chapters` | add, update, delete, confirm, confirm_all, reject, unreject |
| `write_video_artists` | replace (ordered list), confirm_all, reject, unreject, repoint (A → B across all Videos) |
| `write_proposed_songs` / `write_proposed_versions` / `write_proposed_artists` | create, update, delete |
| `elevate_song` / `elevate_version` / `elevate_artist` (definer, §4.4) | one op, `use_existing` |
| `set_song_exposure` (admin) | expose, unexpose |

Read-side RPCs: `video_whoami()` (definer, authenticated only: profile fields, grant level, archive role, `shared_schema`) and `shared_changes_since(p_since)` (§6.2). `video_access` stays unreadable as a table.

*(amended in #126, to archive migration 130; the typed form is `src/shared/archiveWire.ts`.)* The common signature is `(p_op text, p_target uuid, p_payload jsonb, p_expected_updated_at timestamptz, p_edits jsonb) returns jsonb`, and every write returns `{tables: {<table>: [rows]}, tombstones: [...]}`, the shape of `shared_changes_since.tables` (each Video with its complete children, plus the history rows the call wrote), so the browser hands it to `POST /api/cache/apply` as is. `p_edits` is an array of `{event_type, field_name?, old_value?, new_value?, description, reverses?}`: **at least one Edit is required** (else `22023`); the function fills `video_id`, `target_type`, `target_id` and `editor_id = auth.uid()`; the event family must match the function (`video.*`; `chapter.*`; `artists.*` / `artist_link.*`; `proposed.*`; `exposure.*`). The `elevate_*` functions take `p_edits = []` and write their own history. Unknown payload keys are `22023`. Stamps: `update` and `delete` (and `restore`, `reject`) require `p_expected_updated_at`; `add`, `confirm` and `confirm_all` take it optionally. A child write bumps the parent Video's `updated_at` by trigger, archive cascades included.

| Function | Ops and payloads |
|---|---|
| `write_videos` | `insert`: `p_target` is the minted id; payload the columns plus `chapters: [{id?, start_s, title, title_latin, song_id, proposed_song_id, version_id, proposed_version_id, suggested, source}]` and `artists: [{artist_id \| proposed_artist_id, suggested}]`, in order. `update` (stamp): `title`, `type`, `type_suggested`, `song_id`, `proposed_song_id`, `version_id`, `proposed_version_id`, `song_suggested`, `suggestion_source`, `title_latin`, `title_latin_source`, `instagram_id`, `rutube_id`, `poster_path`, and `youtube_id` / `content_hash` as backfill only. `delete` (stamp): `{reason}`. `restore` (stamp): `{}`. |
| `write_video_chapters` | `add` (target = Video, Video stamp optional; the Chapter columns, `id?`); `update` (target = Chapter, stamp; the Chapter columns); `delete`, `reject` (target = Chapter, stamp); `confirm` (target = Chapter, stamp optional); `confirm_all` (target = Video); `unreject` (target = rejection id). |
| `write_video_artists` | `replace` (target = Video, Video stamp, `{artists: [{artist_id \| proposed_artist_id, suggested}]}`); `confirm_all` (target = Video); `reject` (target = link id); `unreject` (target = rejection id); `repoint` (target null, `{from: {artist_id \| proposed_artist_id}, to: {...}}`, exactly one `artist_link.repointed` template Edit, filed once per touched Video). |
| `write_proposed_songs` | `create` (target = minted id; `name`, `english_name`, `alternate_titles`, `notes`, `force?`: `true` skips the dedupe); `update` (stamp; the same columns); `delete`. |
| `write_proposed_versions` | `create` (target = minted id; `song_id \| proposed_song_id`, `label`, `lyrics_*`, `source`, `footnotes_*`, `force?`); `update` (stamp); `delete`. |
| `write_proposed_artists` | `create` (target = minted id; `name`, `force?`); `update` (stamp; `name`); `delete`. |
| `set_song_exposure` | `expose` / `unexpose`. Target = Song id, or Artist id with `{kind: 'artist'}`. Admin only. |
| `elevate_song` / `elevate_version` / `elevate_artist` | `elevate`. Payload `{use_existing?, force?, slug? (Song), confirm_public? (Version)}`; `p_edits` must be `[]`. The bundle also carries `songs` / `song_lyrics` / `artists` and `video_exposed_songs`. A Version under a public Song needs `confirm_public: true`; under a still-Proposed Song it is `22023`. |

Read RPCs: `video_whoami()` (definer, authenticated only; anon gets `42501`) returns `{user_id, email, display_name, avatar_url, must_change_password, archive_role, grant_level (null | 'member' | 'editor'), granted_at, shared_schema, server_time}`, the profile fields null without a profile row. `shared_changes_since(p_since)` is §6.2. `video_access_profile_ids()` (definer, admin only) returns `table(profile_id uuid, level text)` for the lyrics website (§3.7). `video_shared_schema()` returns `1`.

### 4.2 Conflicts and errors

Optimistic: a stale `p_expected_updated_at` on `videos` or `video_chapters` raises `conflict`; the artist-list replace uses the Video's `updated_at`. The UI reloads the row, shows who changed it and when with old → new, and offers **keep theirs** (default) or **apply mine** (a fresh write). Error codes are wire values, messages for humans: `42501` → `forbidden`, `P0002` → `not-found`, `VD409 conflict`, `VD422 duplicate-candidate` (candidate ids as JSON in DETAIL), `VD423 in-use` (count), `23505` on `(video_id, start_s)` → `exists`.

*(amended in #126)* The SQLSTATE is the wire value and HINT carries the same word (`ERROR_CODES` and `readArchiveError` in `src/shared/archiveWire.ts`):

| SQLSTATE | Wire word | DETAIL |
|---|---|---|
| `42501` | `forbidden` | — |
| `P0002` | `not-found` | — |
| `VD409` | `conflict` | JSON `{table, id, updated_at, last_edit}`: the row's current stamp and its last history row (`id, editor_id, event_type, field_name, old_value, new_value, created_at`) |
| `VD422` | `duplicate-candidate` | JSON array of `{kind: archive \| proposed, id, name}` |
| `VD423` | `in-use` | JSON `{count}` |
| `23505` | `exists` | — |
| `22023` | `malformed` (a malformed call: unknown op or key, missing target, stamp or Edit) | — |

Dedupe folds names (lower case, ё → е, whitespace and punctuation collapsed); archive candidates are those the caller can read, which for the definer `elevate_*` includes hidden rows.

### 4.3 Scans, matchers and Latin titles

- On a Video Editor's machine the scan writes through `write_videos`: the insert (`video.scanned`, with the Video's defaults and Chapters), the provenance backfills, and the matchers' Suggested rows. The insert is queued through `pending_share` and drained by the browser (§6.6), so the companion never holds a token for it.
- **Matchers run only on a Video Editor's machine against Shared Videos**, writing only where the pointer is null, no rejection exists and no manual value was ever set; on any machine they run against its Unshared Videos locally. No server job. Suggested flags and sources are Shared: every Member sees one Suggested state, and a rejection by any Video Editor tombstones for all.
- The scan defaults from performances match on `youtube_id` **or** `rutube_id` (import parses the 32-hex id out of rutube.ru performance URLs into `archive_performance.rutube_id`).
- The transliteration module moves to `src/shared/`; the browser computes `title_latin` and sends it with `title_latin_source`. All Latin titles are Shared; `fillLatinTitles` survives only for the scan's filename titles.
- A `local_*` Song, Version or Artist pointed at by a Video being shared becomes a Proposed row in the same drain, Song → Version → Artist order, deduped as in §3.4.

### 4.4 Elevation

`elevate_song`, `elevate_version`, `elevate_artist`: `SECURITY DEFINER`, gated `is_admin_or_moderator() AND is_video_editor()`, a control shown only to accounts holding both. Each: dedupe against the live archive including hidden rows (raise `duplicate-candidate`, or take `use_existing uuid`), insert the archive row **keeping the Proposed uuid**, land it `is_hidden = true` and insert the exposure row, repoint every Video and Chapter (`proposed_* → *`), delete the Proposed row and write its `elevated` tombstone, all in one transaction, writing `song_edit_history` on the archive side and `*.elevated` here. A Proposed Version under an archive Song elevates alone; under a Proposed Song only with or after its Song. Elevation never makes anything public, **with one exception** *(amended in #126)*: `song_lyrics` has no `is_hidden`, so a Version elevated under a public Song is public at once; `elevate_version` refuses it unless the payload carries `confirm_public: true`, and the UI must say so before sending it.

### 4.5 Deletion is soft

`videos.deleted_at`, `deleted_by`, `delete_reason` (non-empty required). Children stay; Member reads filter deleted rows; `write_videos` ops `delete` and `restore`, one history row each. No hard delete in the app; a purge is a console act. A scan on any machine that matches a deleted row warns with the reason and editor; a Video Editor may override (= restore); for a Member the file stays unlisted. Deletion never touches another machine's files. The 11 pre-migration deletions become deleted rows with no children.

Local, for everyone: `DELETE /api/videos/:id/copies` trashes this machine's Copies after a confirmation naming files and sizes; the Video stays, Not on this machine (§7.1); a later scan brings it back. Standalone and Unshared Videos keep today's hard local delete.

### 4.6 Repoint replaces merge

Merging Artist A into B is **repointing**: every `video_artists` link moves (positions renumbered, duplicates dropped), one history row per touched Video, undoable per Video or all at once. The archive row is never deleted; a Proposed source left unreferenced is deleted through `write_proposed_artists` and logged.

### 4.7 Undo

An ordinary new write with the inverse op, never an edit of history, checked against `updated_at` like any write, logged as its own event pointing at the one it reverses. Not undoable: `video.scanned`, `*.suggested`, `*.elevated`, `video.migrated`.

### 4.8 Surfaces

A **history tab** in Now playing's State panel per Video, and a library-wide **Edits** view from the chip menu, filterable by editor and type, with undo buttons for Video Editors only. The conflict notice (§4.2). The Proposed badge and the "use existing / create anyway" prompt. The Elevate control (moderator + editor) and the Expose toggle (admin) on a Song. The Repoint action where merge was.

### 4.9 The client seam

One function, `writeLink(video, op)`, picks the destination: a Shared Video on a Video Editor's machine goes to Supabase through the function above and then `POST /api/cache/apply` hands the returned rows to the companion (`applyShared`, §6.2); an Unshared or Standalone Video uses the companion's existing routes unchanged. The companion stays Supabase-blind except for Sync. Project URL and publishable key live in `src/shared/archive.ts`, committed (the key is public; RLS and the session gate everything), overridable by `TUVA_ARCHIVE_URL` and `TUVA_ARCHIVE_KEY` for tests and branch databases (#93's `TUVA_SUPABASE_*` names are superseded). The committed key is already the `sb_publishable_` one (#130). The overrides are read by the companion, which hands the endpoint to the browser in `GET /api/session`, so one env var points both at a branch database or a mock. No `.env`. supabase-js is in the browser bundle only; the companion's one archive call (Sync) is plain-fetch PostgREST (`postgrestClient` in `archive.ts`).

*(amended in #145)* The seam is `writeLink(video, op, opts?)` in `src/web/writeLink.ts`; the pure mapping (`routeFor`, `localRequest`, `archiveCall`, `writeErrorLine`, `conflictReducer`) is `src/web/writeOps.ts`. Ops: `video.update` (title, Latin title, type, Song, Version), `video.delete` {reason}, `video.restore`, `video.suggest` (matchers), `artists.set`, `artists.remove` (a Suggested link is `reject`ed by link id, a confirmed one removed by `replace`), `artists.confirm`, `chapter.add`, `chapter.update`, `chapter.delete`, `chapter.confirm`, `chapter.reject`, `chapters.confirmAll`. The mode comes from the Session record (`GET /api/session`): a Shared Video on a non-editor machine is refused in the browser, and `video.delete` / `restore` / `suggest` on an Unshared Video are refused (its hard local delete is unchanged). What the spec left open:
- **Stamps reach the browser** on the DTOs: `VideoDto.updatedAt`, `ChapterDto.updatedAt`, `ArtistRef.linkId`.
- **Pointer pairs**: the browser holds effective ids only, so the companion answers `GET /api/kinds?songs=&versions=&artists=` (archive / proposed / local per id) before a Shared write. A Local Song, Version or Artist on a Shared Video is refused with a line until Proposed rows can be made from the UI (#146); it is never sent.
- **Read back**: after `/api/cache/apply` the browser re-reads the Video (or the Chapter by its client-minted id) from the companion, so call sites get the same DTO the local routes return.
- **A Chapter's `title` is sent as `""`, never null**: the archive allows null, the Local copy keeps it NOT NULL and an apply with null would fail.
- **Conflict notice**: who changed it is "You (in another tab or on another machine)" or "Another Video Editor": the Local copy holds no editor names. Apply mine re-sends the op against the DETAIL's `updated_at`; a second conflict reloads and shows the notice again.
- **Matchers on Shared Videos (§4.3)**: `GET /api/suggestions/shared` runs the Performance defaults and the title Song matcher against Shared Videos without writing (only where no Song and no manual value was ever set, never a Local Song; empty unless the machine is a Video Editor's), and the browser writes each as a `video.suggested` Edit through `write_videos` after a scan. The Artist and Chapter matchers on Shared Videos are not wired yet (they still skip Shared Videos).
- **Latin titles from the browser** use the table only (`title_latin_source = 'table'`); the `archive` source (a Song's own Latin name) stays the companion's, for Unshared Videos.
- **Scan warning (§4.5)**: `GET /api/videos/deleted-matches` lists soft-deleted Videos this machine holds a present Copy of (reason, `deleted_by`, files); the bar offers Restore to a Video Editor, "stays unlisted" to anyone else.
- **`DELETE /api/videos/:id/copies`** is same-origin only (§5.2's Origin check), trashes present Copies on mounted Roots, drops those rows and Missing ones, and keeps the Video, its Chapters and its Thumbnail; with no trash command it touches nothing and returns the notice.

---

## 5. Sign-in and session

### 5.1 The dialog

Email and password in a dialog off the chip's "Sign in" button; email prefilled from the Session record when there is one; the app stores no password anywhere. `signInWithPassword` only: the archive has sign-up disabled and email as its sole provider, a password sign-in involves no redirect, so the project needs no new Redirect URL (#84). One-line inline errors in three cases: "Email or password is wrong", "Too many attempts, wait a minute", "The archive can't be reached"; Submit is disabled while the archive is unreachable; the dialog never says which of email or password was wrong. "Forgot password" links to songsofthesteppe.org; after a sign-in with `must_change_password` set, a notice with the same link and the session stays. The app never changes passwords.

Submit is disabled while the browser reports itself offline, or while this browser holds a session and its last probe or Sync found the archive unreachable (#131). A signed-out browser has no probe to refresh that reading, so a stale "unreachable" never locks it out; the attempt itself then shows "The archive can't be reached".

Flow: credentials → `signInWithPassword` → the companion reads the Session record through one `video_whoami()` call → the count of what reconciliation will shelve → confirmation → Sync. Cancel signs out (local scope) and clears the record. As built (#130/#131): `signIn()` runs the first (whoami-only) Sync that writes the record before the confirmation; the count is a placeholder 0 until #117 supplies it, and the pull (#115) is what Continue will start. Closing the confirmation any way but Continue (Esc, the backdrop) is Cancel. An account with **no grant** signs in: avatar on the chip, "No video library access" in the menu with one sentence saying to ask the owner, grid as the last Sync left it, read-only.

### 5.2 The Session record and the token path

- **Session record**: the companion's token-free note in SQLite of who this machine is signed in as: user id, email, display name, avatar URL, grant level, archive role, `last_verified_at`, `last_sync_at`, `watermark`. Written at each Sync, read by the chip, every tab and the TV Server, cleared only by Sign out, a `SIGNED_OUT` event or a cancelled reconciliation. This is the machine fact of §2.1; it grants nothing on its own.
- **The token rides with each Sync call only.** The browser calls `/api/sync` with its access token (never the refresh token); the companion uses it for that Sync (pull, `video_whoami()`, the poster half, §6.5) and forgets it when the job ends or the token's `exp` passes. No `/api/session` push, nothing long-lived on the server, no JWKS verification (#84's server-side verification is superseded; Supabase verifies the token when it is used). Origin and Host checks on every `/api` route that takes a token; the token is never logged.
- Routes (#130): `GET /api/session` → `{record, archive: {url, key}, syncing}` (Host check only: it carries no token, and a same-origin GET sends no Origin); `DELETE /api/session` clears the record (Sign out, a dropped session, a cancelled sign-in; Origin and Host); `POST /api/sync` takes exactly `{access_token}` (Origin and Host; a body with any other key, a refresh token included, is refused) and **the companion calls `video_whoami()` itself** with that token, rather than trusting a whoami result the browser hands over: the record is then what the archive said, not what a page claimed. A token whose unverified `exp` has passed is refused before any call. On an unreachable or refusing archive the record is left as it was. `must_change_password` is not kept in the record; the Sync's answer carries it for the dialog's notice.
- The session persists in supabase-js's `localStorage` on the canonical origin `http://localhost:4400`; the browser is the only thing that refreshes it (rotating single-use refresh tokens forbid a second refresher). A server started with no tab open never Syncs; a TV-only evening uses the last Sync's copy.

### 5.3 While unresolved, and offline

- At launch the grid and the chip render **at once from the Session record**; the browser's session refresh (up to the 2.5 s `authSettled` wait) can only change them afterwards. No spinner.
- Edit controls **show** when the record says editor and are **enabled** only when this browser holds a settled, unexpired session and the last probe or Sync reached the archive. Unsettled counts as offline. With no network, supabase-js reports a null session even though it is on disk (#84), so the record, not the session, decides what the grid is.
- **No cap** on an offline Member and **no idle timeout** (the archive's 60-minute idle and away sign-outs are not carried over). Revocation probe (`getUser`) on window focus and before each Sync only, never on a timer. The project's **session time-box and inactivity limit must be off** (Dashboard → Auth → Sessions), or every long-offline machine ends as "session ended".
- A browser with **no stored session but a Session record** (cleared site data, `127.0.0.1`, a second `TUVA_PORT`) leaves the record alone: chip says "Sign in", the grid stays the Member view read-only, the TV still sees a Member. Other origins sign in on their own.
- Several tabs: the session propagates by `localStorage`; the companion runs **one Sync at a time** and coalesces a request arriving during one; tabs re-read `/api/session` and the watermark on window focus. No push channel.

### 5.4 Dropped sessions

A dead refresh (revoked, reuse detected, time-boxed): chip reverts to "Sign in", a dismissable banner "Your session ended. Sign in again." (the same line for `session-ended` and `revoked`, with a Sign in button), record cleared, everything else kept read-only. Re-sign-in runs the normal reconciliation, a no-op confirmation unless Unshared Videos were scanned meanwhile.

How it is detected (#130): a `SIGNED_OUT` this tab did not start while the companion still holds a record is a dropped session (a tab's own Sign out clears the record before calling `signOut`, so the other tabs' `SIGNED_OUT` finds it gone and reads as a sign-out). The revocation probe's `getUser()` is the other path: the archive's `session_not_found` reaches the client as supabase-js's `AuthSessionMissingError` and supabase-js drops the stored session itself. Because the record is cleared, the reason lives in the browser's session state (`ended`: `session-ended` or `revoked`), broadcast to every tab with the dismissal. supabase-js keeps a session whose proactive refresh failed while the access token is still valid, so a dead refresh shows only once the access token expires (up to an hour later), not at the failed refresh.

---

## 6. The Local copy and Sync

### 6.1 Tables in `library.db`

- **Local copy**: every Shared table as it sits here. The `mirror_*` tables become `archive_song`, `archive_version`, `archive_artist`, `archive_performance` (with `rutube_id`), `archive_track`, `archive_album` and the credit tables; the `video_*` tables keep their Supabase names, uuid keys as TEXT. `mirror_import` and the import command go.
- **This machine's own rows**: `local_song`, `local_version`, `local_artist`, pointed at by Unshared Videos only. `song_all`, `version_all`, `artist_all` union three sources with `kind` archive | proposed | local. The old `artist` table and `mirror_id` go.
- **Side tables**: `video_local (video_id, favorited_at, resume_s, last_played_at, view_count, loop_a_s, loop_b_s, thumbnail_*, strip_*, poster_hash, pending_share, shared)` and `chapter_local (chapter_id, favorited_at)`; `copy`, `root`, `video_audio`, `studio_*`, `studio_rejection` stay, re-keyed to the uuid. `video_local.shared` is 1 once a Sync or a cache apply delivered the Video: the companion's one way to tell a Shared Video from an Unshared one (the matchers, the Latin fill and the hard local delete touch only `shared = 0`). Shelved edits in their own table (`shelved_edit`). *(Amended in #112, corrected in #137: thumbnail files were named by the integer id, `<n>.poster.webp`, and the #21 seed cache's by the Video's `content_hash` or `youtube_id`; at every startup the companion renames each to `<uuid>.{poster,strip}.webp`, integer ids under the migration's map and the other two by one query on the Videos. Idempotent, never overwrites an existing uuid file (integer names go first), leaves a file that matches no Video in place, and logs the counts per naming style.)*
- **Pointer pairs here** *(added in #112)*: `song_id` / `version_id` / `video_artists.artist_id` hold an archive row or, on an Unshared Video, a `local_*` row; `proposed_*` hold Proposed rows. The Local copy has no foreign keys to the archive tables (RLS decides which archive rows a machine holds). The companion reads through views with one effective pointer per pair: `video_full` (videos + `video_local`, soft-deleted Videos left out), `chapter_full` (+ the Favorite), `video_artist_full`. Latin names of Artists of every kind are derived here into `artist_latin` (the archive's `artists` carry none). A Chapter keeps `title_latin_source` beside `title_latin`, as Videos do. *(amended in #126: archive migration 130's Chapters have no `title_latin_source`, so on a Chapter it is a Local-only column, never sent or received; and the Local copy keeps `videos.type`, `video_chapters.title` and `video_chapters.source` NOT NULL where the archive allows null, so a row breaking that fails its batch. Migration 0017 renames and adds the columns of 130.)*
- **The integer → uuid map** *(added in #112)*: migration 0015 gives the old integer rows the deterministic uuid `printf('<prefix>-0000-8000-8000-%012x', id)`, prefix `76696400` for Videos, `63687000` for Chapters, `61727400` for Local Artists (`legacyUuid` in `src/server/localCopy/ids.ts`); archive Artists are known by their archive uuid. The migration script (§9.2) recomputes the same ids. Artist links and rejections get fresh surrogate uuids.
- **`updated_at` here**: a local write to `videos`, `video_chapters` or `video_artists` stamps `updated_at` by trigger unless the statement sets it; `applyShared` always sets it and skips a row whose incoming `updated_at` is not newer than the held one (equal included). `shared_tombstone`'s `table` column is named `table_name` (a reserved word).
- **Meta**: `shared_schema` integer in the `meta (key, value)` table; a migration that reshapes a Shared table bumps it in the same SQL file (and `SHARED_SCHEMA` in `src/server/localCopy/meta.ts`). The Session record is its own one-row table `session_record` (token-free, §5.2) holding the watermark.
- A Standalone library has the same shape with only its own rows. With the import gone, the archive rows a machine held before #112 (the Mirror, now `archive_*`) stay as they were until the first Sync (#115) refreshes them.

### 6.2 Pull and apply

- **Pull**: `shared_changes_since(p_since)` over every Shared table (`SECURITY INVOKER`, so RLS filters it per caller), applied by one `applyShared(rows)` in one SQLite transaction: children replaced wholesale per bumped parent (the write functions bump the parent `updated_at` whenever a Chapter, Artist link or rejection changes), each upsert **skipped when the incoming `updated_at` is older than the row held** (the pull-vs-push guard). `POST /api/cache/apply` uses the same function. Watermark = max `updated_at` seen, from the server; next pull from watermark − 5 min (the `now()` overlap).
- **The pull's shape** *(amended in #126, migration 130)*: `shared_changes_since(p_since)` (invoker; `42501` without the grant; `null` asks for everything) returns `{shared_schema, server_time, since, watermark, tables, replace_whole, tombstones, archive_ids}`. `tables` holds `videos`, `video_chapters`, `video_artists`, `video_chapter_rejections`, `video_artist_rejections`, `video_proposed_songs`, `video_proposed_versions`, `video_proposed_artists`, `video_exposed_songs`, `video_edit_history`, `songs`, `song_lyrics`, `artists`, `song_performances`, `albums`, `album_tracks`, `album_track_artists`, `album_artists`. Each Video in `tables.videos` comes with its complete child set, soft-deleted Videos included; tables with `updated_at` carry only changed rows, except that **newly Exposed Songs and Artists arrive by exposure time** (with their Versions and Performances) even when their own rows are old. `replace_whole` is `["video_exposed_songs", "album_tracks", "album_track_artists", "album_artists"]`: always sent complete (the last three have no `updated_at`, about 140 kB), so `applyShared` replaces them wholesale (and rebuilds the index only when their content differs). `archive_ids` lists every `songs`, `song_lyrics`, `artists`, `song_performances` and `albums` id the caller can read: the ids-only reconcile of §6.3, applied in the same transaction. `watermark` is the greatest `updated_at` / `at` returned, or `p_since` when nothing changed; the Session record keeps the server's. A batch whose `shared_schema` differs from the checkout's is refused whole.
- **Indexing**: after apply, reindex each changed Video, Chapter, Artist, Song and Version; a changed Song also reindexes its Videos and Chapters; above 200 changed rows one `rebuildSearchIndex`.
- **Failure**: rollback leaves the watermark untouched; a 401 runs the revocation probe; a permission error re-reads the grant and updates the Session record; the chip's Sync row shows the last error in one line. Sync backs off and retries, which also covers a paused Free project.
- **As built** *(amended in #139)*: the record's watermark **never moves back**. When nothing changed the server answers `watermark = p_since` (the held watermark − 5 min); keeping that, as "the Session record keeps the server's" read literally, would walk the window back 5 minutes per empty Sync. The record keeps the later of the held and the returned watermark; a full refetch takes the server's as it is. `last_sync_at` is the companion's clock, not `server_time`, because the focus trigger compares it with the browser's clock. With no timers (§6.4), "backs off and retries" is the focus trigger's back-off: after *n* failed Syncs in a row, focus waits 1, 2, 4, 8, then 10 minutes from the last failure; the chip's button, an editor's write and Refresh all always run. A permission error (`42501`) on the pull calls `video_whoami()` again and writes the grant it reports. The wipe of a full refetch and the apply run in one SQLite transaction, so a failed full refetch wipes nothing. After a pull that changed archive rows (and after every full refetch), Sync runs the retired import's follow-ups (`runArchiveFollowUps`: defaults, title Songs, Latin fill, Artist suggestions, index rebuild; Unshared Videos only). A failed follow-up is logged and does not fail the Sync.

### 6.3 Deletes and tombstones

Videos arrive soft-deleted (§4.5): no Video tombstones. `shared_tombstone` only for Proposed rows (`deleted` or `elevated`), 90-day retention. An **ids-only reconcile** for the archive's rare hard deletes of Songs, Versions and Artists runs at **every Sync** (under 150 KB). *(amended in #126)* It rides in the pull as `archive_ids` (also Performances and Albums), and it also drops rows that left the caller's RLS view (an unexposed hidden Song). **No retention purge job exists yet**: migration 130 does not delete tombstones older than 90 days; until a console script or pg_cron job lands (ticket #127's list), tombstones only accumulate and "watermark older than retention" (§6.4) never triggers.

### 6.4 Triggers and repair

- **Triggers**: sign-in completes; launch while signed in; after a Video Editor's own write (applied to the Local copy in the same step); the chip's button; **window focus when the last successful Sync is older than 10 minutes**. No timer, no network-regained trigger (#86's 60 s poll is superseded).
- **Repair (full refetch)**: first sign-in (empty watermark); `shared_schema` change; watermark older than retention; the Settings entry "Refresh all Shared data". *(amended in #139)* Every full refetch is `POST /api/sync {access_token, full}` with `p_since = null`, after a wipe in the apply's transaction. The wipe empties the `archive_*` tables, the Proposed tables, `video_exposed_songs`, `video_edit_history` and `shared_tombstone`. Shared Videos are **not deleted**, because their Copies, Favorites, resume points and Chapter Favorites cascade from them. Their `updated_at` drops to the epoch instead, so the pull overwrites each one and replaces its children. A Shared Video that the full pull does not return stays as it was. A "`shared_schema` change" is detected through `meta.synced_shared_schema`, the `SHARED_SCHEMA` the last pull was applied under. Retention is measured from whoami's `server_time`. An account switch starts a fresh record, which has an empty watermark and so gets a full refetch. An account without the grant pulls nothing.
- **Triggers as built** *(amended in #139)*: one pure rule (`syncWanted` in `src/shared/session.ts`). Sign-in always Syncs. The other triggers need this browser's session to belong to the record's user. Launch waits for a settled session. The hook exposes `afterWrite()` (for #116) and `refreshAll()`, and the chip uses `requestSync()`. A 401 in a Sync response runs the revocation probe. The hook also exposes `progress` (`checking` the session, then `pulling`), `lastSyncAt` and `schemaMismatch` (`{client, archive, behind, line}`). `schemaMismatch` is set from any Sync that reached whoami, is kept through an offline Sync and is cleared by a successful Sync.
- **Schema gate**: `video_whoami()` returns the archive's `shared_schema`; the client compares it with its own constant. Client behind → Sync stops, a persistent banner above the grid says "Update TuvaVideos: git pull, then restart", browsing and playback continue from the Local copy. Client ahead (a migration not yet applied in the archive) → Sync stops with a banner naming the mismatch. Both clear at the next successful Sync.

### 6.5 Posters

- One **private** `posters` bucket, `image/webp` only, immutable paths `<video uuid>/<sha256 prefix>.webp`, `poster_path` on the Video row written through `write_videos` with history. RLS on `storage.objects`: `SELECT` for `authenticated` **holding the grant**, `(select is_video_member())` *(amended in #126: a signed-in account without the grant reads no poster)*; `INSERT`/`UPDATE`/`DELETE` only when `(select is_video_editor())`; no anon policy. The bucket's limit is 1 MiB, and `INSERT` checks the path against `^<uuid>/[0-9a-f]{8,64}\.webp$` *(amended in #126)*. Standalone never creates a Supabase client and makes zero Storage requests.
- **Download is the second half of the Sync job**: after apply, the companion fetches posters whose `poster_path` has no matching local file, 4 at a time, with the Sync's token until the job ends or the token's `exp`; the remainder resumes next Sync; the grid is usable throughout. On disk one file per Video, `thumbs/<uuid>.poster.webp`; `video_local.poster_hash` records which Shared object it holds (null = locally generated); Sync re-downloads when the hash differs; the thumbnail pool generates a poster only when there is no `poster_path`. Shared poster wins; the grid falls back to a locally generated poster, then the no-image card.
- **Upload by the browser**, never the companion (#85's companion upload is superseded): on a Video Editor's machine, online, a Shared Video with a local poster and no `poster_path` is uploaded 4 at a time in the background after each scan and at each Sync: bytes from the localhost thumbs route, supabase-js upload (`contentType: 'image/webp'`, `cacheControl: '31536000'`, `upsert: false`), `write_videos` sets `poster_path`, then `/api/cache/apply`.

### 6.6 Scans and `pending_share`

A scanned Video the Local copy does not know is inserted with `pending_share` in `video_local` on a Video Editor's machine. After each scan and at each Sync the browser drains the queue through `write_videos` (one call per Video with its defaults and Chapters, Proposed rows first, §4.3), then `/api/cache/apply` clears the flag. Offline, the queue waits and those Videos are playable and taggable meanwhile. On a Member's or Standalone machine the flag is never set: the Video is Unshared.

**One question per machine**: at the end of the scan that filled the queue, or right after the first Sync of a session that signed in as a Video Editor with Unshared Videos present, the browser asks "Share n new Videos from <folder>?", showing how many have no YouTube id, Instagram shortcode or Rutube id. Never mid-scan, never offline. After one "Share", later drains are automatic. Declining leaves the queue waiting and the Videos Unshared; the chip row **Share n new Videos…** opens the same question while the queue is non-empty.

---

## 7. The grid and the Player

### 7.1 Two states replace "No Copy mounted"

- **Unmounted**: a Copy exists on a Root that is not mounted. Card and Player as today: dashed drive icon, "plug the drive in" overlay, auto-resume when the Root returns.
- **Not on this machine**: no Copy row, or every Copy `missing_since`, or trashed. The card is the existing greyed poster (`.thumb.unavail`) plus **one small download mark** in the corner; title and tags stay; the "n copies" and availability icons go. The click-through is the ordinary card link: where the Player would be, a panel over the blurred poster says "Not on this machine", carries the message ("This Video's link data is here; its file is not. Download it into one of your Roots and it plays.") and the Video's source link (YouTube watch URL, Instagram post or `rutube.ru/video/<id>/`). Title, tags, Chapters, the history tab and the Lyrics drawer sit under it as usual. The panel gives way live when a scan finds a Copy, as the unmounted overlay does today.

### 7.2 Filters

The "Available only" chip becomes **"On this machine"**, default off, hidden when it would select nothing. The `#available` search token keeps working.

### 7.3 What a Member sees

A Member's library reads like the owner's: the grid as today with the one mark. Edit controls (`+ add`, Relocate, Delete from library, Rescan of Shared rows, confirm and reject) are **hidden** for a Member; for a Video Editor they are **disabled with a notice** when offline or unsettled. Trash this machine's Copies, Favorites, Resume, Audio, Playlists and Studio are everyone's.

### 7.4 Shelved edits

A small marker on a Video with Shelved edits opens a read-only drawer listing them; a Video Editor has a "copy back" action per item (an ordinary write); "Clear" per Video, and all at once from the chip menu.

### 7.5 Proposed and Exposed in the UI

Proposed Songs, Versions and Artists carry the Proposed mark wherever their name appears (grid tags, Now playing, search results, pickers). An Exposed hidden Song reads as any other Song to a Member. The Elevate and Expose controls live on the Song where its archive actions would be, shown only to accounts that may use them.

### 7.6 The TV Server as a Member

The TV Server reads the Local copy unchanged through the same handle; its video lists exclude Not on this machine Videos and keep Unmounted ones as today. Nothing else in the TV spec changes.

---

## 8. Onboarding from source

### 8.1 Who gets in

The repo is public; cloning needs nothing. Being a Member or Video Editor is the grant: the README says to create an account on songsofthesteppe.org and ask the owner for video access; the owner runs `bun scripts/grant-video-access.ts <email> <level>` (calls the archive's `create-user` when the account is new, inserts the grant, prints the temporary password handling), and the sign-in dialog's "no grant" message says the same. Grants are never made from either app's UI. *Built in #124:* the script reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the environment (never committed), finds the account by email through the Auth admin user list (the auth user id is the `profile_id`), calls `create-user` with `{ email, full_name? }` when there is none, upserts `video_access` on `profile_id` through PostgREST, and prints the next step (a new account changes its temporary password on songsofthesteppe.org first). `--revoke` deletes the row; `--dry-run` only reads, and with no key prints the plan. Because it goes through PostgREST, "no grants" on `video_access` (§3.1) means none to `anon` and `authenticated`: `service_role` keeps its table privileges.

### 8.2 Platforms

All in scope, macOS tested. README: "Developed and tested on macOS. Linux and Windows are supported in the code but untested; please open an issue with what breaks." Companion shims: trash resolves per platform (macOS `/usr/bin/trash`; Linux `gio trash`, then `trash-put`; Windows a PowerShell Recycle Bin call) and with none found, deleting offers only the entry-only delete with a notice; (*#124:* `src/server/platform.ts`; `TUVA_TRASH` overrides the command for tests; `/api/health` reports `trash: { available, command | notice }` and a media delete with no command keeps every file and returns the `notice`, for the dialog in #125) the tab opens with `open` / `xdg-open` / `cmd /c start`; data dir `~/Library/Application Support/TuvaVideos`, `$XDG_DATA_HOME/TuvaVideos` (default `~/.local/share/TuvaVideos`), `%APPDATA%\TuvaVideos`; `TUVA_DATA_DIR` overrides everywhere. The `.app` launcher stays macOS-only.

### 8.3 Install

Bun is the one manual install (per-platform lines for Bun, ffmpeg and webp in the README). Then `bun install`, `bun run setup`, `bun run start`. **`bun run setup`** (TypeScript, run by Bun) checks Bun ≥ 1.4 (pinned in package.json `engines`), ffmpeg, ffprobe, cwebp and the platform's trash command, creates the data dir, prints one line per check with the install command for anything missing, exits non-zero while something required is missing, reports yt-dlp, ImageMagick and a trash command as optional, and does not start the app. The trash check is optional (deleting falls back to entry-only, above), not required. *#124:* install commands are Homebrew on macOS, apt on Linux, Scoop on Windows.

### 8.4 First launch

The empty Standalone grid with two independent calls to action, **Choose a videos folder** and **Sign in**, in either order. The Root is a text field for an absolute path (`~` expanded), checked by the companion (exists, is a directory, readable; inline errors "Not found", "Not a folder", "Can't read it"); saving inserts the `root` row and **starts the first scan at once** (the no-scan-at-startup rule holds for later launches). The hard-coded default leaves `config.ts` (tests keep `TUVA_LOCAL_ROOT`); the owner's existing `root` row carries on; one Root per machine until the control center tab edits Roots. **A Member may run with no Root**: the whole Shared grid shows as Not on this machine; the Root field then opens from a one-line dismissable bar above the grid ("No videos folder yet"), dismissal remembered per machine. The Studio probe at startup is unchanged.

As built (#125): text that is not an absolute path after `~` expansion gets a fourth inline error, "Enter the folder's full path"; "readable" means one directory entry can be read (opening alone passes an unreadable folder under Bun). The surface is a pure function of the mode and the Root count (`src/server/rootSetup.ts`): no Root and no grant (Standalone or no-grant) shows the panel; no Root with the grant (Member **or Video Editor**) shows the bar; a Root shows neither. Routes: `GET /api/onboarding` (`{mode, rootCount, show}`), `POST /api/roots {path}` (same-origin only; 422 with the inline error, 409 once the machine has a Root; inserts a `local` row, checks it and queues its scan even on a passive server, since it is an explicit action), `POST /api/onboarding/dismiss-bar` (writes `meta.root_bar_dismissed` in `library.db`, which is what "per machine" means). The panel's **Sign in** button stays disabled until the sign-in dialog (#114) passes its handler in.

### 8.5 Filenames, updating, README

The README explains yt-dlp's `[id]` suffix with the one-line template `%(title)s [%(id)s].%(ext)s` and the `instagram-` and `rutube-` prefixes; files without an id scan in as hash-identified Videos. Updating is `git pull && bun install`; SQLite migrations run at launch; the schema gate (§6.4) tells a stale checkout to update. README sections in order: what it is; Run from source; First launch (folder, sign in, getting a grant); Filenames; Updating; Player keys; Maintainer commands (the current one-off table, marked as the owner's).

---

## 9. Testing, the one-time migration and cutover

### 9.1 Test on seeded content, not the real data

The schema goes live (§10, HITL) with every `video_*` table empty; RLS shows them to nobody, so the live project carries seeded content for the length of testing without touching the lyrics website.

- **`bun scripts/seed-shared.ts`**: generates small ffmpeg test clips (colour bars and tone, a few seconds) named `<title> [<fake 11-char id>].mp4`, some with `[instagram-…]` and `[rutube-…]` suffixes and some id-less, into a test Root; writes matching Shared Videos pointing at real archive Songs, Versions and Artists (reads only), Chapters, Suggested rows, rejections, a soft-deleted Video, and Proposed Songs, Versions and Artists named `zz-test-…` (the archive's convention for test rows); uploads their posters; and records every id it created, bucket object included, in a manifest file. `--purge` deletes by manifest.
  *(amended in #132)* Eleven clips, 3–8 s, mp4/mkv/webm, into `<root>/zz-test-seed/`; fake YouTube ids are `zzTest` + 5 digits, Rutube ids 32 hex starting `7e57`; id-less (and Instagram/Rutube) Videos carry the clip's sha256 as `content_hash` (§3.2's CHECK), so clips are generated before any write. Flags: `--root`, `--manifest` (default `<root>/zz-test-seed.manifest.json`), `--dry-run`, `--clips-only`, `--purge <manifest>`, `--delete-test-accounts <emails>`; env `TUVA_ARCHIVE_URL`, `TUVA_ARCHIVE_KEY`, `TUVA_SEED_EMAIL` (or `--email`), `TUVA_SEED_PASSWORD`, `TUVA_ARCHIVE_SERVICE_KEY`. The seed writes through the write functions only (as the test Video Editor, checked with `video_whoami`); **purge cannot**, because `write_videos delete` is soft and history is append-only for clients, so it deletes the manifest's rows (and history by `video_id`) and the bucket objects with the service-role key, removes the clips, and verifies every `video_*` table but `video_access` and the `posters` bucket are empty. `--delete-test-accounts` refuses any email whose local part lacks `test`.
- **Test accounts**: `grant-video-access.ts` makes a test Video Editor, a test Member and a no-grant account with clearly test-named emails; they are deleted at cutover.
- **Two test machines on one Mac**: `TUVA_DATA_DIR` + `TUVA_PORT` per machine, each with its own test Root, one signed in as the editor and one as the Member (the second origin signs in on its own, §5.3). The owner's library on the default data dir is never touched. The TV reads one of them.
- **Elevation** writes into the archive's own tables, so it is covered by pgTAP (rolled back) and once by hand on a `zz-test` Song that the owner deletes as admin afterwards. Exposure is tested on one real hidden Song and unexposed afterwards.
- **Test plan**: `docs/sharing-test-plan.md`, one scenario list per mode (Standalone, Member, Member offline, Video Editor, editor + moderator, admin), covering reconciliation, Shelved, conflicts, undo, soft delete, Repoint, posters both ways, `pending_share`, the schema gate, dropped sessions, first launch and the setup script on a fresh data dir. The build agent runs `bun test` and drives both machines in the browser against it; the owner then runs the same plan by hand. Fixes are follow-up tickets before cutover.

### 9.2 The one-time migration

A Bun script in this repo, run once with the service-role key after the archive migration is live and the seed is purged. It **refuses to run unless every `video_*` table and the posters bucket are empty**, so a forgotten purge cannot mix with the real data. It also refuses, printing the list, while any of these are unresolved in `library.db` (re-counted at run time): the 5 near-duplicates from #87, the 6 working-note Version labels, the 21 unreferenced Local Songs. It then:

- maps the integer Video and Chapter ids to uuids; carries the Artist links, the 11 deletions (as soft-deleted rows), the Chapter and Artist rejections, every Suggested flag and source, every Latin title, every poster (uploaded, `poster_path` set), the Instagram and Rutube provenance;
- writes the referenced Local rows as Proposed rows in Song → Version → Artist order, maps Local Artist Andrei Mongush onto the live archive row, deletes Song *eir* and Artist *aiah*;
- writes one `video.migrated` history row per Video and per Proposed row;
- prints the 351 Videos on hidden Songs as the initial exposure list for the owner to confirm, then exposes them.

*(amended in #113: `scripts/migrate-shared.ts`, pure parts in `src/server/migrateShared/`.)*

- **Credentials.** Migration 130's gates read `auth.uid()` (`is_video_editor()`, `get_my_role() = 'admin'`), which a service-role call does not have, so the service-role key (`TUVA_ARCHIVE_SERVICE_KEY`, env only) mints a session for the owner (`TUVA_MIGRATE_AS`, Auth admin `generate_link` magiclink + `verify`, no email sent), and every write function runs as the owner: the history's `editor_id` is the owner, and the owner must hold the editor grant and the archive admin role. The key itself is used for the emptiness checks, the poster uploads and the two writes no function takes: the rejection rows (no op writes a rejection without a Chapter or link to reject) and the library's `videos.created_at` (the functions stamp `now()`). Andrei Mongush's archive id is read by name with the publishable key (`TUVA_ARCHIVE_URL`, `TUVA_ARCHIVE_KEY`).
- **History.** Proposed rows get `proposed.migrated`, not `video.migrated`: `write_proposed_*` take only the `proposed.*` family. A deletion is carried as `insert` (`video.migrated`) then `delete` (`video.deleted`, the library's date in `new_value`).
- **Ids.** The Local copy already holds the deterministic uuids (0015), so ids are carried as they are; a Local Song, Version or Artist becomes the Proposed row of the same id. A `deleted_video` row gets `64656c00-0000-8000-8000-<n as 12 hex>`; one whose identity is a live Video again is not carried.
- **Refusals**, re-counted every run: the #87 names (matched loosely: lower case, search fold, j -> y, punctuation dropped, letter runs collapsed), any Local Song or Artist that meets another Local row or an archive row that way (or would hit the dedupe's exact fold), the 6 working-note labels (7 Versions), the unreferenced Local Songs (eir excepted: dropped), and Version pointers the composite FK would refuse. `--accept "<name>"` acknowledges a reviewed near-duplicate. Unreferenced Local Artists are dropped, not refused.
- **Exposure** covers the hidden Songs that Videos **or Chapters** point at.
- **Re-runnable.** A resume marker (`<data dir>/migrate-shared.state.json`) lets a run start on a target holding only rows it planned; what is done is read back from the target. `library.db` is read through a migrated temporary copy, never written.

### 9.3 Cutover (HITL)

Purge the seed and the test accounts; run the migration; confirm the exposure list; sign in on the owner's machine (reconciliation is a no-op); the Mirror tables were already renamed `archive_*` by the companion's migration (#112) and the first Sync refreshes them; `bun run import` and the backup import already left the README in #112. ADR 0001 is retired with the Mirror (ADR 0009).

---

## 10. Implementation plan

Build tickets run on Claude Opus 5.5 (`claude-opus-5-5`), one per ticket in its own worktree on branch `task/<slug>`, chained by GitHub issue dependencies. Phase A builds, Phase B tests on seeded content, Phase C cuts over.

| # | Ticket | Scope | Blocked by |
|---|---|---|---|
| 1 | `archive-schema` | In the Lyrics Website checkout, by that repo's rules: migration 130+ (tables §3.1, `video_access`, helpers, exposure arm, ten functions, `video_whoami`, `shared_changes_since`, storage policies), pgTAP files incl. "anon reads no `video_*` table", the Users-section filter, a `docs/adr/0016` there, CLAUDE.md and RULES.md lines, Prisma types; the drift check first; live apply is HITL. | — |
| 2 | `local-copy` | Companion schema: uuid keys, `archive_*`, `local_*`, `*_all` views, side tables, `shared_schema`, `rutube_id` + backfill, `applyShared`, Mirror import removed, platform shims for data dir. | — |
| 3 | `migration-script` | §9.2 with preflight, refusal rules and the exposure list. | 1, 2 |
| 4 | `sign-in` | Chip, dialog, Session record, `video_whoami`, revocation probe, banners, `src/shared/archive.ts`. | 1 |
| 5 | `sync` | Pull/apply, tombstones, triggers, repair, schema gate, posters both ways, `pending_share` drain and the first-share question. | 2, 4 |
| 6 | `write-model` | `writeLink`, `/api/cache/apply`, conflicts, Proposed UI, Elevate and Expose controls, Repoint, soft delete, trash Copies, history tab, Edits view, Shelved drawer, matchers on the editor's machine, Latin titles in the browser. | 5 |
| 7 | `member-grid` | Unmounted and Not on this machine, the panel, On this machine chip, hidden and disabled controls, reconciliation confirmation, TV exclusions. | 5 |
| 8 | `onboarding` | Trash and open shims, `bun run setup`, Root field and first scan, `grant-video-access.ts`, README, `engines`. | 2 |
| 9 | `test-fixtures` | `seed-shared.ts` with clips, manifest and `--purge`; test accounts; the two-machine runbook; `docs/sharing-test-plan.md`. | 1, 2 |
| 10 | `verification` | Phase B: schema live (HITL), seed, `bun test`, the agent's browser pass on both machines against the plan, fixes as follow-ups, then the owner's pass. | 3–9 |
| 11 | `cutover` | Phase C, HITL: purge, migrate, expose, retire the Mirror. | 10 |

1 and 2 start together; 3, 8 and 9 follow 2; 4 follows 1; 5 needs 2 and 4; 6 and 7 follow 5 and touch different files.

---

## 11. Later

- The control center tab from the avatar chip: Roots, Settings, "Refresh all Shared data" moves there.
- The in-app yt-dlp downloader, and with it the general source model (§3.2) and a downloading guide for Members.
- A packaged, signed Mac app.
- Supabase Realtime, if the handful of editors ever want to see each other's edits mid-session.
- Removing Studio playback.

## 12. Out of scope

- The lyrics website showing or editing video data beyond §3.7.
- Helping collaborators download video content.
- Queued offline edits with conflict resolution.
- Reviewer-level video edits or any grant narrower than Video Editor.
- Per-account Favorites or Resume; two accounts on one machine.
