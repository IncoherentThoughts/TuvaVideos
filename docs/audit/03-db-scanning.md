# Audit 03: local database, migrations, scanning and filesystem

Auditor 3 of 8, 2026-11-04. Scope: `migrations/*.sql`, `src/server/db.ts`, `scan.ts`, `roots.ts`, `rootSetup.ts`, `relocate.ts`, `hash.ts`, `filename.ts`, `probe.ts`, `catalog.ts`, `deleteVideo.ts`, `platform.ts`, `config.ts`, `defaults.ts`, `thumbs.ts`, `keyframes.ts`, `posters.ts`. Repros were run with bun:test scripts against `:memory:` or scratch databases and tiny ffmpeg test videos, all in the scratch dir. No source file was changed.

## Summary

The migration runner is sound: every file runs inside one transaction, the duplicate prefixes (0008_*, 0011_*) apply in a fixed name order, and a failed migration rolls back cleanly. The weak points are in how the scanner and the Root check read the filesystem:

- On Linux, an unmounted drive whose mount point is left behind as an empty directory counts as mounted. A Rescan then marks every Copy Missing, and remounting the drive never triggers a scan (DB-1).
- NFC normalization makes files with decomposed (NFD) names impossible to scan on Linux and Windows (DB-2).
- An id-less file that changes in place keeps its old hash as its identity, so an identical copy of it becomes a second Video (DB-3).
- After every Root scan, the full Song and Artist matcher passes run synchronously and block the server (DB-4).
- The Windows Recycle Bin call very likely never receives its path argument, so a media delete on Windows would never trash anything (DB-5).

## Findings

| ID | Severity | Status | Location | Title |
|---|---|---|---|---|
| DB-1 | High | CONFIRMED | src/server/roots.ts:87-103, src/server/scan.ts:362-382 | An empty mount point counts as a mounted Root: every Copy is marked Missing, and the unmount and later remount are never noticed |
| DB-2 | Medium | CONFIRMED | src/server/scan.ts:188, 272-274; src/server/relocate.ts:296 | NFC-normalized `rel_path` points at no file on Linux and Windows: files with NFD names can never be added |
| DB-3 | Medium | CONFIRMED | src/server/scan.ts:307-317, 326 | A changed id-less file keeps its old `videos.content_hash`: an identical copy becomes a duplicate Video |
| DB-4 | Medium | CONFIRMED (synthetic sizes) | src/server/scan.ts:263-266, 345-350; artistSuggest.ts:31-65; songSuggest.ts:32-46 | Full matcher passes run synchronously after every Root scan and once per new Video, blocking the event loop |
| DB-5 | Medium | PLAUSIBLE | src/server/platform.ts:189-210 | Windows trash: `-Command` swallows the path, so `$args[0]` is empty and every media delete keeps its files |
| DB-6 | Low | CONFIRMED | src/server/relocate.ts:324-327 | Relocating a Copy to a different file keeps the old keyframe index |
| DB-7 | Low | CONFIRMED | src/server/db.ts:31-66 | Two processes migrating at once: the loser crashes at startup |
| DB-8 | Low | CONFIRMED | src/server/scan.ts:173-179 | Symlinked files and folders inside a Root are skipped without any report |
| DB-9 | Low | CONFIRMED | src/server/filename.ts:67, 98-100 | Any 11-character `[token]` is taken as a YouTube id, so unrelated files merge into one Video |
| DB-10 | Low | PLAUSIBLE | src/server/hash.ts:24-47 | Hashing has no timeout: a hung drive stalls the scanner, and every later scan, forever |
| DB-11 | Low | CONFIRMED | src/server/deleteVideo.ts:61-66, 136-141; scan.ts:240, 301 | `deleted_video` tombstones are permanent and their hits are not counted: a deliberate re-download is ignored without notice |
| DB-12 | Low | PLAUSIBLE | src/server/keyframes.ts:126-142 | Keyframe index race: a 10-minute ffprobe writes its result over a Copy that a scan or relocate changed meanwhile |
| DB-13 | Low | PLAUSIBLE | src/server/api.ts:893-901; src/server/rootSetup.ts:158-164; relocate.ts:250-257 | Root path is not canonicalized (case, symlink, `/`), and first-Root creation has a check-then-insert race |
| DB-14 | Low | PLAUSIBLE | src/server/thumbs.ts:442-447 | A Thumbnail finishing after its Video was deleted leaves orphan files, and the write fails its foreign key |

