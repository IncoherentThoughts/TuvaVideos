# TuvaVideos audit — summary

**Date:** 2026-11-04 · **Commit audited:** `2f7b8bf` (main, after #180) · **Method:** 8 parallel automated auditors, report-only, no source changes, no network calls to the archive/Supabase.

Each area report has full detail (scenario, evidence, suggested fix) per finding:

| # | Report | High | Med | Low | Total |
|---|---|---:|---:|---:|---:|
| 01 | [Security](01-security.md) | 2 | 2 | 2 | 6 |
| 02 | [Sync & shared data](02-sync-shared-data.md) | 3 | 5 | 8 | 16 |
| 03 | [Local DB & scanning](03-db-scanning.md) | 1 | 4 | 9 | 14 |
| 04 | [Playback pipeline](04-playback.md) | 1 | 4 | 8 | 13 |
| 05 | [Web frontend](05-web-frontend.md) | 2 | 5 | 8 | 15 |
| 06 | [TV app](06-tv-app.md) | 1 | 4 | 5 | 10 |
| 07 | [Tests, build & deps](07-tests-build-deps.md) | 2 | 5 | 10 | 17 |
| 08 | [Spec/doc drift](08-spec-drift.md) | 0 | 5 | 14 | 19 |
| | **Total (raw)** | **12** | **34** | **64** | **110** |

No Critical findings. Two cross-report duplicates: **PLAY-1 = TV-1** (same `/copy/:id` bug, found independently) and **PLAY-10 ≈ DB-6** (relocate keeps the old keyframe index). That leaves **108 distinct findings, 11 of them High**. About 85% are CONFIRMED by a repro the auditor actually ran; the rest are PLAUSIBLE (traced in code, not reproduced) and are marked as such in each report.

## Baseline

- `bunx tsc --noEmit` passes. `bun test`: 914 pass / 1 skip / 2 fail once `cwebp` is installed.
- The 2 failures are **BLD-1**: `test/integration.test.ts` hard-codes `/usr/local/bin/ffmpeg`. Its whole 36-test end-to-end suite silently never runs on Linux or on an Apple-Silicon-only Homebrew. With the paths fixed, all 36 pass here.
- One real flaky test: **BLD-4** (`tv.test.ts`, about 2 in 85 runs).

## Fix first (High, in suggested order)

| Order | ID(s) | Area | Problem | Why first |
|---|---|---|---|---|
| 1 | **SEC-1, SEC-2** (+SEC-3, SEC-4) | Security | Any website the user visits can approve itself as a TV and read and stream the library cross-origin (SEC-1). DNS rebinding reaches nearly every localhost route, including delete-with-media, which moved a file to the Trash in the repro (SEC-2). | Remotely triggerable with no user action. One fix closes all four: Host check on every request plus an Origin check on writes at the top of the localhost handler, refusing loopback TV approvals, and dropping `ACAO: *` on the TV listener. |
| 2 | **SYNC-1** | Sync | Legacy uuids from migration 0015 are the same on every machine, so reconcile and apply merge unrelated rows across Members (Copy, Favorite and Resume move onto the owner's Video; Chapters move). | Silent data corruption in the shared library for any Member with a pre-#112 library. |
| 3 | **SYNC-2** | Sync | The touch trigger re-stamps unchanged Chapters with this machine's clock, so later edits fail as false `conflict`s. | Breaks normal editing after any Sync or sign-in. |
| 4 | **SYNC-3** | Sync | A window-focus Sync runs during the sign-in confirmation; Cancel leaves a half-signed-in Local copy. | Spec §2.3 violation with a state the user can't undo. |
| 5 | **WEB-1** | Web | The Delete dialog follows navigation (`r`, Playlist advance) and then names, and deletes, a different Video. | A destructive action lands on the wrong target. |
| 6 | **PLAY-1 / TV-1** | Playback/TV | `/copy/:id` uses only the browser's Playback profile: the TV gets a 503 or the Fallback and starts a browser transcode on the Mac. | The TV can't play Copies it supports natively; contradicts tv-spec §3.2. |
| 7 | **WEB-2** | Web | Cancelling sampled Auto in the Audio panel wipes and saves the Video's Audio settings. | Silent loss of user settings. |
| 8 | **DB-1** | Scanning | On Linux an empty mount point counts as a mounted Root: a Rescan marks every Copy Missing, and the remount is never noticed. | Breaks the Missing-vs-unavailable rule for external drives. |
| 9 | **BLD-1, BLD-2** | Tests | The hard-coded ffmpeg path disables the only end-to-end suite, and there is no CI to notice. | Cheap fixes that put the safety net under every other fix. 07 §"Proposed CI" has a ready workflow. |

## Recurring themes (where the Mediums cluster)

1. **The Now-playing page stays mounted across Videos without resetting per-Video state.** This is the single root cause of WEB-1, WEB-3, WEB-4, WEB-5 and WEB-8. Keying the page on the Video id, or resetting its state on id change, fixes the cluster.
2. **Background jobs don't check whether their input changed or the app is shutting down.** PLAY-2 (two instances, a partial Fallback served as ready), PLAY-3, PLAY-5, PLAY-6, DB-10, DB-12, DB-14. Suggested pattern: capture the Copy's (size, mtime) generation at job start and compare before writing; use a per-instance temp name or lock file; add timeouts; keep the port bound until the jobs drain.
3. **Sync clock and watermark assumptions.** SYNC-5, SYNC-10, SYNC-13 and SYNC-14 all assume local and archive clocks agree, or that `updated_at` is monotonic. Clamping the watermark to `server_time` and comparing archive stamps only with archive stamps removes most of them.
4. **Cache invalidation after writes and Syncs in the web UI.** WEB-6 and WEB-7 (stale grid and Song filter until reload).
5. **TV robustness.** TV-2 (a transient network error becomes a permanent "codecs" failure), TV-3 (seek ramp under key repeat), TV-4 (black screen on old Tizen), TV-5 and TV-7 (focus loss).
6. **Linux/Windows portability gaps** in a macOS-developed app. DB-2 (NFD filenames never added), DB-5 (Windows Recycle Bin gets no path), BLD-12, BLD-14, DOC-13.
7. **Docs are behind the code.** The retired Mirror is still in the UI (DOC-3); `spec.md` and `data-model.md` are still "normative" for the v1 design (DOC-5); the ADRs have no status lines (DOC-6). DOC-2 is a real bug the doc check surfaced: the default Type changed to `song`, but reconcile still treats `other` as the default, which creates spurious Shelved edits.

## Notable "checked and sound"

- **XSS:** none. Payloads planted in every title field and as raw lyric HTML, plus 50 fuzzed sanitizer inputs, did not execute anywhere (05). So the cross-site Song-planting chain (SEC-3) doesn't reach script execution today.
- **Commands and SQL:** no command injection (every subprocess gets an argv array, and a `-`-leading filename was handled), no SQL injection, no path traversal in stream, thumbnail, poster, relocate or screenshot routes (01).
- **Tokens and secrets:** no secrets in the tree or git history; the service-role key is env-only (01). The repo does carry personal data: home LAN IPs and the TV's device id, plus `/Users/...` paths (SEC-6, BLD-13).
- **Streaming:** HTTP Range handling is correct across suffix, past-EOF, 416, multi-range and HEAD; no file-handle leaks after 30 aborted streams (04).
- **Rules that hold:** the Preferred Copy rule and the 30 s Resume rule match CONTEXT.md, and migrations are transactional and deterministically ordered despite the duplicate `0008_`/`0011_` prefixes (03, 04, 08).
- **Dependencies:** `bun audit` is clean and the lockfile is consistent (07).

## Not covered

- **Archive side:** its SQL (RLS, write RPCs, `shared_changes_since`) lives in another repo and the live project was deliberately not contacted, so findings that depend on it are marked PLAUSIBLE.
- **Hardware and OS:** no real Samsung or LG TV, macOS (Music.app/Studio, Trash), Windows or PowerShell, or removable drive. Those paths were reviewed from code or simulated.
- **Not yet built:** Live remux (`/live/*` is 404), so "one at a time" can't be tested.
- **Scale:** large-library performance only on synthetic data (DB-4: about 24 s event-loop block after a scan with 1,700 Videos).

## Repro material

`repros/NN/` holds the auditors' throwaway scripts and tests (for example `repros/02/sync.audit.repro.ts`, 11 tests that pass while the sync bugs exist; `repros/01/repro.sh`). They were written against scratch paths in the audit container, so treat them as reference for writing real regression tests, not as a runnable suite. Test files are renamed `*.repro.ts` so `bun test` does not pick them up.

## Fix status (2026-11-05)

All eight fix branches are merged into `claude/relaxed-babbage-jo4tzo`. After each merge, `bun run typecheck` and the full `bun test` ran green. The final suite is **1,116 pass, 1 skip, 0 fail**, up from 914 / 1 / 2 at audit time. Each fix came with a regression test where a test was possible.

| Area | Fixed | Partial | Not fixed |
|---|---|---|---|
| Security (SEC-1..6) | all | — | — |
| Sync (SYNC-1..16, DOC-2) | SYNC-1, 2, 3, 4, 6, 7, 9, 10, 12, 13, DOC-2 | SYNC-5 (a local edit made during a drain is still overwritten), SYNC-8, SYNC-11 (undo of a deleted Chapter loses its star), SYNC-15, SYNC-16 | SYNC-14 (needs monotonic stamps in the archive) |
| DB & scanning (DB-1..14) | DB-1, 2, 4, 5*, 6, 7, 9, 12, 14 | DB-3 (half-copied files aren't skipped), DB-8 / DB-11 (counted, not surfaced in the UI), DB-10 (no progress), DB-13 (no case-insensitive compare) | — |
| Playback (PLAY-1..13) | all | — | — |
| Web (WEB-1..15, DOC-1, DOC-3) | all; WEB-6, 10, 12, 15 verified by unit test or code reading only | — | — |
| TV (TV-1..10) | all; TV-2 verified for the outage-at-load case only | — | — |
| Tests/build (BLD-1..17) | BLD-1..6, 9..17 | BLD-7 (no tests for the session state machine), BLD-8 (documented, not restructured) | — |
| Docs (DOC-4..19) | all | — | — |

\* DB-5 (Windows Recycle Bin): unit-tested only; no PowerShell in the audit container.

**Migrations added:** `0019_browser_profile_version.sql` (PLAY-8) and `0020_touch_skips_apply.sql` (SYNC-2). Both run at the next launch.

**Archive-side follow-ups** (not doable from this repo): [archive-followups.md](archive-followups.md), covering SYNC-14, -15, -16, -8, -13, -4, -1.

**Behaviour changes worth knowing:**
- **Localhost writes:** they must come from the app's own page, as `application/json`. Desktop testing of the TV page at `127.0.0.1` needs `TUVA_TV_LOOPBACK=1`.
- **TV approval:** loopback and the Mac's own addresses can no longer be approved as TVs.
- **Instance lock:** one app instance per data dir (`instance.lock`). A second Ctrl-C forces quit.
- **Matchers:** the Song and Artist matchers run for newly added Videos, in batches, not over the whole library after every scan.
- **Lyrics editor:** Esc closes it but keeps the draft; Cancel discards it.
- **TV seeking:** holding an arrow scrubs at about 40 s per second instead of climbing the ramp.
- **TV pairing:** the address screen opens by itself with the number pad focused and the subnet pre-filled. The Mac's TV menu shows its address and Allow/Deny buttons.
- **Minimum TV:** Tizen 7.0 (Chromium 94) for the shell.
- **Personal data:** `tv/shell/tv.json` is untracked (see `tv.example.json`). Restore your copy after pulling with `git show 16d9f1d:tv/shell/tv.json > tv/shell/tv.json`.

**Owner actions:**
1. Run `bun run tv-install` (and `bun run lg-install`) to get the new shell: the error screen and the address screen.
2. Restore `tv/shell/tv.json` as above.
3. Remove any `127.0.0.1` or Mac-IP rows from the Approved TV list.
4. Check the first CI run on GitHub, especially the macOS job, which has never run.
5. Check on the real TV: hold-to-scrub, the Resume handoff, focus after Back, and the pairing flow. Screenshots: `screens/tv/`, `screens/web/`.
