# Audit 02: Sync and shared-data correctness

Auditor scope: `src/server/sync.ts`, `sharedWrites.ts`, `reconcile.ts` (+ `src/shared/reconcile.ts`), `src/server/localCopy/*`, `src/server/migrateShared/*`, `scripts/migrate-shared.ts`, `scripts/seed-shared.ts`, `src/shared/archiveWire.ts`, `sharedRows.ts`, `shelvedDiff.ts`, edit history (server and shared), `src/web/writeOps.ts`, `writeLink.ts`, `sharing.ts`, and the ConflictNotice, Shelved and ProposedRows UI logic. This was a code-only audit. Nothing contacted the archive.

Repro tests: `/tmp/claude-0/-home-user-TuvaVideos/81dd5c87-daef-5003-ad39-65f9bcc41023/scratchpad/audit-02/sync.audit.test.ts`. There are 11 tests and all pass, which means each one demonstrates its bug. Run them with `bun test <that path>`. They import the real modules by absolute path and use `test/helpers/seed.ts`.

## Summary

The pull/apply core is careful. It uses one SQLite transaction, refuses a batch on a schema mismatch, applies tombstones, and runs the ids-only reconcile and the full-refetch wipe in the same transaction. The most serious problems are at the edges, where local identity meets Shared identity:

- **Legacy ids collide across machines.** The deterministic legacy uuids (`76696400-…-<n>`, `63687000-…-<n>`, `61727400-…-<n>`) are reused across machines. Reconcile matches on the id *first*, so on any machine with its own pre-#112 library, a Video, Chapter or Local Artist can be silently merged into an unrelated owner row (SYNC-1).
- **Every Chapter re-apply breaks its stamp.** The apply rewrites the local touch trigger's stamp for every Chapter it re-applies. After a sibling edit, a full refetch or a sign-in, the next edit of those Chapters sends a stale `p_expected_updated_at`, which means a spurious conflict. Repoints and undos that touch them fail (SYNC-2).
- **A focus Sync can skip the sign-in confirmation.** During the reconciliation confirmation, a window-focus Sync can run the whole reconcile (shelving and re-keying) before the person presses Continue or Cancel (SYNC-3).
- **Smaller issues.** A purged Shared Video can wedge Sync permanently. Drained inserts can be skipped by the clock guard. The companion accepts local edits of Shared Videos. A Sign out during a Sync is undone. The schema gate stops Sync but not writes.

## Findings