---

### DB-1 (High, CONFIRMED): an empty mount point counts as a mounted Root

**Description.** `Roots.check` reads one byte of up to three non-Missing Copies. When every read fails with ENOENT (`allGone`), it falls back to `stat(root.path).isDirectory()` (roots.ts:103). An unmounted drive therefore counts as available whenever its mount point directory still exists. That is the normal state for fstab or manual mounts on Linux (`/mnt/drive`, `/media/x` created by hand), and it also happens with a stale `/Volumes/Name` on macOS. `markMissing` re-checks with the same function (scan.ts:365), so its "went away during the scan" guard passes too. Every Copy is then stat'ed, gets ENOENT and is marked Missing. CONTEXT.md says the opposite: "A Copy on an unmounted Root is not missing, only unavailable."

There are two further effects:
1. The poll never flips the state to false, so the unmount itself is never noticed: the Player and the TV app still treat the Root as available.
2. On remount, `check()` finds no non-Missing Copies (roots.ts:83-89), stats the directory, and sees `was === true`. No `onBecameAvailable` fires, so the remount scan never runs (app.ts:45-47). The Copies stay Missing and the Videos read "Not on this machine" (tvRoutes.ts:78 `NOT_HERE_SQL`) until the user presses Rescan by hand. `removeCopies` also deletes the rows of Missing Copies outright (deleteVideo.ts:123).

**Failure scenario.** A Linux user has an external Root at `/mnt/tuva`. They unmount the drive, then press Rescan, or a scan of another Root triggers one. All 1,700 Copies get `missing_since`. They plug the drive back in and nothing revives until another manual Rescan.

**Evidence.** Scratch repro `repro.test.ts`: scan two files, delete the directory's contents to simulate an empty mount point, then call `roots.check(1)` and `scanRoot`. Output: `available after unmount? true markedMissing 2`, with both rows showing `missing_since` set.

**Suggested fix.** Don't treat "directory exists" as proof that the Root is mounted once the Root has known Copies. Options:
- Write a marker file (for example `.tuvavideos-root` holding the root id) into the Root when it is added, and require it.
- Compare `stat(root).dev` with the device recorded at add time, or with the parent directory's `dev` (a mount point has a different `dev` from its parent).
- At minimum, refuse to mark more than N% of a Root's Copies Missing in one pass without confirmation.

Also emit the became-available event when a Root goes from "all Copies Missing" back to readable.

### DB-2 (Medium, CONFIRMED): NFC `rel_path` points at no file on Linux and Windows

**Description.** `walk` stores `relative(rootPath, full).normalize("NFC")` (scan.ts:188). `processEntry` then probes `join(root.path, entry.rel)` (scan.ts:272-274), and later readers (streaming, thumbs, keyframes, trash) open `root + rel_path` too. On APFS and HFS+, lookup ignores normalization, so this works. ext4, btrfs and NTFS compare bytes, so the NFC path names no file. relocate.ts:296 does the same.

A second effect: when a Root already holds two rows whose names differ only in normalization, the `existing` map collapses them into one key (scan.ts:217-219). The other row is never in `seen`, is never marked Missing, and stays as a phantom Copy that looks available.

**Failure scenario.** On Linux, a file `Кӧмей [aaaaaaaaaaa].mp4` written in decomposed form (by a macOS copy over SMB, by an archive tool, or by yt-dlp on another machine) is listed in every scan, fails ffprobe with "No such file or directory", and is never added. It is counted in `probeFailed` on every scan.

**Evidence.** In `repro.test.ts` an NFD-named copy of `a.mp4` produces `probe failed: … No such file or directory`, summary `probeFailed: 1`, and no Copy rows. In `respell.test.ts`, NFC and NFD rows for one file remain two Copy rows after a scan, and the NFD one is not marked Missing.

**Suggested fix.** Store the on-disk spelling in `rel_path` and use the NFC form only as a matching key: keep a normalized key column, or normalize only when looking up `existing`. Open files by the exact listed name. Collapse duplicate-key rows explicitly, for example by merging them or marking the extras Missing.

