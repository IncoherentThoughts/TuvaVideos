# Keeping the SQLite cache coherent with Supabase

Research for issue #86 (map #82). Question: the Bun server keeps a SQLite copy of the **Shared** tables for the Player, the search index and offline browsing, while every edit goes from the browser straight to Supabase with the user's session. Which strategy keeps that copy coherent? What does each candidate cost in requests and complexity, how do deletes propagate, how do the FTS index and Latin titles follow, and what happens offline?

Vocabulary follows `CONTEXT.md`, **Sharing** section.

## Answer in brief

Use **one watermark pull plus a local push from the browser**:

1. **The pull.** The server calls one `SECURITY INVOKER` RPC, `shared_changes_since(watermark)`, which returns every Shared row whose `updated_at` is past the watermark, plus every tombstone written since then. It calls it on launch, on sign-in, when the network comes back, when a browser tab gains focus, and every 60 s while a tab is open.
2. **The push.** After each successful write, the browser POSTs the rows the write RPC returned to `localhost`. The server upserts them and reindexes just those rows. The editor sees their own edit at once, with no extra Supabase request.
3. **Repair.** A full refetch runs on the first sign-in and whenever the watermark is too old to trust. An ids-only reconcile on launch catches deletes that left no tombstone.

Leave Realtime out for now; it can be added later as a "pull now" signal. Do not use the edit history as a change feed.

At five machines this comes to roughly 2,500 small requests a day, almost all of them empty. Deletes travel as tombstones. FTS and Latin titles follow through the incremental functions that already exist. Offline, the server serves the cache and catches up from the watermark when the network returns.

## Sources

- **This repo:** `src/server/mirror.ts` (`importMirror`), `src/server/import.ts` (`runImport`, the order of the follow-ups), `src/server/search.ts` (`rebuildSearchIndex` and the per-row `reindexVideo`, `reindexChapter`, `indexArtist`, `indexSong`, `indexVersion`), `src/server/latin.ts` (`fillLatinTitles(db, { videoId | chapterId })`), `src/server/edit.ts` (how a local edit reindexes one row today), `docs/data-model.md`.
- **The archive** (`/Users/evanwilliams/Desktop/Lyrics Website`): `CLAUDE.md` (write model, ADR-0011 transactional `write_<concept>` RPCs, deletes), `supabase/migrations/001_profiles_and_rls.sql` (the `update_updated_at()` trigger function), `supabase/migrations/021_song_edit_history_overhaul.sql` (history table shape), `supabase/config.toml` (`max_rows = 1000`), and the backup `Backups/supabase_backup_20261007_162813_no_media/` for row counts and edit rate.
- **The live archive catalog**, queried read-only on 2026-10-16 through `pg_trigger`, `information_schema.columns` and `pg_publication_tables`.
- **Supabase docs:**
  - Postgres Changes: <https://supabase.com/docs/guides/realtime/postgres-changes>, sections "Receiving old records" and "Limitations".
  - Realtime limits: <https://supabase.com/docs/guides/realtime/limits>.
  - Realtime Messages billing: <https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages>.
  - Postgres Changes troubleshooting: <https://supabase.com/docs/guides/troubleshooting/realtime-postgres-changes-troubleshooting>.
- **PostgREST:** <https://docs.postgrest.org/en/stable/references/api/tables_views.html>, horizontal filtering (`gt`, `gte`) and `order`.
- **supabase-js / realtime-js 2.112.3**, read in the archive's `node_modules`: `@supabase/realtime-js/dist/main/lib/websocket-factory.js`.
- **Local timings** from `~/Library/Application Support/TuvaVideos/log.txt`.

## 1. What exists today