| ID | Severity | Status | Location | Title |
|---|---|---|---|---|
| SYNC-1 | High | CONFIRMED | `src/server/reconcile.ts:72,90-98`; `src/server/localCopy/apply.ts:122-125`; `migrations/0015_local_copy.sql:27` | Legacy uuids are not globally unique: reconcile's "same uuid first" and the apply's upsert-by-id merge unrelated rows across machines |
| SYNC-2 | High | CONFIRMED | `migrations/0015_local_copy.sql:199-204`; `src/server/localCopy/apply.ts:301-302` | Re-applying an unchanged child fires the touch trigger: Chapter stamps become this machine's clock, so the next edit hits a spurious `conflict` |
| SYNC-3 | High | CONFIRMED | `src/web/session.ts:148-155`; `src/shared/session.ts:210-214,248-261`; `src/server/sync.ts:201-235`; `src/server/reconcile.ts:393-397` | A focus Sync during the reconciliation confirmation reconciles and shelves before Continue; Cancel then leaves a half-signed-in Local copy |
| SYNC-4 | Medium | CONFIRMED | `src/server/localCopy/apply.ts:93,118`; `src/server/sync.ts:130-135`; `src/server/reconcile.ts:213` | A Shared Video the archive no longer returns (console purge) plus a new row with its `youtube_id`/`content_hash`: every Sync and every full refetch fails forever |
| SYNC-5 | Medium | CONFIRMED | `src/server/scan.ts:335-336`; `src/server/localCopy/apply.ts:110,266-275`; `src/server/share.ts:48-83` | The `pending_share` drain's apply can be skipped by the guard (machine clock ahead), leaving a Shared Video on `local_*` pointers and local link ids; local edits made during a drain are overwritten without being shelved |
| SYNC-6 | Medium | CONFIRMED (route) / PLAUSIBLE (trigger) | `src/server/edit.ts:17-77`; `src/server/api.ts:709-744`; `src/server/chapters/store.ts`; `src/web/writeOps.ts:66-71` | The companion's local edit routes accept Shared Videos; a tab holding a stale `shared: false` DTO forks a Shared row locally and stamps it ahead of the server |
| SYNC-7 | Medium | CONFIRMED | `src/server/sync.ts:239-246`; `src/server/localCopy/meta.ts:49-65`; `src/server/api.ts:831` | A Sign out while a Sync is in flight is undone: the finished Sync writes a new Session record (grant null) |
| SYNC-8 | Medium | CONFIRMED | `src/shared/session.ts:202-206`; `src/web/writeLink.ts:121-153`; `src/server/api.ts:792-801`; `src/server/localCopy/apply.ts:171` | The schema gate stops Sync but not writes: an out-of-date client keeps writing, and the write bundles (no `shared_schema`) are applied unchecked |
| SYNC-9 | Low | CONFIRMED | `src/server/editHistory.ts:78-89` | The Edits view's `before` cursor drops the rest of a write that is larger than a page (a repoint over more than 200 Videos shares one `created_at`) |
| SYNC-10 | Low | CONFIRMED | `src/server/sync.ts:96-111,243` | Retention is measured from the newest row seen, not from the last pull: after 90 quiet days every Sync is a full refetch (wipe and re-pull), indefinitely |
| SYNC-11 | Low | CONFIRMED | `src/web/writeOps.ts:502-519`; `src/web/History.tsx:332-349` | Copying back a starred Shelved Chapter does not re-star it, and the shelf row that held the star is deleted (spec §2.3) |
| SYNC-12 | Low | CONFIRMED | `src/web/writeLink.ts:142-146,374` | A `forbidden` write does not re-read the grant "at once" (spec §2.5); the edit controls stay until the next Sync |
| SYNC-13 | Low | PLAUSIBLE | `src/server/sync.ts:85-91,243`; `src/server/localCopy/apply.ts:356` | The watermark only ratchets forward and is never clamped to `server_time`: one future-dated archive row stalls incremental pulls until real time catches up |
| SYNC-14 | Low | PLAUSIBLE | `src/server/localCopy/apply.ts:51-56`; spec §6.2 | `updated_at = now()` (transaction start) is not monotonic under concurrent commits; the strict "not newer: skip" guard can then keep a superseded row |
| SYNC-15 | Low | PLAUSIBLE | `src/server/localCopy/apply.ts:176-179,334-337` | An empty `replace_whole` table or `archive_ids` list arriving as JSON `null` (Postgres `jsonb_agg` of zero rows) is treated as "not sent", so held rows are never dropped |
| SYNC-16 | Low | PLAUSIBLE | `src/shared/archive.ts:86` | A 15-second total timeout on `shared_changes_since(null)`: on a slow link, every full refetch (first Sync, schema change, Refresh all, sign-in preview) fails |

Counts: High 3, Medium 5, Low 8.

---

### SYNC-1: Legacy uuids are not globally unique (High, CONFIRMED)

**Description.**
- **Every machine reuses the same legacy ids.** Migration 0015 gives every pre-#112 integer row a deterministic uuid on every machine: Video `n` becomes `76696400-0000-8000-8000-<n hex>`, Chapter `n` becomes `63687000-…`, and Local Artist `n` becomes `61727400-…` (`migrations/0015_local_copy.sql:27`, `src/server/localCopy/ids.ts:16-19`).
- **The owner's ids went into the archive.** The one-time migration recomputed the same ids from the owner's library and wrote them to the archive. Videos and Chapters kept their ids, and Local Artists became Proposed Artists with the same id (`src/server/migrateShared/plan.ts:6-7`).
- **Different machines' ids mean different things.** Any other machine that ran v1 (a collaborator's, or the owner's second machine) has its own Video 1, Chapter 5 and Local Artist 3. They are different things under the very same uuids.