### DB-3 (Medium, CONFIRMED): a changed id-less file keeps a stale Video identity

**Description.** When a known Copy's size or mtime changes, the scanner updates the Copy row, including `copy.content_hash = COALESCE(new, old)`. It never re-evaluates the Video, so `videos.content_hash` keeps the hash of the old bytes (scan.ts:307-317). New files are matched only against `videos.content_hash` (scan.ts:326).

**Failure scenario.** The user drags a large id-less `.mkv` into the Root, and a remount or Rescan scan runs while the copy is in progress. Matroska and faststart MP4 probe fine when truncated. The Video gets the hash of the half-written file. The next scan fixes the Copy's size and hash, but the Video keeps the partial hash. Copying the same file into another folder later, or re-downloading it, creates a second Video with identical bytes. The same applies to a file replaced in place by different footage: it stays attached to the old Video, with the old title, Chapters and so on.

**Evidence.** `partial.test.ts`: write half of `c.mkv`, scan, write the full file, scan, add `backup/Concert.mkv` with the same bytes, scan. Result: two `videos` rows (hashes `c380161a…` and `9bbc4fc1…`), and both Copies hold hash `9bbc4fc1…`. `repro.test.ts` ("content replaced in place") shows `videos.content_hash` unchanged while `copy.content_hash` changed.

**Suggested fix.** When an id-less Copy is that Video's only Copy and its hash changes, update `videos.content_hash` (if the new hash belongs to no other Video), or merge it into the Video that holds the new hash. Also consider skipping files whose mtime is within the last few seconds, or whose size changes between the walk and the probe, so files still being written are not taken in.

### DB-4 (Medium, CONFIRMED with synthetic sizes): matcher passes block the event loop after every scan

**Description.** After each Root scan, `scanRoot` runs `applyPerformanceDefaults`, `suggestSongsFromTitles` and `suggestArtists` over every Unshared Video, then `rebuildSearchIndex` (scan.ts:263-266). Each one is synchronous bun:sqlite plus pure-JS fuzzy matching inside one transaction. `processEntry` also runs songs, artists and Latin titles for each new Video (scan.ts:345-350), and each of those calls reloads and re-prepares every Song and every Artist (songSuggest.ts:36-46, artistSuggest.ts:33-44). While these run, the HTTP server and the TV Server (same process) cannot answer, so playback range requests and the UI stall.

**Evidence.** `bench.ts` uses a synthetic library of 1,700 Videos, 3,000 archive Songs and 600 Artists. The per-new-Video cost was about 26 ms for songs, 13 ms for artists and 24 ms for Latin titles, so roughly 65 ms × N new Videos on a first scan. The post-scan full passes took `songs 6896 ms`, `artists 16686 ms`, `defaults 2 ms`, search rebuild 75 ms. Synthetic names share many words, so the real figures depend on the archive. The structure is confirmed: the cost is O(Videos × Artists) and O(Videos × Songs), it is synchronous, and it runs once per Root scanned. A Rescan with two Roots does it twice.

**Suggested fix.** Run the full passes only for Videos touched by the scan (pass the new or changed ids), or once after the queue drains rather than per Root. Prepare the candidate lists once per scan and not once per new Video. Split long loops into chunks that yield (for example `await Bun.sleep(0)` between batches, with short transactions).

### DB-5 (Medium, PLAUSIBLE): the Windows trash command likely never receives the path

**Description.** `trashCommandFor("win32")` runs `powershell -NoProfile -NonInteractive -Command <PS_RECYCLE> <path>` and expects the path in `$args[0]` (platform.ts:189-191, 209). For `-Command`, the PowerShell documentation says it must be the last parameter, and every argument after it is part of the command text, not `$args`. The script PowerShell actually parses is `…DeleteFile($args[0], 'OnlyErrorDialogs', 'SendToRecycleBin') C:\lib\x.mp4`. That is a parse error ("Unexpected token"). Even if it parsed, `$args[0]` would be `$null`.