- **The import replaces everything.** `importMirror` runs one transaction that does `DELETE FROM` every `mirror_*` table, inserts the mapped backup, upserts `artist` by `mirror_id` and records a `mirror_import` row. `runImport` then runs, in this order: Performance defaults, Song-from-title suggestions, `fillLatinTitles(db)` over every row, the Artist matcher, `rebuildSearchIndex(db)`, then the Studio matcher. The order matters: each step reads the previous step's rows, and the Latin titles must exist before indexing because they are part of the indexed text.
- **Full rebuilds are cheap.** The log records `rebuildSearchIndex` at 163–204 ms for 13,261 rows (2,166 video, 924 chapter, 157 artist, 208 song, 8,534 lyric). The last full import with follow-ups took 1,158 ms.
- **Per-row maintenance already exists.** `edit.ts` handles a single-Video edit by calling `fillLatinTitles(db, { videoId })` and then `reindexVideo(db, id)` inside one transaction. Equivalent functions exist for Chapters, Artists, Songs and Versions. A cache that applies changes row by row can reuse these functions as they are.
- **Local and Shared columns share the `video` row.** `favorited_at`, `resume_s`, `last_played_at`, `view_count`, the thumbnail and strip geometry are all columns on `video`, next to `title`, `type` and `song_id`. `copy.video_id`, `chapter`, `video_artist` and `chapter_rejection` all reference `video.id`. **So wipe-and-replace cannot be carried over to the Shared Video tables.** Deleting `video` rows would cascade into, or orphan, Copies, Favorites and Resume positions. Any strategy must upsert by a stable Shared identity, a uuid or `youtube_id`, and leave the local columns untouched, or move the local columns into a local table keyed by that identity. The schema ticket (#83) should decide which. This holds for every option below, full refetch included.

## 2. Facts about the archive that constrain the choice

- **`updated_at` triggers exist on the archive tables the cache reads.** `songs` has `update_songs_updated_at`, `song_lyrics` has `song_lyrics_updated_at` and `artists` has `update_artists_updated_at` (live catalog). `update_updated_at()` sets `NEW.updated_at = now()` (migration 001). The new video tables can reuse the same function.
- **`now()` is the transaction's start time, not its commit time.** A watermark of the form `updated_at > last_seen` can therefore miss a row whose transaction began before, and committed after, a poll that advanced the watermark past it. The usual remedy is to re-read a short overlap window, a few minutes before the watermark, and upsert idempotently. Write transactions here are single RPCs lasting milliseconds, so an overlap of 2–5 minutes is generous. Take the watermark from the server's own `max(updated_at)`, never from the Mac's clock.
- **No archive table is published to Realtime.** `pg_publication_tables` for `supabase_realtime` is empty for `songs`, `song_lyrics`, `artists`, `song_edit_history` and `admin_audit_log`. Using Realtime would need an archive migration that adds each table to the publication.
- **Archive deletes are hard deletes.** `deleteSong` is admin-only and cascades its `song_edit_history` rows away. The other entities have no history table, so "the `admin_audit_log` row is the only surviving trace of any entity delete" (archive `CLAUDE.md`). Some writes carry no Edit at all: `reorderPerformances`, `reorderLyricsVersions`, `updateTrack`, `moveTrackToAlbum`.
- **The history is per field, not per row.** Each `song_edit_history` row is one event (`event_type`, `field_name`, `old_value`, `new_value`). Its foreign key is `song_id … ON DELETE CASCADE` (migration 021).
- **PostgREST caps a response at 1,000 rows** (`max_rows = 1000`, archive `supabase/config.toml`). A full read of 2,210 Videos therefore needs three pages, and 1,573 Video-Artist links need two.
- **The edit rate is low.** The 2026-10-07 backup holds 2,039 history rows. The busiest month, 2026-09, had 975 rows, about 32 per day across the whole archive. Video editing by a handful of Video Editors should be of the same order: tens to low hundreds of row changes a day, in bursts.
- **The data is small.** Shareable link data is about 2 MB (map #82). In the 2026-10-07 backup, `song_lyrics.json` is 448 KB, `songs.json` 180 KB and `artists.json` 62 KB. That makes one full pull about 2.7 MB.

## 3. Realtime facts

All from the Supabase docs listed under Sources.

- **Delivery is not guaranteed and missed events are not replayed.** The troubleshooting guide says Realtime "doesn't guarantee every message gets delivered" and advises treating an event "as a signal to re-fetch state". A server that subscribes therefore still needs a catch-up pull after every connect and reconnect.
- **DELETE events under RLS carry only the primary key**, even with `replica identity full`, because RLS cannot be checked against a deleted row. Delete events also cannot be filtered. A primary key is all a cache needs.
- **Every change is authorised once per subscriber.** Changes are processed on a single thread to keep their order. At a few subscribers this cost is negligible.
- **The subscriber's JWT decides what it sees.** The client authenticates with `supabase.realtime.setAuth(token)`, so a server-held subscription must be handed fresh access tokens as they rotate.
- **Billing and limits are far from binding.** One message is billed per change per listening client. The Free quota is 2 million messages a month and Pro is 5 million. The Free plan allows 200 concurrent connections and 100 messages per second. A payload above 1,024 KB is cut down to fields of 64 bytes or less.
- **Bun can run it unchanged.** realtime-js picks the runtime's global `WebSocket` (`websocket-factory.js`), and Bun provides one, so supabase-js needs no polyfill or `ws` package.

## 4. The candidates

The request counts assume 5 machines, each with the app open about 8 hours a day and launched twice a day. About 100 Shared rows change per day.

### A. Full refetch on launch

- **How it works:** page through every Shared table at launch, about 12 requests (three for Videos, two for links, one each for the rest), then reconcile into SQLite.
- **Requests:** about 12 per launch, so about 120 a day across five machines. Egress is about 2.7 MB per launch, about 27 MB a day, roughly 0.8 GB a month on a 5 GB free egress allowance. Workable, but egress is the only metered line (map #82), and this option spends it on data that has not changed.
- **Complexity:** low, close to today's import. The reconcile must be an upsert plus a set difference, not a wipe (§1).
- **Deletes:** natural. A row present locally and absent remotely is gone.
- **FTS and Latin:** run the full `fillLatinTitles` and `rebuildSearchIndex` after each pass, about 0.2 s.
- **Offline:** the last copy is served. Nothing changes until the next launch with a network.
- **Gap:** another editor's change made during a session does not appear until the next launch. The editor's own edit does not appear either, unless the hybrid push (E) is added.

### B. `updated_at` watermark polling

- **How it works:** each poll reads rows with `updated_at > watermark − overlap`. The poll can be one request per table using PostgREST's `updated_at=gt.<ts>&order=updated_at`, or a single RPC that returns all tables at once as jsonb.
- **Requests:** with one RPC, 1 per poll. At 60 s while open, that is 480 per machine per day and about 2,400 across five machines, each a few hundred bytes when empty. With per-table queries over 8 tables it is about 19,000 a day, still trivial for Supabase but noisier. Polling only while a browser tab is open and focused cuts this further.
- **Complexity:** moderate. It needs `updated_at` plus a trigger on every Shared table (the archive tables already have both), the overlap window, idempotent upserts, and a stored watermark per table or a single global one.
- **Deletes:** a watermark cannot see a row that no longer exists. Three ways to handle that:
  - a `shared_tombstone(table_name, row_id, deleted_at)` table filled by an `AFTER DELETE` trigger and returned by the same RPC;
  - soft deletes (`deleted_at`);
  - a periodic ids-only reconcile. `select id` over all Shared tables is about 2,800 uuids, under 150 KB.

  Tombstones are the clean answer for the video tables. The archive's own `songs`, `song_lyrics` and `artists` delete rarely and admin-only, so an ids-only reconcile on launch covers them without touching archive triggers.
- **Child rows:** to keep Chapters and Video-Artist links simple, have the `write_video…` RPCs bump the parent `video.updated_at` in the same transaction whenever a Chapter, link or rejection changes. The pull then fetches the changed Video with all its children and replaces those children locally. Deleted Chapters and links propagate through that replacement, so tombstones are needed only for whole Videos and Shared Songs, Versions and Artists.
- **FTS and Latin:** per changed row, `fillLatinTitles(db, { videoId })` or `{ chapterId }`, then `reindexVideo`, `reindexChapter`, `indexArtist`, `indexSong` or `indexVersion`. Above some batch size, say 200 rows, simply run the full fill and rebuild. A changed Song or Version also changes the `archive` Latin source of every Video and Chapter pointing at it, so treat a Song change as "refill Latin for its Videos and Chapters".
- **Offline:** requests fail and the cache keeps serving. The next successful poll catches up from the stored watermark. Nothing is lost, because the watermark lives in SQLite.

### C. Realtime subscriptions held by the Bun server

- **How it works:** one channel subscribed to `postgres_changes` on each Shared table.
- **Requests:** one long-lived WebSocket per machine. Messages cost one per change per machine, about 500 a day, far inside the 2 million-a-month free quota. A catch-up pull (B) is still needed after every connect, because missed events are not replayed.
- **Complexity:** the highest of the five.
  - An archive migration must add every Shared table to `supabase_realtime`.
  - The server must hold the user's session and call `setAuth` on every token refresh.
  - The server must handle reconnects, `CHANNEL_ERROR` and `TIMED_OUT`, and Mac sleep and wake.
  - All of B is still required underneath.
- **Deletes:** DELETE events arrive with the primary key, which is enough.
- **FTS and Latin:** as in B, row by row.
- **Offline:** the socket drops and the cache serves. On reconnect the server runs B's catch-up.
- **Gain over B:** another editor's edit appears in under a second instead of within a minute. For a handful of editors with no live co-editing (map #82 lists "two editors at once" as unspecified), that gain is small.

### D. The edit-history table as a change feed

- **How it works:** poll `video_edit_history` (the archive's shape) by `created_at`, and treat each row as "this entity changed". Then fetch the entity, or apply `new_value`.
- **Requests:** like B.
- **Complexity:** high, and it breaks easily.
  - History rows are per field, so applying `new_value` means reimplementing every event type's semantics locally and coupling the cache to the event registry. Fetching the entity instead turns this into B with an extra hop.
  - Writes that carry no Edit, such as reorders, leave no feed entry (archive `CLAUDE.md`).
  - With the archive's `ON DELETE CASCADE`, deleting a Video deletes its history, which is exactly the event the feed would need. The archive's precedent is that entity deletes survive only in `admin_audit_log`.
  - `created_at` has the same transaction-start skew as `updated_at`.
- **Deletes:** only if the video history keeps its rows after the parent is deleted (`ON DELETE SET NULL` plus a stored target id) and every delete writes an Edit. That is a schema constraint added only to serve the cache.
- **Verdict:** history should explain changes to people, not drive replication. Its one advantage over B, knowing which field changed, is not something the cache needs.

### E. Hybrid: the browser tells the local server what it just wrote

- **How it works:** after a successful write RPC, the browser POSTs the RPC's returned row or rows, or just the changed ids, to a localhost endpoint such as `POST /api/shared/applied`. The server upserts and reindexes them.
- **Requests:** zero to Supabase. It adds one request on the loopback interface per edit. If the server re-reads the ids instead of trusting the browser's rows, that costs one Supabase request per edit, about 100 a day.
- **Complexity:** low. The write RPCs should return the written rows (`RETURNING`), which also gives the browser its own optimistic state.
- **Deletes:** the browser knows it deleted, so it posts `{ table, id, deleted: true }`.
- **FTS and Latin:** row by row, exactly as `edit.ts` does today.
- **Offline:** not applicable. Edits are disabled offline (map #82).
- **Gap:** it covers only this machine's own edits. Other editors' changes, and edits made on the archive website, need A, B or C.
- **Trust:** the endpoint is on `127.0.0.1` and only touches a cache that the next pull overwrites with the authoritative row, so a bad push heals itself within a minute.

## 5. Comparison

| | Requests / day (5 machines) | Complexity | Deletes | FTS + Latin | Offline | Own edit visible | Others' edit visible |
|---|---|---|---|---|---|---|---|
| A. Full refetch on launch | ~120, ~27 MB | low | set diff | full rebuild (~0.2 s) | serves last copy | next launch | next launch |
| B. Watermark polling (1 RPC) | ~2,400, ~1 MB | moderate | tombstones (+ ids reconcile for archive tables) | per row | serves, catches up | ≤ 60 s | ≤ 60 s |
| C. Realtime + B catch-up | 1 socket + ~500 msgs, plus B on connect | high | PK in event | per row | serves, catches up | < 1 s | < 1 s |
| D. History as feed | ~2,400 | high, fragile | only with schema changes | per row | serves, catches up | ≤ 60 s | ≤ 60 s |
| E. Browser push | 0 | low | browser says so | per row | n/a | instant | never (alone) |

## 6. Recommendation

**B + E, with A kept as the repair path.**

1. **Pull with one RPC.** `shared_changes_since(p_since timestamptz)` returns `{ videos: [...], chapters, video_artists, …, songs, versions, artists, tombstones, server_now }`, with Video children nested under changed Videos. It is `SECURITY INVOKER`, so RLS decides what a Member sees, and gated to authenticated users. The server applies the result in one SQLite transaction, then stores `watermark = max(updated_at seen)`, reading from `p_since = watermark − 5 min`.
2. **Bump the parent.** Every `write_video…` RPC bumps `video.updated_at` when any child row changes. Each Shared table gets the archive's `update_updated_at()` trigger. An `AFTER DELETE` trigger on `video`, and on the promoted Songs, Versions and Artists if they can be deleted, writes `shared_tombstone`.
3. **When to pull:**
   - on server launch and on sign-in;
   - on regained network, detected by the next successful request;
   - on browser `visibilitychange` to visible, relayed to the server;
   - every 60 s while a browser tab is open;
   - never while no one is looking.
4. **Push after every write.** Each successful write RPC returns its rows, and the browser posts them to the server, so the editor's own grid, Player and search update at once. The next pull re-delivers the same rows and the idempotent upsert changes nothing.
5. **Repair.** A full refetch (A) runs:
   - on the first sign-in;
   - when the cache's schema version changes;
   - when the watermark is older than the tombstone retention, for example 90 days;
   - from a "Refresh Shared data" action.

   On launch, an ids-only reconcile of the archive's own `songs`, `song_lyrics` and `artists` catches their rare hard deletes without adding triggers to archive tables.
6. **Indexing after a pull:** run `fillLatinTitles` with an id for each changed Video and Chapter, refill the Videos and Chapters of any changed Song, then run the matching per-row index function. If a pull brings more than about 200 rows, run the full fill and `rebuildSearchIndex` instead, about 0.2 s. Keep the follow-up order `runImport` already uses: Songs, then Latin, then index.
7. **Realtime later, if ever,** as a trigger that only says "pull now", which needs no payload handling. It becomes worth its socket and token plumbing only if live co-editing becomes a goal.

**Who authenticates the pull:** RLS needs the Member's JWT. The simplest way is for the browser, which owns the session through supabase-js, to hand the server its access token on sign-in and again on each `TOKEN_REFRESHED`. The server polls only while it holds an unexpired token, and the token stays in memory only. With no valid token, the cache simply stops advancing, which is the offline behaviour anyway. This depends on #84, the Auth research.

## 7. Open points for other tickets

- **#83 (schema):** split the local columns (`favorited_at`, `resume_s`, view count, thumbnails) off `video`, or make every cache write an upsert that never touches them (§1). Also decide which Shared identity the cache keys on, uuid or `youtube_id`.
- **#83 and the write-model grilling:** `updated_at` and its trigger on every Shared table, the parent bump on child writes, the tombstone table and its retention, and write RPCs that `RETURNING` their rows.
- **Latin titles:** are they Shared? `manual` Latin titles are user edits and must be. `archive` and `table` ones are derived and could be computed on each machine, which keeps them out of the sync entirely. If they are Shared, the server must not regenerate a row that arrived with a source.
- **The TV Server** reads the same SQLite file, so it inherits whatever the cache holds, with no sync of its own.