Three code paths treat an id match as identity:
1. **Reconcile matches on id first.** `MATCH_ORDER = ["id", "youtube_id", …]` (`reconcile.ts:72`) and `matchVideo` (`:90-98`) match on the uuid before any identity key, with no check that the identity keys agree. This runs at sign-in, and at *every* Sync through `reconcileBatch` (`sync.ts:233`).
2. **The upsert is keyed on `id` alone.** `applyShared`'s upsert uses `ON CONFLICT(id) DO UPDATE` (`apply.ts:122-125`), so a Shared Chapter whose id equals a local Chapter of an *unmatched* Unshared Video overwrites that Chapter, `video_id` included.
3. **The Artist kind lookup goes wrong.** `artist_all` (`0015_local_copy.sql:349-356`) unions `video_proposed_artists` and `local_artist`. A collaborator's Local Artist `n` and the owner's Proposed Artist `n` become two rows under one id, so `artistKind` (`localCopy/rows.ts:10`) returns whichever comes first.

**Failure scenario.**
1. A collaborator has used the app for a year with 300 Videos (ids 1–300) and signs in as a Member.
2. Their Video 1, a file `… [COLLAB_YT].mp4`, is matched by id to the owner's Video 1, which is a different YouTube id.
3. The file's Copy, Favorite and resume point now belong to the owner's Video. The local title, Song, Artists and Chapters are shelved as "conflicts".
4. The real Shared counterpart of the file shows "Not on this machine".
5. This happens for every id that both libraries hold, i.e. nearly all of the collaborator's Videos.
6. Chapters of Unshared Videos whose ids collide are silently moved onto owner Videos, and their stars go with them.

**Evidence.** These tests ran:
- `SYNC-1 … joins the owner's Video #1`: `planFor` returns `{by: "id"}`. After `reconcileBatch` + `applyShared`, the Copy `collab [COLLAB_YT].mp4` belongs to the Video with `youtube_id = OWNER_YT`, and the true match has 0 Copies.
- `SYNC-1 … steals that Chapter`: the Unshared Video's Chapter `C(5)` now has `video_id` set to the Shared Video and the Shared title. The Unshared Video has 0 Chapters.

**Suggested fix.**
- Accept an `id` match only when the identity keys agree, i.e. at least one of youtube_id or content_hash is equal and none conflicts. Otherwise fall through to the scan's order.
- In `upserter`, refuse (or re-key the local row) when a held row with the same `id` belongs to a different parent (`video_id`) or is an Unshared row.
- Re-key legacy-prefixed ids on every machine except the migrated one, for example with a one-time local migration that re-mints ids whose legacy integer does not appear in the owner's map. The simplest form: on first sign-in, re-mint every legacy-prefixed row id of Unshared rows before matching.

### SYNC-2: Re-applied children get this machine's clock as their stamp (High, CONFIRMED)

**Description.**
- **The trigger.** `video_chapters_touch` (and `videos_touch`, `video_artists_touch`) fire `AFTER UPDATE … WHEN NEW.updated_at IS OLD.updated_at` and restamp the row with `strftime('now')` (`0015_local_copy.sql:199-204`).
- **The intent.** "Stamp unless the statement set it."
- **What actually happens.** The trigger cannot tell "the statement didn't set it" from "it set the same value". `applyShared` replaces a bumped Video's children with `guard: false` (`apply.ts:301-302`). It re-upserts every *unchanged* Chapter with the stamp it already holds, so the trigger fires and the stamp becomes the local wall clock.
- **The result.** `ChapterDto.updatedAt` no longer equals the archive's value. It is sent as `p_expected_updated_at` for `chapter.update`, `delete`, `reject` and `confirm` (`writeOps.ts:355-370`).

**Failure scenario.** Some Chapter writes refuse when the stamp doesn't match:
1. Editor A adds Chapter B to a Video that already has Chapter A, or any sibling changes. Every machine's apply of that bundle restamps Chapter A.
2. Anyone editing Chapter A then gets `VD409`. The conflict notice says "You (in another tab…)" or "Another Video Editor" changed it, which is false.
3. Writes made with `quietConflict` fail silently or land in `failed`: Song/Version Repoint over Chapters (`writeLink.ts:423-429`), so "delete after Repoint" is skipped, and the matchers.
4. Undo of `chapter.changed` uses the current local stamp, so it conflicts as well.
5. After any full refetch (`wipeShared` then apply) or a sign-in reconcile, *every* Shared Chapter on the machine is restamped. The next edit of each one conflicts once.