**Failure scenario.** On Windows, every "delete with media" reports each file as kept with a PowerShell parse error, tombstones the identity and deletes the entry. The files are never moved to the Recycle Bin. This fails safe, with no data loss, but the feature does not work. It is untested on Windows: `test/onboarding.test.ts:20` checks only the argv shape. A separate point: `SendToRecycleBin` on a drive with no Recycle Bin (network shares, some removable media) deletes permanently with no prompt under `OnlyErrorDialogs`.

**Evidence.** Code trace only. No PowerShell is available in this container.

**Suggested fix.** Use `-File` with a script, or `-EncodedCommand`/`-Command` with a `param($p)` script block: `-Command "& { param($p) ... } "` followed by an argument. Alternatively, pass the path through an environment variable (`$env:TUVA_TRASH_PATH`). Refuse to trash on drives where the Recycle Bin is unavailable.

### DB-6 (Low, CONFIRMED): relocate keeps a stale keyframe index

**Description.** The relocate UPDATE resets `tv_playback`, `fallback_file`, `content_hash` and `missing_since`, but not `keyframes` (relocate.ts:324-327). The scanner's equivalent UPDATE does reset it (scan.ts:312). A Copy relocated to a different encode keeps the old file's keyframe times, so keyframe seeks (spec 4.1) land on times that are not keyframes in the new file.

**Evidence.** In `repro.test.ts` ("relocate keeps the old keyframe index"), after relocating to `Other encode.mp4` the row still has `hex(keyframes) = E8030000`.

**Suggested fix.** Add `keyframes = NULL` to the relocate UPDATE.

### DB-7 (Low, CONFIRMED): concurrent migrators crash

**Description.** `migrate` reads the `migration` table once, then runs each pending file with a deferred `BEGIN`. When the app and a CLI (`index-keyframes`, `suggest-*`, `latin-titles`, a passive second server) open the same `library.db` right after an upgrade, both try the same migration. The second one fails with "already exists" or "duplicate column" and throws, which is not the legacy path, so that process exits. The database stays consistent.

**Evidence.** `mig2.ts`, run five times on a fresh file with two processes in parallel. Each time one process failed, for example `0001_schema.sql failed: table root already exists` or `0002… duplicate column name: r_frame_rate`, and once `0015_local_copy.sql failed: no such table: video`. `chk.ts` afterwards showed 20 migration rows, user_version 18 and `integrity_check: ok` on all five.

**Suggested fix.** Take the write lock first (`BEGIN IMMEDIATE`), then re-read the `migration` table inside the transaction and skip files recorded meanwhile.

### DB-8 (Low, CONFIRMED): symlinks inside a Root are skipped without a report

**Description.** `walk` uses `Dirent.isDirectory()` and `isFile()`, both false for symlinks, so symlinked files and folders are skipped (scan.ts:175-179). They are not counted anywhere in the summary.

**Evidence.** `repro.test.ts`: a symlinked file and a symlinked folder inside the Root give `filesSeen 0`, copies 0.

**Suggested fix.** Either follow symlinks with `stat`, guarding against loops with a set of (dev, ino) pairs and keeping targets inside the Root, or count them in `RootScanSummary` and say so in the UI.

### DB-9 (Low, CONFIRMED): any 11-character bracket token becomes a YouTube id

**Description.** `YT_RE = /\[([A-Za-z0-9_-]{11})\]$/` (filename.ts:67) accepts any 11-character token, for example `[1080p60_HDR]`, `[Ustuu-Huree]` or `[Khoomei2019]`. The id is the Video's identity, so two different files ending in the same token become Copies of one Video. Content hashing is skipped for them as well.

**Evidence.** `parseFilename("Kongurei [1080p60_HDR].mp4").youtubeId` returns `"1080p60_HDR"` (repro output).

**Suggested fix.** Hard to make exact. Some options: report "YouTube id" Videos whose Copies differ widely in duration; let a user mark a Video as "not a YouTube id"; or reject tokens that look like a resolution or year (`^\d{3,4}p`, `\d{4}$`).

### DB-10 (Low, PLAUSIBLE): hashing has no timeout

**Description.** `sha256Once` streams the whole file with no timeout and no progress (hash.ts:24-32). The scanner awaits it inside the scan loop. `probeFile` has a 120 s timeout and the Root check has 5 s. If a USB drive hangs mid-read, which on macOS can block reads indefinitely rather than returning EIO, the scan never finishes. `Scanner.running` stays true, and every later Rescan or remount scan only queues behind it. On huge id-less files (tens of GB) the full SHA-256 is also slow, and only `HASH_CONCURRENCY = 2` bounds it.

