# Archive-side follow-ups from the sync audit (02)

These items come from `docs/audit/02-sync-shared-data.md`. Each one needs a change in the Tuvan Lyrics Archive's own repository (its Supabase migrations, RLS policies and functions). Nothing here was changed or contacted from TuvaVideos. Where a client-side guard already shipped on the fix branch, it is named, so the archive change can be judged as defence in depth or as the real fix.

| Item | Archive change | Client-side state |
|---|---|---|
| SYNC-14 | Monotonic `updated_at` stamps | None; needs the archive |
| SYNC-15 | `coalesce(jsonb_agg(…), '[]')` | Tolerant: `null` is read as empty |
| SYNC-16 | `statement_timeout` for the full pull | 180 s client timeout; a timeout is reported as such |
| SYNC-8 | `shared_schema` in every write bundle | Refuses bundles while the last whoami disagrees |
| SYNC-13 | Server-side stamps on archive tables | Watermark clamped to `server_time` |
| SYNC-4 | Purged Videos visible to the pull | Purged Shared Video merged into its successor |
| SYNC-1 | Refuse legacy-prefixed ids on insert | Ids moved aside at the first collision |
| (audit "not covered") | Soft-deleted Videos for Members; `SET NULL` cascades bump the parent | None |

## SYNC-14: make `updated_at` monotonic per row

**Problem.** The `updated_at` triggers of migration 130 stamp with `now()`, which is the start time of the transaction. Two transactions that touch one Video (or a child whose trigger bumps the parent) can commit in the opposite order of their `now()`. The row then ends with an older stamp than a version that was committed earlier. A machine that already applied the newer-stamped version skips the final row: the client's guard treats "equal or older" as "skip". It misses that change until the row changes again.

**Change.** In every `video_*` touch trigger (and in the parent bump that child triggers do), stamp with:

```sql
new.updated_at := greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
```

On insert, use `clock_timestamp()`. Add a pgTAP test with two overlapping transactions on one Video: the one that commits last must get the larger stamp.

**Client.** Nothing to do. The guard stays strict: an equal stamp means "already held".

## SYNC-15: never return `null` for an empty list

**Problem.** `shared_changes_since` builds `tables.<t>` for the `replace_whole` tables and the `archive_ids.*` lists with `jsonb_agg`. Over zero rows, `jsonb_agg` yields `NULL`, not `[]`. Before the fix, the client treated a `null` value as "not sent", so removing the last exposure or the last Album left the held rows in place forever.

**Change.** Wrap every `jsonb_agg(...)` that feeds `tables` (for tables named in `replace_whole`) or `archive_ids` in `coalesce(..., '[]'::jsonb)`. Add a pgTAP test where an exposure list is emptied: the function returns `"video_exposed_songs": []`.

**Client (shipped).** `applyShared` now reads a key that is present with value `null` as empty, for both `replace_whole` tables and `archive_ids` lists. A key that is left out is still "not sent".

## SYNC-16: give the full pull a statement timeout it can meet

**Problem.** Supabase's default `statement_timeout` for the `authenticated` role is 8 s. `shared_changes_since(null)` returns the whole Shared set: link data, all readable lyrics and `archive_ids`. As the archive grows it can exceed 8 s on the server, before any network time. When that happens, the first Sync, a schema-change refetch, "Refresh all Shared data" and the sign-in preview all fail.

**Change.** Either of these:
- `ALTER FUNCTION public.shared_changes_since(timestamptz) SET statement_timeout = '120s';`
- Page the full pull (a cursor or keyset over each table), with the client looping until done.

Measure the current runtime of the full pull with `EXPLAIN ANALYZE` as a Member and as a Video Editor first.

**Client (shipped).** The companion gives a full pull (`p_since` null) 180 s, body download included. Every other call keeps 15 s. A body cut off mid-download is an error, never an "unknown shape". A timeout is reported as "The archive took too long to answer", not as "can't be reached".

## SYNC-8: put `shared_schema` in every write bundle

**Problem.** The write functions (`write_*`, `elevate_*`, `set_song_exposure`) return `{tables, tombstones}` without `shared_schema`. A client that is behind keeps writing with the old shapes. `/api/cache/apply` then applies rows of a newer schema, and columns this checkout doesn't know are dropped silently.