**Evidence.** Tests `SYNC-7 … unchanged Chapter gets this machine's clock` and `… a full refetch restamps every held Chapter` ran. After the re-apply, Chapter A's stamp was `2026-11-04T22:57:28.366Z` (the local clock) instead of the server's `2026-10-10T00:00:00.000000+00:00`.

**Suggested fix.** Either of these works:
- Make the apply's upsert a no-op for an identical row: `ON CONFLICT … DO UPDATE SET … WHERE excluded.updated_at IS NOT <table>.updated_at OR <any column differs>`.
- Give the triggers a way to know an apply is running, for example a `meta`/`apply_in_progress` row checked in `WHEN`, set and cleared inside `applyShared`'s transaction.

Then add a test that a re-applied child keeps the server's stamp.

### SYNC-3: The confirmation can be bypassed by a focus Sync (High, CONFIRMED)

**Description.**
- **The window.** `previewSignIn()` (`GET /api/reconcile/preview`) writes a fresh Session record (`reconcile.ts:446-450`) with no `last_sync_at`. It then shows the confirmation whenever something would be shelved. During that time, this tab (and other tabs) hold a browser session for the record's user.
- **The trigger.** `onFocus` (`web/session.ts:148-155`) re-reads the record and asks `syncWanted("focus")`. `focusWantsSync` returns true because `lastSyncAt` is null (`shared/session.ts:210-214`).
- **What the Sync does.** `runSync` posts `/api/sync`. That is a full refetch ("first", empty watermark), which runs `reconcileBatch` over every Unshared Video (`sync.ts:231-235`, `reconcile.ts:393-397`). It re-keys matched Videos, writes the Shelved edits and drops their local link data, all without Continue.
- **Cancel can't undo it.** Cancel then only clears the record (`signOut`, `web/session.ts:301-312`). The spec says "Cancel signs out again… no half-signed-in state" (§2.3), and "the Sync waits for Continue" (`web/session.ts:293`).

Separately, the preview's cached batch (`held`, `reconcile.ts:456`) can be older than what that Sync applied. Continue then wipes and re-applies the older snapshot and writes its older watermark (`reconcile.ts:499-501`). This self-heals on the next pull.

**Failure scenario.**
1. A person signs in and sees "12 edits will be shelved".
2. They switch to another window to think about it and come back. The focus Sync shelves and re-keys everything.
3. They press Cancel. The library is now in its reconciled state, with no session record, and the Shelved edits are already written.

**Evidence.** Test `SYNC-8` ran. `syncWanted("focus", {record from the preview, browser of the same user})` returns `true`. The Sync's transaction (wipe, `reconcileBatch`, apply) shelves `["title","type"]` and the local Video id disappears (re-keyed).

**Suggested fix.**
- Make the companion refuse `/api/sync` (409 "sign-in not confirmed") while a preview is outstanding: record `meta.reconcile_pending = userId` in preview, clear it on confirm or `DELETE /api/session`.
- In the browser, suppress `focus`/`launch` triggers while the confirmation is open.
- Alternatively, don't write the record at preview time; write it at confirm.

### SYNC-4: A Shared Video missing from the archive can wedge Sync (Medium, CONFIRMED)