**Evidence.** Code trace. Not reproduced, because that needs a hanging block device or FUSE.

**Suggested fix.** Use a stall timeout (no `data` event for N seconds means destroy the stream and report an I/O error). Report hashing progress in `ScanProgress`.

### DB-11 (Low, CONFIRMED): tombstones are permanent and their hits are not counted

**Description.** `deleteVideo` writes `deleted_video` whenever any file stays on disk, including when the trash command failed or a drive was unmounted (deleteVideo.ts:61-66). No code path ever deletes from `deleted_video` (only `migrateShared` reads it). The scanner drops matching files with a bare `continue` and no summary counter (scan.ts:240, 301). The rule is intentional (spec 2.3), but there is no undo. A user who deletes a Video "entry only", or whose media delete partly failed (as every Windows media delete would under DB-5), and who later downloads the same YouTube id on purpose will never see it come back, with no indication why. The rules are also uneven: a media delete where one Copy was Missing at that moment writes no tombstone, so that file revives as a new Video when its drive comes back.

**Evidence.** `grep deleted_video src` shows only INSERT and SELECT, and scan.ts:240/301 shown above.

**Suggested fix.** Count `skippedDeleted` in `RootScanSummary` and show it. Offer "restore" (delete the tombstone row) from the control center. Consider tombstoning Missing Copies' identities too.

### DB-12 (Low, PLAUSIBLE): keyframe index race

**Description.** `KeyframeIndex.index` reads the path, runs ffprobe (timeout 600 s), then writes `UPDATE copy SET keyframes = ? WHERE id = ?` with no condition (keyframes.ts:126-142). A scan that meanwhile updated the Copy (scan.ts:312 sets `keyframes = NULL`) or a relocate gets its NULL overwritten with the old file's index.

**Suggested fix.** Write with `WHERE id = ? AND keyframes IS NULL AND rel_path = ? AND size = ? AND mtime = ?`, using the values read before the probe.

### DB-13 (Low, PLAUSIBLE): the Root path is not canonicalized, and creation races

**Description.** `parseRootInput` only runs `normalize` on the path. It does not resolve symlinks or case, and it accepts `/` (rootSetup.ts:158-164). `relocate.rootFor` compares strings (relocate.ts:250-257). On macOS, a Root typed as `~/Movies/tuva` when the folder is really `~/Movies/Tuva`, or reached through a symlink, works for scanning. But the path returned by the osascript file picker (the canonical one) is then rejected as "outside the library folders". `POST /api/roots` checks `roots.list().length > 0`, then awaits `checkRootPath`, then inserts (api.ts:897-901). Two requests in flight can both pass the check and create two Roots, or a UNIQUE error (500) for the same path.

**Suggested fix.** Store `realpath(path)`. Compare paths case-insensitively when the volume is case-insensitive. Refuse `/` and the data dir. Make the existence check and the insert one statement (`INSERT … WHERE NOT EXISTS (SELECT 1 FROM root)`).

### DB-14 (Low, PLAUSIBLE): Thumbnail written after its Video was deleted

**Description.** `Thumbnails.generate` renames the poster and strip into `thumbs/`, then upserts `video_local` (thumbs.ts:442-447). If the Video was deleted during the minutes generation takes, `deleteVideo` has already unlinked the cache files. The rename then recreates them, and the `INSERT … video_local` fails its foreign key and is logged as "crashed". This leaves orphan `<uuid>.poster.webp` and `<uuid>.strip.webp` files.

**Suggested fix.** Before renaming, check that the Video still exists, or write the DB row first and remove the files when the write fails.

---

## Checked and found OK