**Change.**
- Add `'shared_schema', <current>` to the bundle every write function returns.
- Make each write function refuse a call from a client of another schema. For example, take an optional `p_client_schema int` and raise a dedicated SQLSTATE with `HINT 'schema-mismatch'` when it is set and differs.

**Client (shipped).**
- `editAccess` is disabled while the schema gate is up. This covers the edit controls and the `pending_share` drain.
- The companion records the archive's `shared_schema` at each whoami. `applyShared` refuses a bundle without `shared_schema` while that recorded value differs from this checkout's.
- A bundle that does carry `shared_schema` is already checked by `applyShared`.

## SYNC-13: stamp archive tables on the server

**Problem.** The watermark is the greatest `updated_at` across every pulled table, including the archive's `songs`, `song_lyrics` and `artists`. If one of those rows carries a future stamp (set by a client, an import or a clock error), the watermark jumps ahead and incremental pulls return nothing until real time catches up.

**Change.**
- Make sure `updated_at` on every table `shared_changes_since` reads is set by a `BEFORE INSERT OR UPDATE` trigger to `clock_timestamp()` (or `now()`), and never taken from the client.
- Add a check, or a one-off cleanup, for existing rows with `updated_at > now()`.

**Client (shipped).** The stored watermark is clamped to the pull's `server_time`, in the Sync and in sign-in reconciliation.

## SYNC-4: let the pull see purged Videos

**Problem.** Videos have no tombstones (§6.3), and the ids-only reconcile (`archive_ids`) does not cover `videos`. A Video hard-deleted in the console ("a purge is a console act", §4.5) therefore stays in every Local copy as Shared, indefinitely.

**Change.** Either of these:
- Write a `shared_tombstone` row (`table_name = 'videos'`, `kind = 'deleted'`) when a Video is purged.
- Add `archive_ids.videos`: every Video id the caller can read, soft-deleted ones included.

Either needs a matching client change in `applyShared`. Today `TOMBSTONE_TABLES` and `IDS_TABLE` reject unknown names, so ship the client side first.

**Client (shipped).** The case that wedged Sync is now handled: a held Shared Video, absent from the batch, whose `youtube_id` or `content_hash` a new Shared Video holds. Its Copies, Favorite and other machine rows join the new id, and nothing throws. A purged Video whose key nobody reuses still lingers, Shared, until the archive tells the client it is gone.

## SYNC-1: refuse legacy-prefixed ids on insert

**Problem.** Migration 0015 gave every pre-#112 row the same deterministic uuid on every machine:
- Videos: `76696400-0000-8000-8000-<n>`
- Chapters: `63687000-…`
- Local Artists: `61727400-…`

The owner's ids are in the archive. A collaborator's Unshared Video whose legacy id is beyond the owner's range can still be drained under that legacy id. A second collaborator's different Video `n` then fails its insert (the primary key exists) until a Sync moves it aside.

**Change.** Now that the one-time migration is complete (ADR 0009), make `write_videos insert`, `write_video_chapters add` and `write_proposed_artists create` refuse a client-supplied id with one of the three legacy prefixes. Use a distinct SQLSTATE so the client can re-mint the id and retry. As an alternative, add a `CHECK` on those tables for new rows, exempting the existing ones by `created_at`.

**Client (shipped).**
- Matching accepts the same uuid only when the identity keys agree.
- Before matching and at the start of every apply, a row of this machine that holds an incoming Shared id but is not that row moves to a fresh uuid.
- Not shipped: the drain does not re-mint legacy ids before inserting. That step would be the client half of this change.

## Open questions the audit could not check (no access to the archive repo)

- **Soft-deleted Videos for Members.** Do Members' reads filter them out? Spec §4.5 says the RLS view hides them, but §6.2 says the pull includes them. If RLS filters them out, a deletion never reaches Members' machines: the Video just stops changing. Decide which one is meant, then either include `deleted_at` rows for every reader or add them to `archive_ids.videos` (see SYNC-4).
- **`SET NULL` cascades.** Does a child's foreign-key `SET NULL` (a Proposed Song deleted under a Chapter) bump the parent Video's `updated_at`? The client replaces a Video's children only when the Video itself arrives bumped. A child changed without a parent bump arrives on its own and is applied row by row, but a child *removed* that way is never dropped from the Local copy.