**Description.**
- **Purged Videos stay forever.** Videos have no tombstones (§6.3). A Shared Video the full pull does not return "stays as it was" (`sync.ts:125-135`), and there is no ids-only reconcile for `videos`. So a Video hard-deleted on the archive (the spec's "a purge is a console act", §4.5) stays in the Local copy with `shared = 1` indefinitely.
- **Its keys are free again on the server.** If the same file is shared again, a new uuid with the same `youtube_id` arrives.
- **`applyShared` refuses the clash.** `videos` is `NO_GIVE_WAY` (`apply.ts:93,118`), so it throws "…is held by…".
- **`reconcileBatch` doesn't resolve it.** It only considers `shared = 0` Videos (`reconcile.ts:213`).
- **The failure repeats.** The watermark does not move, so the same batch comes back at every Sync. "Refresh all Shared data" fails the same way, because the wipe keeps Shared Videos.

**Failure scenario.**
1. The owner purges a duplicate Video in the console.
2. A Video Editor on a fresh machine rescans the file, and the drain inserts it under a new id.
3. Every machine that held the old row now fails every Sync with "Sync failed, nothing was applied". The only way out is deleting `library.db`.

**Evidence.** Test `SYNC-2` ran. Both the incremental apply and the wipe-plus-apply throw `/held by/`.

**Suggested fix.**
- When a clashing held row is itself Shared, re-key it into the incoming id (the same re-key path as `applyPlan`) or drop it, and log the event.
- Add `videos` ids to the ids-only reconcile (soft-deleted ones are still readable, so absence means purged).

### SYNC-5: The drain's apply can be skipped by the guard (Medium, CONFIRMED)

**Description.**
- **The guard compares across two clocks.** A scanned Video is inserted with `updated_at = now` on the *machine's* clock (`scan.ts:335-336`). The drain sends its payload to `write_videos insert`, and the archive stamps the row with *its* `now()`. `/api/cache/apply` then runs the normal guard (`apply.ts:110`): if the server stamp is not newer than the local scan stamp, the Video *and its children* are skipped (`apply.ts:283-289`).
- **The row is still marked Shared.** `markShared` sets `shared = 1` either way (`:266-275`), so the Video becomes a Shared Video that still holds the pre-drain local row:
  - `song_id`/`version_id`/`artist_id` pointing at `local_*` rows. The drain substituted Proposed ids on the server, not here.
  - `video_artists` link ids that the archive never issued, because the insert payload carries no link ids (`share.ts:78-80`).
  - The local stamp as `p_expected_updated_at`.
- **What follows.**
  - Edits of that Song or those Artists are refused with "A Local Song… cannot go on a Shared Video".
  - `artists.remove` on a Suggested link sends `reject` with a non-existent link id.
  - Every other write conflicts until the server's stamp overtakes the local clock.
- **Second path, no skew needed.** `pendingShareBatch` is read once per drain. A local edit of a queued (still Unshared) Video made after that read and before its insert returns is stamped earlier than the server's insert. The apply then overwrites it, and the edit is not shelved.

**Failure scenario.**
1. A Video Editor's Mac clock is 10 s fast.
2. A scan of one new file is followed by the automatic drain 3 s later. The insert's server stamp is behind the scan stamp.
3. The Video is "Shared" locally but shows the Local Song and Local Artist, and can't be edited cleanly. Other machines see the Proposed rows.

**Evidence.** Test `SYNC-3` ran. `skipped.videos = 1`, the row keeps `song_id = 'ls-1'` (the Local Song) with `proposed_song_id = null`, and `video_local = {shared: 1, pending_share: 0}`.

**Suggested fix.** In `applyShared`, bypass the guard for a Video whose held row is Unshared (`shared = 0`, i.e. queued or a fresh insert), replacing its children. "Shared wins" already says this; reconcile achieves it with the epoch stamp, but the cache-apply path does not. Optionally, refuse local edits of `pending_share` Videos while a drain runs.

### SYNC-6: Local routes accept Shared Videos (Medium, route CONFIRMED / trigger PLAUSIBLE)

**Description.**
- **Only the browser checks.** `patchVideo`, `setVideoArtists`, `rejectVideoArtist`, `confirmVideoArtists`, and the Chapter routes (`edit.ts:17-140`, `chapters/store.ts`, wired at `api.ts:709-744`) never check `video_local.shared`. The only guard is `routeFor` in the browser, which trusts the DTO's `shared` flag (`writeOps.ts:66-71`). Compare `deleteVideo.ts:47`, which does refuse Shared Videos.
- **The local edit runs ahead of the server.** A local edit of a Shared row is a silent fork. Its trigger stamps the local clock, so later server versions stamped earlier are skipped by the guard (`apply.ts:110`).

**Failure scenario.** This is how the trigger can happen in practice:
1. Now playing polls the Video every 3 s (`Play.tsx:31`) and holds `shared: false` for a queued Video.
2. The automatic drain shares it under the same id.
3. A title edit inside that window goes to `PATCH /api/videos/:id`. It never reaches the archive, the edit is only on this machine, and server updates are hidden until the next server change that is stamped later.
4. Any old tab or script calling these routes does the same.

**Evidence.** Test `SYNC-4` ran. `patchVideo` on a Shared Video returns `{ok: true}`, the held title becomes "Local fork", and the next pulled row with an earlier stamp is skipped.

**Suggested fix.** Make the companion refuse writes to `shared = 1` Videos on these routes (409 "Shared Video: write through the archive"). `writeLink` should then re-read the Video and retry through the archive route.

### SYNC-7: Sign out during a Sync is undone (Medium, CONFIRMED)

**Description.**
- **The Sync job writes the record at the end.** After its apply, it calls `writeSessionRecord(db, {userId: record.userId, watermark, lastSyncAt})` (`sync.ts:239-246`).
- **The record may be gone by then.** If `DELETE /api/session` (Sign out, a dropped session, a cancelled sign-in; `api.ts:831`) ran during the pull, `writeSessionRecord` finds no current row. It creates a fresh record for the old user with `grantLevel = null` (`meta.ts:49-55`).
- **The machine now looks half signed in.** It is in "no-grant" mode for that user. The TV and every tab see a record, and the batch was applied after the sign-out.
- **A second sign-in can be overwritten.** If B signs in during A's Sync, A's Sync replaces B's record with A's. B's confirm then writes `{userId: B, watermark}` onto a fresh base, which loses B's grant until the next Sync (`reconcile.ts:501`).

**Evidence.** Test `SYNC-9` ran. The record is cleared mid-pull; after the Sync, `readSessionRecord` returns `{userId: "u-1", grantLevel: null, …}`.

**Suggested fix.** Write the end-of-Sync fields with an `UPDATE … WHERE user_id = ?` that does nothing when the record is gone or belongs to someone else. Skip the apply when the record changed during the pull (compare the user id inside the transaction). Do the same in `reconcile.confirm`.

### SYNC-8: The schema gate stops Sync but not writes (Medium, CONFIRMED)

**Description.**
- **The banner path.** When `video_whoami().shared_schema` differs, Sync stops and the banner shows (`sync.ts:196-197`).
- **The write path ignores it.** `editAccess` (`shared/session.ts:202-206`) ignores `schemaMismatch`, so edit controls stay enabled. `writeLink`/`writeRow` (`writeLink.ts:121-153,353-380`) and the `pending_share` drain keep calling the write functions with the old shapes.
- **The Local copy keeps applying new-shape rows.** `/api/cache/apply` accepts a bundle without `shared_schema` (`api.ts:792-801`, `apply.ts:171`). Columns this checkout doesn't know are silently dropped by `columnsOf` (`apply.ts:106`).
- **The result.** The Local copy keeps taking partial rows of a schema it does not speak, while the banner says Sync has stopped.

**Suggested fix.** When the client is behind, disable Shared edit controls and the drain (`editAccess.enabled = false` when `schemaMismatch`). Also make the write functions return `shared_schema` and have `/api/cache/apply` check it the way the pull does.

### SYNC-9: The Edits view drops the tail of a large write (Low, CONFIRMED)

**Description.**
- **How paging works.** `listEdits` cuts a page so that it never splits a write; the rows are grouped by `created_at` (`editHistory.ts:83-88`).
- **What goes wrong.** When a single `created_at` spans more rows than `limit`, `whole` is empty, so the page keeps the split rows and sets `next = cut`. The next page asks `created_at < cut`, so the remaining rows of that write are never listed.
- **When it happens.** An Artist `repoint` files one `artist_link.repointed` per touched Video in one transaction, so all of them share one `now()`.

**Evidence.** Test `SYNC-6` ran: 250 rows share one `created_at`, page 1 returns 200 with `next = at`, and page 2 returns 0.

**Suggested fix.** Use a compound cursor `(created_at, video_id, editor_id, id)` that matches `ORDER`. Alternatively, when `whole` is empty, return the whole group regardless of `limit`.

### SYNC-10: Retention is measured from the newest row seen (Low, CONFIRMED)

**Description.**
- **The test it uses.** `fullRefetchReason` checks `serverNow − watermark > 90 days` (`sync.ts:109`). The watermark is the greatest `updated_at` seen, not the time of the last pull.
- **Why that's wrong.** The tombstones that could have been missed are only those purged since the last *pull*.
- **The loop.** In a quiet period of 90 days, the full refetch returns the same old watermark (`sync.ts:243`), so every Sync from then on is a full wipe and re-pull. Each one re-runs the follow-ups and empties `video_edit_history`, until something changes upstream.

**Evidence.** Test `SYNC-5` ran: a watermark 104 days old returns `"retention"` even though the previous Sync could have been minutes ago.

**Suggested fix.** Measure retention from the `since` of the last successful pull (store `server_time` of the last pull in the record), not from the watermark.

### SYNC-11: Copying back a starred Shelved Chapter loses its star (Low, CONFIRMED)

**Description.**
- **The spec.** "The Shelved Chapter remembers the star and copying it back re-stars it" (§2.3).
- **What the code does.** `copyBackOp` builds a plain `chapter.add` (`writeOps.ts:513-514`). `History.tsx:332-345` then deletes the shelf row, which was the only holder of `favoritedAt`, and never calls the Favorite route for the new Chapter id. The star is gone for good.
- **A related loss.** Undoing `chapter.deleted` adds the Chapter back with a new id (`writeLink.ts:136`), so its old star is not restored either.

**Suggested fix.** After the copy-back's `chapter.add`, if `payload.favoritedAt` is set, star the read-back Chapter (`chapter_local`) before deleting the shelf row.

### SYNC-12: A forbidden write doesn't re-read the grant (Low, CONFIRMED)

**Description.** Spec §2.5 says "a permission error during a write re-reads it at once." `writeLink` and `writeRow` only turn `forbidden` into a line (`writeLink.ts:142-146,374`). They never call `requestSync()` or whoami, so a Video Editor who lost the grant keeps seeing enabled controls and getting refusals until the next Sync trigger.

**Suggested fix.** On `out.error.word === "forbidden"`, call `requestSync()` (the companion's whoami re-read writes the record).

### SYNC-13: The watermark never moves back and is not clamped (Low, PLAUSIBLE)

**Description.**
- **The ratchet.** The record keeps `laterOf(held, returned)` (`sync.ts:85-91,243`). The watermark is the greatest `updated_at` across *all* pulled tables, archive `songs`/`song_lyrics`/`artists` included (spec §6.2).
- **The risk.** If one archive row carries a future `updated_at` (set by a client, an import, or a clock error on the archive side), the watermark jumps ahead. Every later pull uses `since = future − 5 min` and returns nothing, and `laterOf` never lets it come back.
- **Why PLAUSIBLE.** This depends on how the archive stamps its own tables, which is not visible in this repo.

**Suggested fix.** Clamp the stored watermark to `min(watermark, batch.server_time)`.

### SYNC-14: The guard assumes `updated_at` is monotonic (Low, PLAUSIBLE)

**Description.**
- **Why stamps can go backwards.** `now()` is the transaction *start* time. Two transactions touching one Video can commit in the opposite order of their `now()`. This applies to ops whose stamp is optional (`chapter.add`, `confirm`, `confirm_all`, `unreject`, artist `reject`) and to parent bumps from child triggers. The row then ends with an older `updated_at` than an earlier-committed version.
- **The divergence.** A machine that applied the newer-stamped bundle skips the final row (`heldIsNewer`, `apply.ts:51-56`, equal-or-older is skipped). That machine misses the other editor's Chapter until the next change.
- **Why PLAUSIBLE.** This depends on the archive triggers in migration 130, which are not in this repo.

**Suggested fix.** On the archive, stamp with `greatest(clock_timestamp(), old.updated_at + interval '1 microsecond')`.

### SYNC-15: An empty "whole" list arriving as `null` is ignored (Low, PLAUSIBLE)

**Description.**
- **`replace_whole` tables.** The replace only happens when the table is present (`if (changes[t]) whole.add(t)`, `apply.ts:178`).
- **`archive_ids` lists.** These are skipped unless they are an array (`apply.ts:337`).
- **The risk.** Postgres `jsonb_agg` over zero rows yields `NULL`, not `[]`. If the function doesn't `coalesce(…, '[]')`, then removing the *last* exposure or the last Album leaves the held rows in place forever.

**Suggested fix.** In the client, treat a key that is present with a `null` value as empty (`Object.hasOwn(changes, t)`). Confirm `coalesce` in migration 130.

### SYNC-16: A 15-second timeout on the full pull (Low, PLAUSIBLE)

**Description.**
- **The timeout.** `postgrestClient` uses `AbortSignal.timeout(15_000)` for every call (`archive.ts:86`), and that covers the body download. The whole-archive `shared_changes_since(null)` (link data, all readable lyrics, `archive_ids`) is the largest response the app gets.
- **The failure mode.** On a slow link, the first Sync, a schema-change refetch, "Refresh all" and the sign-in preview all fail as "The archive can't be reached" or "unknown shape". The text is read after the abort, so the body comes back `null`.
- **The server side.** Supabase's default `statement_timeout` for `authenticated` (8 s) is a related server-side ceiling. It was not verifiable here.

**Suggested fix.** Give the full pull a longer timeout (for example 120 s), and report a timeout distinctly from "unreachable".

---

## Checked and found OK

- **Coalescing.** One Sync at a time, and a queued full refetch stays full (`coalesce`, `sync.ts:28-56`).
- **Failure safety.** A failed apply leaves the watermark and `last_sync_at` untouched. The full-refetch wipe and the apply share one transaction.
- **Empty pulls.** The watermark does not walk back on an empty pull (`laterOf`). The overlap of 5 minutes is applied (`pullSince`).
- **Schema checks.** The batch's `shared_schema` is checked twice (whoami, then the batch itself), and `applyShared` refuses a mismatched batch whole.
- **Push-vs-pull ordering.** The guard prevents an older pull from overwriting a newer cache-apply (Video and children skipped together; `apply.ts:283-289`). `/api/cache/apply` never touches the watermark.
- **Tombstones.** They are applied after the Proposed and Video rows. Clashing tombstones are replaced. Elevated rows keep their id and land in `archive_*` in the same batch.
- **Ids-only reconcile.** It covers songs, versions, artists, performances and albums, including rows that left the RLS view.
- **Whole tables.** Album tracks, credits and the exposure list are replaced wholesale, and the search index is rebuilt only when their content changes.
- **Reconcile mechanics.** Unique keys are freed before re-keying. Foreign keys are deferred, so references are moved by `pragma_foreign_key_list`. Two local Videos merge into one Shared Video, and the epoch stamp guarantees "Shared wins". Stars move to twin Chapters.
- **Drain idempotency.** An insert whose response was lost (`exists`) self-heals at the next Sync, because the archive row carries the local id and `reconcileBatch` matches it by id. The Proposed-row dedupe points a retried drain at the row the lost call created.
- **Conflict notice.** Keep theirs / apply mine re-reads the Video. Apply mine uses the DETAIL's stamp only when it names the same row, and a second conflict reloads and shows the notice again.
- **Undo inversion** (`inverseOf`, `undoBlock`). Confirmations inside mixed writes are kept, the Latin title is regenerated when it followed the title, and `reverses` attaches per field.
- **Error mapping.** `readArchiveError` maps SQLSTATE/HINT to wire words and parses the DETAIL JSON defensively.
- **Migration script resume.** The resume marker, the emptiness/foreign-rows refusal and the half-done deletions are handled. The run is already complete per ADR 0009.
- **Session record changes.** `writeSessionRecord` starts a fresh record (empty watermark, so a full refetch) on an account switch. `loseEditorGrant` runs on a same-user downgrade, and confirm runs it for a Member.

## Not covered / blocked

- **Archive-side behaviour.** The RLS policies, the write functions, the `updated_at` triggers and `shared_changes_since` (migrations 130/141) live in the archive repo, not here. These depend on them:
  - Whether Member reads filter soft-deleted Videos. Spec §4.5 says they do, while §6.2 says deleted Videos are included. If RLS filters them, deletions never reach Members' machines.
  - `jsonb_agg` null handling (SYNC-15).
  - Statement timeouts (SYNC-16).
  - Monotonic stamps (SYNC-14).
  - Whether a child's FK `SET NULL` cascade bumps the parent.

  These are judged only from the spec and the client code.
- **Live flows.** No Supabase or network access was used, and the app was not run end to end. The race findings (SYNC-3, SYNC-7) were reproduced at the module level, not through a browser.
- **Posters.** The poster upload/download (`src/server/posters.ts`) was only skimmed and is not assessed here.
- **Seeding script.** `scripts/seed-shared.ts` (test seeding only) was not reviewed in depth.