- **Migration ordering with duplicate prefixes.** `migrationFiles` sorts by name, then stable-sorts by number. 0008_local_songs comes before 0008_loop, and 0011_deleted_videos before 0011_instagram_titles, the same way on every run. Progress is recorded per file name in `migration`, so a database that merged only one of a pair still gets the other. The legacy bootstrap (empty `migration` table, `user_version > 0`) is safe for this file set: each file ≤ 0014 either opens with a CREATE or ALTER ADD COLUMN that fails as "already exists", or can be re-run (0010 rebuild, 0011_instagram_titles UPDATEs).
- **Transactions and failure.** Each file runs in `BEGIN…COMMIT`. A failure partway through rolls back everything, including the `user_version` and `migration` row. Verified with an injected `0019_bad.sql`: no partial table, user_version stayed 18, and after the bad file was removed the next file applied. No migration contains its own BEGIN, COMMIT or PRAGMA. `foreign_keys` is switched outside the transaction for `-- foreign_keys: off` files and turned back on in `finally`. `foreign_key_check` runs before COMMIT.
- **0010, 0015 and 0017 table rebuilds.** Views are dropped before RENAME and DROP COLUMN, columns are named explicitly in the copies, and indexes are recreated. 0015 drops orphan rows through its `JOIN vid_map`/`art_map`, which is acceptable.
- **Schema integrity.** Every child of `videos` other than `copy` uses `ON DELETE CASCADE`. `copy` deliberately does not cascade, and `deleteVideo` and `dropVideo` delete Copies first. `copy` has `UNIQUE(root_id, rel_path)` plus a `copy_video` index. `videos.youtube_id` and `content_hash` are UNIQUE, and the `instagram_id` and `rutube_id` indexes are partial. `deleted_video` has UNIQUE keys. Each connection sets `foreign_keys = ON`, WAL mode and a 5 s busy_timeout in `openDb`, and every opener in src and scripts goes through `openDb` (except one read-only open in scripts).
- **Concurrent scans within one process.** `Scanner` keeps one loop and a deduplicated queue. In-process concurrency (pool of 4) is safe because the find-or-insert block is one synchronous transaction. Across processes, the UNIQUE constraints stop duplicates (the loser's entry fails and is retried at the next scan).
- **Drive vanishing mid-scan** (when the mount point also vanishes): `markMissing` re-checks the Root, and directories that failed to list protect everything under them.
- **Instagram and Rutube provenance matching** follows ADR 0005 and 0008: only for id-less files, only after a hash miss, picking the lowest `created_at, id`, and the provenance id is picked up only on Unshared Videos.
- **`deleteVideo` paths.** Files are only trashed through the trash command, never `unlink`ed. The path is always `root.path + rel_path` of that Video's own Copies. Copies on unmounted Roots and Missing Copies are never touched. Without a trash command, files are kept and a notice is returned. Shared Videos are refused.
- **`config.ts`.** Data dir per platform (XDG, APPDATA) and `TUVA_DATA_DIR` override are as specified.
- **Windows backslashes in `rel_path`.** The `failedDirs` prefix check in `markMissing` uses `/`. On Windows this only matters when a directory vanished mid-scan, and then its Copies really are gone.
- **`hash.ts` seed cache.** It is keyed by path, size and mtime and is read-only.
- **`catalog.ts` and `defaults.ts`** queries are indexed and transactional.
- **`posters.ts`.** Writes go through a temporary file and a rename. Id validation for Sync input belongs to the sync auditor.

## Not covered / blocked

- No real case-insensitive or normalization-insensitive filesystem (APFS, NTFS) and no real removable drive in the container. DB-1 was simulated with an empty directory, and DB-2 was tested on ext4 or overlayfs only.
- No PowerShell, so DB-5 is a code and documentation trace only.
- DB-4 timings use a synthetic archive. The real library's numbers were not measured.
- Not reviewed in depth: `stream.ts`, `fallback.ts` and `tvRoutes.ts`, which open `root + rel_path` (DB-2 affects them too), and the Sync apply (`localCopy/apply.ts`) as it touches `videos` or `copy` (other auditors).
- `bun test` was not re-run: nothing under src, test or migrations was changed, so the baseline (914 pass / 2 fail) holds.
- Scratch repros are in `/tmp/claude-0/-home-user-TuvaVideos/81dd5c87-daef-5003-ad39-65f9bcc41023/scratchpad/audit-03/` (`repro.test.ts`, `respell.test.ts`, `partial.test.ts`, `mig2.ts`, `chk.ts`, `failmig.ts`, `bench.ts`).
