# Audit 07: test suite health, build, dependencies, scripts

Auditor 7 of 8, unattended. Repo at `2f7b8bf`, Bun 1.4.4, Linux x86_64 container (Ubuntu ffmpeg 6.1.1, cwebp and gio in `/usr/bin`, nothing media-related in `/usr/local/bin`).

## Summary

- **The 2 failures come from one hard-coded path.** `test/integration.test.ts` runs `/usr/local/bin/ffmpeg` and `/usr/local/bin/ffprobe` directly instead of using the app's `findBin`. In this container it hits ENOENT in `beforeAll`, and the whole 36-test file never runs. It also counts as "2 unnamed failures" instead of 36 failures. With the path changed to `/usr/bin` (on a scratch copy), all 36 tests pass on Linux. The same failure happens on any Apple Silicon Mac that only has `/opt/homebrew`.
- **The suite is deterministic across 3 full runs** (914/1/2 each time) and passes with outbound network blocked. But `tv.test.ts` has a real intermittent failure: about 2 failing tests per ~85 file runs, a 503 caused by a random order tie in `/api/videos`. Most stateful test files also fail under `--randomize` (28–30 failures), because their tests depend on running in order.
- **The riskiest code paths have no test that actually runs:**
  - `deleteVideo` trashing and tombstoning is covered only by the integration test that never runs.
  - The `relocate` probe/update path has no test.
  - The scan I/O-error paths have no test.
  - The browser session/write layer (`session.ts`, `writeLink.ts`) has 0% function coverage.
- **There is no CI**, which is why BLD-1 went unnoticed. `scripts/` and `tv/` are not type-checked; doing so gives 68 errors (a few real, most from stale prototypes and smoke scripts). Dependencies are clean (`bun audit`: 0 vulnerabilities, the lockfile is frozen-consistent), apart from `@types/bun: "latest"`.

## Findings

| ID | Severity | Status | Location | Title |
|---|---|---|---|---|
| BLD-1 | High | CONFIRMED | test/integration.test.ts:21,37,207,225 | Integration test hard-codes `/usr/local/bin/ffmpeg`/`ffprobe`: its 36 tests never run on Linux or on Apple Silicon Macs with only `/opt/homebrew` |
| BLD-2 | High | CONFIRMED | (repo root, no `.github/`) | No CI: a broken integration suite, type errors in `scripts/` and `tv/`, and flaky tests go unnoticed |
| BLD-3 | Medium | CONFIRMED | test/integration.test.ts:10,54-57 | A setup failure hides 36 tests (reported as 2 unnamed failures), crashes `afterAll` and leaks the temp dir |
| BLD-4 | Medium | CONFIRMED (flake) / PLAUSIBLE (cause) | test/tv.test.ts:262-272; src/server/api.ts:292,346-349 | Intermittent 503 in "every listed route then answers": `videos[0]` is picked at random, so it is sometimes the PCM Copy whose Fallback is still being made |
| BLD-5 | Medium | CONFIRMED | src/server/deleteVideo.ts:36-74, src/server/relocate.ts:82-119, src/server/api.ts:868-876 | Coverage gap: delete-with-trash, tombstone and relocate probe/update paths are tested only by the integration test that does not run, or not at all |
| BLD-6 | Medium | CONFIRMED | src/server/scan.ts:136-138,153-157,167-171,251-254,276-279 | Coverage gap: scan I/O-error, readdir-retry and dir-error paths (the ones that decide whether Copies go "missing") are untested |
| BLD-7 | Medium | CONFIRMED | src/web/session.ts, src/web/writeLink.ts, src/web/sharing.ts | Coverage gap: the browser auth session and the Shared-write router have 0% function coverage |
| BLD-8 | Low | CONFIRMED | test/{tv,studio,chapters,session,...}.test.ts | Tests within a file depend on running in order (28–30 failures under `bun test --randomize`) |
| BLD-9 | Low | CONFIRMED | src/server/api.ts:605-610,614-620 | `as typeof body` lets a JSON `null` body through, so `/resume` and `/loop` return 500 instead of 400 |
| BLD-10 | Low | CONFIRMED | tsconfig.json:17; scripts/fetch-youtube-info.ts:56; tv/home-prototype/*.ts; scripts/smoke-v1-build-*.ts | `scripts/` and `tv/` are not type-checked: 68 errors, the TV prototype fails its own tsconfig, and the smoke scripts are stale |
| BLD-11 | Low | CONFIRMED | package.json:31 | `@types/bun: "latest"` is not reproducible (lock has 1.4.2, runtime is 1.4.4) |
| BLD-12 | Low | CONFIRMED | scripts/download-*.sh | zsh-only download scripts hard-code `/Users/evanwilliams/...`, and `| tee` hides yt-dlp's exit status |
| BLD-13 | Low | CONFIRMED | tv/shell/tv.json; .claude/launch.json.prototypes.bak; test/archive.test.ts:18 | Committed machine-specific and personal data (LAN IPs, TV DUID, another machine's temp paths, maintainer's backup path) |
| BLD-14 | Low | CONFIRMED (inconsistency) / PLAUSIBLE (which is right) | scripts/setup.ts:36-44; README.md:14; src/server/platform.ts:22; src/server/config.ts:35 | Setup hints disagree with the README (scoop vs winget) and with each other (the macOS version that ships `trash`: 14 vs 15) |
| BLD-15 | Low | CONFIRMED | scripts/make-app.ts:27-35,83,86-87 | `make-app.ts` has no platform guard, deletes the old `.app` before it has checked its tools, puts the Rosetta `/usr/local/bin` first in the launcher's PATH, and builds shell quoting with `JSON.stringify` |
| BLD-16 | Low | CONFIRMED | test/relocate.test.ts:14; test/writeSeam.test.ts:302; test/migrateShared.test.ts:200 | Tests leak `mkdtemp` directories in `/tmp` |
| BLD-17 | Low | CONFIRMED | .gitignore; scripts/doc-missing-urls.txt | `.gitignore` gaps (`__pycache__/`, `coverage/`, `*.bak`, `.env*`) and a dead committed URL list |

Counts: Critical 0, High 2, Medium 5, Low 10.

---

## Root cause of the 2 failing tests

**Command:** `bun test test/integration.test.ts`

```
21 |   const p = Bun.spawn(["/usr/local/bin/ffmpeg", "-v", "error", "-y", ...args], ...
ENOENT: no such file or directory, posix_spawn '/usr/local/bin/ffmpeg'
      at ff (test/integration.test.ts:21:17)
      at <anonymous> (test/integration.test.ts:31:9)
(fail) (unnamed) [0.98ms]
55 |   await app.stop();
TypeError: undefined is not an object (evaluating 'app.stop')
(fail) (unnamed) [0.17ms]
 0 pass
 2 fail
```

- **What causes it.** The test's own fixture helper `ff` (line 21), the piped webm spawn (line 37) and two `ffprobe` checks (lines 207, 225) all use the absolute paths `/usr/local/bin/ffmpeg` and `/usr/local/bin/ffprobe`. In this container ffmpeg is `/usr/bin/ffmpeg` (`which ffmpeg`), and `/usr/local/bin` has no ffmpeg. `beforeAll` throws on the first fixture, `app` is never assigned, and `afterAll` then dereferences `undefined`.
- **What it is not.** It is not ffmpeg's version, a missing encoder, or a bug in the app. I made a scratch copy with only the paths rewritten to `/usr/bin` and the imports made absolute (`scratchpad/audit-07/integration.patched.test.ts`). It gives `36 pass, 0 fail` on Ubuntu ffmpeg 6.1.1, and libx264, libvpx-vp9, aac and eac3 are all available. The app itself is fine: `findBin` in `src/server/config.ts:48-52` checks `TUVA_BIN_DIR`, then `/opt/homebrew/bin`, then `/usr/local/bin`, then `PATH`. `tv.test.ts:132` correctly uses `cfg.ffmpeg`.
- **On the maintainer's Mac.** It passes only if `/usr/local/bin/ffmpeg` exists, which means x86_64 (Intel or Rosetta) Homebrew or a manual install. The comment at `config.ts:44-46` ("the x86_64 build under /usr/local runs under Rosetta") suggests the maintainer has both Homebrews, so it passes there (PLAUSIBLE). On a fresh Apple Silicon Mac with only `/opt/homebrew`, it fails exactly as it does here. On Windows it always fails.
- **There is a second, quieter problem on a dual-Homebrew Mac.** The fixtures are made with the x86 ffmpeg while the app under test uses the arm64 one, so the test is not checking the binaries the app actually runs.
- **The 1 skip** is `test/archive.test.ts:250`: `test.skipIf(!existsSync(REAL))`, where `REAL` is `/Users/evanwilliams/Desktop/Lyrics Website/Backups/supabase_backup_20261007_162813_no_media` (line 18). It only runs on the maintainer's machine against a private backup. The skip is intended, but nobody else can reproduce that test.

---

## Details

### BLD-1 (High, CONFIRMED): integration test hard-codes `/usr/local/bin` binaries

- **Description:** See the root-cause section. Four call sites: lines 21, 37, 207 and 225.
- **Impact:** These 36 tests are the only end-to-end coverage of several areas:
  - scan → API
  - Range streaming against real files
  - remux/transcode Fallbacks
  - delete-with-trash, external-Root unmount and revive
  - screenshots

  They do not run on Linux, on Windows, or on a single-Homebrew Apple Silicon Mac. The README invites Linux and Windows contributors ("please open an issue with what breaks"), and their first `bun test` is red.
- **Evidence:** the output above. The patched copy gives `36 pass 0 fail`. Coverage with the patched copy added raises `deleteVideo.ts` from 53.5% to 98.6% and `stream.ts` from 92.9% to 96.4% (lines).
- **Fix:** In `beforeAll`, use `const { ffmpeg, ffprobe } = loadConfig({...})`, as `tv.test.ts:131-132` does, and pass those to `ff` and the `spawnSync` probes. Then run `bun test` on Linux in CI (BLD-2).

### BLD-2 (High, CONFIRMED): no CI

- **Description:** There is no `.github/` (`ls .github` → "No such file or directory") and no other CI config. `bun test` and `bun run typecheck` run only when the maintainer remembers.
- **Impact:** BLD-1, BLD-4 and BLD-10 all went unnoticed. PRs (#178–#180 are recent merges) land with no automatic gate.
- **Fix:** See "Proposed CI" below.

### BLD-3 (Medium, CONFIRMED): setup failure hides tests, crashes teardown, leaks the temp dir

- **Description:**
  - `base = mkdtempSync(...)` runs when the module is imported (line 10).
  - `afterAll` calls `app.stop()` unconditionally (line 55), so the `rmSync` on line 56 never runs after a setup failure.
  - Bun reports the file as two "(unnamed)" failures and drops the 36 real tests from the total: `Ran 917 tests` without the file and 952 with the patched copy. A reader sees "2 fail" and could treat it as an environment quirk.
- **Evidence:**
  - `ls -d /tmp/tuva-it-*` shows 12 leaked directories after my runs.
  - Full-suite totals: `914 pass / 1 skip / 2 fail / Ran 917`. With the patched copy: `950 pass`, which is 914 + 36.
- **Fix:**
  - Make the teardown `afterAll(async () => { await app?.stop(); rmSync(base, ...) })`.
  - Create `base` inside `beforeAll`.
  - If ffmpeg is missing, fail with an explicit message, or use `describe.skipIf(!ffmpegFound)` so the summary shows 36 skipped, not 2 unnamed failures.

### BLD-4 (Medium, CONFIRMED flake / PLAUSIBLE cause): `tv.test.ts` intermittent 503

- **Description:** `bun test --rerun-each 5 test/tv.test.ts` failed on the 1st of 5 loops and on the 5th of 12 loops. Both times 2 tests failed (the same test on two reruns):

  ```
  272 |  else expect(res.status).toBeLessThan(500);
  Expected: < 500
  Received: 503
  (fail) TV Server listener > Allow stores an Approved TV with its model; every listed route then answers
  ```

- **Likely cause:**
  1. The test takes `videos[0]` and its first Copy (lines 262-264).
  2. `/api/videos` sorts `ORDER BY created_at DESC, id DESC` (`api.ts:292`).
  3. The scanner probes files concurrently, and `created_at` is a millisecond ISO timestamp, so the four fixture Videos can tie. The tie is then broken by a random UUID (`scan.ts:331`, `newUuid()`).
  4. When `videos[0]` is "Pcm [ddddddddddd].mkv", its `/copy/:id` returns the designed `503 {state…} retry-after: 2` while the Fallback transcode that started at scan time is still running (`api.ts:346-349`; the log shows `fallback transcode start (scan): copy 4 Pcm`).
- **Impact:** Occasional red builds once CI exists. The same random tie-break also makes the order of the real library grid unstable for Videos added in the same millisecond. That is minor for the product.
- **Fix:** Choose the Video explicitly in the test (`videos.find(v => v.youtubeId === "aaaaaaaaaaa")`), or accept 503 for a non-native Copy. Optionally add a stable tie-breaker (for example `rowid`) to the list query.

### BLD-5 (Medium, CONFIRMED): delete, relocate and HTTP glue not covered by running tests

- **Description:**
  - Full suite, `bun test --coverage`:
    - `deleteVideo.ts` 53.5% lines; uncovered 36-74 is the whole `deleteVideo` function, including tombstone insert and cache unlink.
    - `relocate.ts` 69.4%; uncovered 84-86 and 98-119 are the "scan already found it" branch, probe, `UPDATE copy`, `INSERT copy` and the Fallback unlink.
    - `api.ts` 73%.
  - With the patched integration test added, `deleteVideo` reaches 98.6%, but `relocate.ts` stays at 69.4%. The `POST /api/videos/:id/relocate` route (`api.ts:868-876`) and the `DELETE /api/videos/:id` and `…/copies` glue (`api.ts:685-688`) have no HTTP-level test.
- **Impact:** These paths move or trash the user's media files and rewrite Copy rows. A regression here loses data.
- **Proposed tests:**
  1. `deleteVideo` with `media: true` and a fake `TUVA_TRASH` script that exits 1: the file stays, `kept[0].reason` holds the script's stderr, and a `deleted_video` tombstone row is written. A rescan does not bring the Video back (`isDeleted`).
  2. `deleteVideo` on a Copy whose Root is unmounted: `kept` says "drive not mounted" and it is tombstoned. On a Shared Video it returns `{refused}`, and no row or file is touched.
  3. `deleteVideo` with `media: false`: all Copies kept, `poster/strip/remux` caches unlinked, `search` rows for the Video and its Chapters gone.
  4. `relocateCopy` to a real new file (make it with `cfg.ffmpeg`): the row is updated, its `fallback_file` is cleared and the old remux file unlinked, `tv_playback` reset, `missing_since` NULL.
  5. `relocateCopy` with `~/…` and with a path outside every Root (400), a directory (400), an `.mp4` with only audio (400 "no video stream"), and a file ffprobe cannot read. For the last case, point `TUVA_BIN_DIR` at a fake ffprobe and check that an EIO-like failure gives 503 and anything else gives 400.
  6. HTTP `POST /api/videos/:id/relocate` with a JSON body `{copyId: "5"}` (a string) returns 404 "not this Video's", not a 500. Related to BLD-9: the body is passed as `as any` at `api.ts:872`.

### BLD-6 (Medium, CONFIRMED): scan error paths untested

- **Description:** The uncovered lines in `scan.ts` (even with the integration test) are:
  - 136-138: a failed Root scan must not abort the scanner.
  - 153-157: `readdirRetry` backoff.
  - 167-171: `dirErrors`/`failedDirs`.
  - 251-254: `ioErrors` vs `probeFailed`.
  - 276-279: probe I/O error leaves the row as it was.
  - 308-316: a changed file re-probes and drops its Fallback.
  - 366-367.

  `failedDirs` is what stops `markMissing` from marking a whole unreadable subtree "missing".
- **Impact:** A flaky USB drive is exactly the case the spec designs for. If these branches break, Copies get marked missing, Fallbacks deleted, or the scanner wedges, and no test fails.
- **Proposed tests:**
  1. A fake `ffprobe` via `TUVA_BIN_DIR` that prints `Input/output error` and exits 1 for one file: `summary.ioErrors === 1`, an existing Copy row keeps its `size` and `missing_since IS NULL`, and no row is inserted for a new file.
  2. Make a subdirectory unreadable. As root, `chmod 000` does not block reads; inject `readdir` or use a dangling symlinked dir instead. That file's existing Copy must not get `missing_since`, and `dirErrors` names the dir.
  3. Change a file's mtime/size after the first scan: `updatedCopies === 1`, `fallback_file` cleared and its remux file deleted.
  4. One Root's `scanRoot` throws: the next Root is still scanned and `whenIdle()` resolves.

### BLD-7 (Medium, CONFIRMED): browser session and Shared-write layer untested

- **Description:** Function coverage is 0%:
  - `src/web/session.ts`: 8.4% lines.
  - `src/web/writeLink.ts`: 6.9%. This is the router that decides archive vs. local writes (sharing-spec §5).
  - `src/web/sharing.ts`: 10.3%.
  - `Account.tsx`, `Onboarding.tsx`, `History.tsx`.

  The server side of these flows is well covered (`sync.ts` 96.7%, `sharedWrites.ts` 100%, `localCopy/*` ~98–100%).
- **Impact:** Some behaviour lives only in the browser and has no test:
  - Refresh-token rotation must have a single refresher per sharing-spec §5.
  - "dropped session" vs sign-out detection (`SIGNED_OUT` this tab did not start).
  - The choice of write destination for Shared vs Unshared Videos.

  A wrong destination or a double refresh shows up as lost edits or forced sign-outs.
- **Proposed tests (pure, with a fake supabase client, no DOM needed):**
  - `writeLink(video, op)` sends Shared+editor to the RPC then `POST /api/cache/apply`, sends Unshared to the companion route, and refuses Shared+Member.
  - The session state machine: `SIGNED_OUT` while the companion record is still held → `ended: "session-ended"`. `AuthSessionMissingError` from `getUser()` → `revoked`. A tab's own sign-out clears the record first.
  - Only one tab refreshes (mock `BroadcastChannel`).

### BLD-8 (Low, CONFIRMED): tests depend on running in order within a file

- **Evidence:** `bun test --randomize --seed=1|42|1337` gives 28, 28 and 30 failures, in Chapter endpoints, TV Server listener, Studio endpoints, suggest step, session, editing endpoints, search and others. Per file, `bun test --randomize --seed=7 test/tv.test.ts` gives 9 fail, studio 5, chapters 10, session 1. `--rerun-each 5` without randomizing is clean for studio, postersShare, session, syncPull, keyframes, thumbs, relocate, audio, prepare, tv-shell and localCopy. Ports are all `0` (ephemeral). No test needs outbound network: the full suite passes with `HTTPS_PROXY` pointed at a dead port.
- **Impact:** This is a deliberate story-style design (one app per file, state carried from test to test). It is fine, but it means you cannot use `test.only`, randomizing, or bisecting a single test without its predecessors.
- **Fix:** Document the convention at the top of those files, or reset state in `beforeEach` for the files where it is cheap (session, search).

### BLD-9 (Low, CONFIRMED): JSON `null` body → 500

- **Description:** `body = (await req.json()) as typeof body` accepts `null`. The next `typeof body.resumeS` / `body.loop` dereference is outside the `try`, so the request falls through to the catch-all 500 (`api.ts:925-926`). The shared `readJson` helper (`api.ts:382-389`) already handles this correctly.
- **Evidence:** a scratch script against `startApp` (`scratchpad/audit-07/nullbody.ts`):

  ```
  resume 500 {"error":"null is not an object (evaluating 'body.resumeS')"}
  loop 500 {"error":"null is not an object (evaluating 'body.loop')"}
  ```

- **Fix:** Use `readJson` there (handle the `sendBeacon` Blob in the same way), and add the two cases to the tests.

### BLD-10 (Low, CONFIRMED): `scripts/` and `tv/` are not type-checked

- **Description:** `tsconfig.json:17` includes only `src` and `test`. Running `tsc -p scratchpad/audit-07/tsconfig.extra.json`, which extends the repo config with `scripts/**` and `tv/**`, gives 68 errors:
  - **`scripts/fetch-youtube-info.ts:56`:** the sentinel `{ id: -1, ... }` is a `number` where `EligibilityRow.id` is now a UUID `string`. It is harmless at runtime (the id is never read), but it is real drift.
  - **`tv/home-prototype/{app,player,shared,variants}.ts`:** 11 errors, all number-vs-string Video ids from before the UUID migration. It also fails its own `tv/home-prototype/tsconfig.json`. It is still wired as `bun run tv-prototype` and in `.claude/launch.json`.
  - **`scripts/smoke-v1-build-2.ts` and `-3.ts`:** 56 errors. Most are only because neither file is a module (no import or export), so they share a global scope. Both are also stale in substance: they request `/play/1` with a numeric id, and `smoke-v1-build-2.ts` POSTs `favorite` with no `Origin` header (the companion now refuses writes without one; see `localRequestError` in session tests).
- **Fix:**
  - Add a `tsconfig.scripts.json` (or extend `include`) covering `scripts/**/*.ts` and run it in `bun run typecheck`.
  - Delete the smoke scripts or update them and add `export {}`.
  - Either fix the prototype or mark it archived and drop the npm script.

### BLD-11 (Low, CONFIRMED): `@types/bun: "latest"`

- **Description:** `bun install --frozen-lockfile` gives "no changes" (the lock is consistent) and pins `@types/bun@1.4.2`, but the runtime is 1.4.4. `bun outdated` reports `@types/bun (dev) 1.4.2 → 1.4.4`. Any `bun update` or lock regeneration jumps to whatever is newest, possibly a future major, which can change `tsc` results with no edit to `package.json`.

  The rest is fine:
  - `@supabase/supabase-js` is exactly pinned at 2.112.3 (2.119.0 is available).
  - `preact ^11.0.1` (11.1.1 available).
  - `typescript ^5.6.0` resolves to 5.9.3; the caret correctly keeps it off 7.x.
  - `bun audit`: "No vulnerabilities found (checked 15 packages)". Network was available.
- **Fix:** Pin `"@types/bun": "1.4.4"`, or `"~1.4.0"` to track the `engines` minor.

### BLD-12 (Low, CONFIRMED): download scripts

- **Description:** `scripts/download-{bandcamp,instagram,missing-youtube,rutube}.sh` and `download-instagram-then-bandcamp.sh`:
  - They use `#!/bin/zsh` and zsh-only `${0:A:h}`, so they fail on stock Linux without zsh, and shellcheck refuses them (SC1071). Run as bash they give no shellcheck warnings at `-S warning`.
  - `DEST` hard-codes `/Users/evanwilliams/Desktop/...` (lines 4-5 of each).
  - `yt-dlp ... 2>&1 | tee -a "$DEST/download.log"` without `setopt pipefail` means a missing yt-dlp or a failed run still prints "Done." and exits 0. `download-instagram-then-bandcamp.sh` then runs the next one anyway.
  - `download-instagram.sh:15` uses `--cookies-from-browser brave`, which reads the maintainer's browser cookies. That is fine locally, but surprising in a shared repo.
- **Fix:** Take `DEST` from `$1` or an env var and fail if it is unset. Add `set -o pipefail` (or `setopt pipefail`) and `command -v yt-dlp || exit 1`. Move these scripts under a `scripts/maintainer/` folder, or document them in the README's maintainer table.

### BLD-13 (Low, CONFIRMED): committed machine-specific and personal data

- **Description:**
  - **`tv/shell/tv.json`:** `{ "ip": "192.168.4.56", "target": "MRN85R85HAFXZA", "duid": "MTCNLIPDV7U3W", "mac": "192.168.4.83" }`. Home LAN addresses and the TV's device id. The `mac` field holds an IP, which looks like a mistake. `tv-install` excludes it from the package, but git still tracks it.
  - **`.claude/launch.json.prototypes.bak`:** absolute paths under `/private/tmp/claude-501/-Users-evanwilliams-Desktop-Misc--Projects-TuvaVideos/<session-uuid>/scratchpad/...`. They are useless on any other machine and expose the username and directory layout.
  - **`test/archive.test.ts:18`:** an absolute path to a private backup (the 1 skip).
  - **`scripts/*.txt`:** 1,419 public video URLs, including 62 Instagram post URLs. They are not secrets, but Instagram posts may identify private individuals. `doc-missing-urls.txt` is unreferenced (BLD-17).
- **Fix:**
  - Replace `tv.json` with a committed `tv.example.json`, git-ignore `tv.json`, and fix the `mac` field.
  - Delete `.claude/launch.json.prototypes.bak` and ignore `*.bak`.
  - Read the backup path from an env var (`TUVA_REAL_BACKUP`).

### BLD-14 (Low): setup hints inconsistent

- **Scoop vs winget (CONFIRMED):** README.md:14 says Windows uses `winget install Gyan.FFmpeg` and `winget install Google.Libwebp`, but `scripts/setup.ts:31-44` prints `scoop install ffmpeg` and `scoop install libwebp`, and scoop is not a stock Windows tool.
- **macOS version for `trash` (CONFIRMED inconsistency):** `setup.ts:42` and `platform.ts:22` say macOS 14 ships `/usr/bin/trash`, while `config.ts:35` says "macOS 15's `trash`". As far as I know `/usr/bin/trash` arrived in macOS 15 Sequoia (PLAUSIBLE), in which case the setup hint misleads macOS 14 users.
- **Linux is correct:** `bun scripts/setup.ts` here prints all-ok, finds `gio trash`, and creates `~/.local/share/TuvaVideos`.
- **Fix:** Pick one Windows package manager in both places. Fix the macOS version in setup.ts and platform.ts.

### BLD-15 (Low, CONFIRMED): `make-app.ts`

- **No platform guard, and the old app is deleted first:** there is no `process.platform === "darwin"` check. `rmSync(appDir, …)` (line 35) deletes the existing `~/Applications/TuvaVideos.app` before `iconutil` is known to work, so a failure leaves the user with no launcher at all.
- **Wrong PATH order:** the generated launcher sets `PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"` (line 83), which puts the Rosetta x86 tools first. `config.ts:44-46` explicitly prefers `/opt/homebrew/bin`. `findBin` checks `/opt/homebrew` first anyway, but anything resolved through `PATH` (`bun` itself, yt-dlp) gets the slow build.
- **Unsafe quoting:** the checkout path is embedded with `JSON.stringify` inside double quotes in bash (lines 86-87), so a path containing `$` or a backtick would be expanded.
- **Fix:**
  - Guard on darwin.
  - Build into a temp dir, then rename it over `appDir`.
  - Swap the PATH order.
  - Single-quote the path with `'` escaped.

### BLD-16 (Low, CONFIRMED): leaked temp dirs

- **Evidence:**
  - After my runs, `ls -d /tmp/tuva-*` grouped by prefix: `tuva-reloc` 32, `tuva-it` 12, `tuva-copies` 11, `tuva-poster` 11, `tuva-tv` 2.
  - `relocate.test.ts:14`, `writeSeam.test.ts:302` and `migrateShared.test.ts:200` call `mkdtempSync` and never `rmSync` (grep finds no `rmSync` in those files).
- **Fix:** Use `afterAll` or `try/finally` cleanup, or a shared `withTempDir` helper.

### BLD-17 (Low, CONFIRMED): `.gitignore` gaps and dead files

- **Description:** `.gitignore` has only `node_modules/`, `*.log`, `.DS_Store` and one prototype glob.
  - Running `python3 -m py_compile scripts/ovyur-playlist-report.py` left an untracked `scripts/__pycache__/` (I removed it).
  - `bun test --coverage --coverage-reporter=lcov` would write `coverage/`.
  - `*.bak` (see BLD-13) is not ignored.
  - `.env*` is not ignored. The spec says "No `.env`", but a defensive ignore costs nothing.
  - `scripts/doc-missing-urls.txt` (343 lines) is referenced nowhere (grep across the repo).
  - `scripts/ovyur-playlist-report.py` takes undocumented positional arguments, reads Cyrillic with `open()` and no `encoding=` (it breaks under a non-UTF-8 locale, for example on Windows), and is referenced nowhere.
- **Fix:**
  - Add `__pycache__/`, `coverage/`, `*.bak`, `.env*` and `tv/shell/tv.json` to `.gitignore`.
  - Delete `doc-missing-urls.txt`.
  - Add `encoding="utf-8"` and a usage line to the Python script.

---

## Proposed CI

A minimal `.github/workflows/ci.yml`. It is not committed, as the rules require.

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, macos-14]   # macos-14 = Apple Silicon, only /opt/homebrew: catches BLD-1
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.4.4 }   # match engines; bump deliberately
      - if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y ffmpeg webp
      - if: runner.os == 'macOS'
        run: brew install ffmpeg webp
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bunx tsc -p tsconfig.scripts.json      # after BLD-10
      - run: bun scripts/setup.ts                   # smoke: required tools found
      - run: bun test
      - run: bun audit
  shell:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get install -y zsh && for f in scripts/*.sh; do zsh -n "$f"; done
```

- **Order of work:** BLD-1 must be fixed first, or both jobs go red at once. BLD-4 should be fixed before the first green run, or the TV job will flake about once in every few dozen runs.
- **Optional extras:** a nightly `bun test --rerun-each 3` job, and a Windows job once Windows support is claimed as tested.
- **Archive tests:** none of the tests need the Supabase archive or the network (verified), so CI needs no secrets.

---

## Checked and found OK

- **Full suite stable:** 3 runs give 914/1/2 each (11.8 s, 12.3 s, 13.6 s), with the same 2 failures every time.
- **No network dependence:** with `HTTPS_PROXY`/`HTTP_PROXY` pointed at `127.0.0.1:9`, the result is 914/1/2. Tests mock PostgREST (`session.test.ts:132`, `port: 0`) and use `TUVA_PORT: "0"` / `TUVA_TV_PORT: "0"`. No fixed listening port appears in any test. The literal `4400`/`4411`/`4817` values are only strings in config or Origin assertions.
- **Clean under `--rerun-each 5`:** studio, postersShare, session, syncPull, keyframes, thumbs, relocate, audio, prepare, tv-shell, localCopy. The studio bridge `hang` check (`studio.test.ts:292-294`, `< 3000 ms`) and the `runPool` concurrency checks with `Bun.sleep(2–3)` (`postersShare.test.ts:81,108`) passed every time on 4 cores. They are wall-clock based, but with generous margins.
- **Type checks:** `bunx tsc --noEmit` passes. There is no `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck` anywhere in `src/`, `scripts/` or `tv/`.
  - The `any` uses in `src/` (32) are almost all `db.query(...).all() as any[]` in `search.ts`, where the SQL fixes the shape.
  - The `as never` in `migrateShared/snapshot.ts` follows the same pattern.
  - `range.ts:16`'s `as unknown as [string,string,string]` is safe after the regex match.
  - `parseRange` correctly handles suffix ranges, `bytes=0-0`, start ≥ size (416), end < start (ignored) and size 0.
- **Dependencies:** `bun install --frozen-lockfile` → "no changes", and `bun.lock` was unmodified (`git status` clean). `bun audit` → 0 vulnerabilities. supabase-js is used only in the browser bundle (`src/web/session.ts`, `sharing.ts`), as `docs/sharing-spec.md` says. `engines.bun >=1.4.0` agrees with `setup.ts` `MIN_BUN = "1.4.0"`.
- **`scripts/setup.ts` on Linux:** correct output, exit 0, data dir created. Its `planSetup` is pure and covered at 77.5%. `findBin` falls back to `Bun.which`, which handles `PATHEXT` on Windows.
- **Generated TV keys file:** `tv/shell/keys.js` is generated by `renderKeysJs` and checked by `test/tv-keys.test.ts`.
- **No secrets committed:** the committed archive key is the public `sb_publishable_` key, by design (sharing-spec).

## Not covered / blocked

- **macOS and Windows not run.** BLD-1's "passes on the maintainer's Mac" and BLD-14's macOS version are reasoned, not observed.
- **`scripts/make-app.ts`, `tv-install.ts`, `lg-install.ts`:** reviewed only; they need macOS, Tizen or webOS tooling. `grant-video-access.ts`, `seed-shared.ts` and `migrate-shared.ts` touch the real Supabase project and were not run, per the rules.
- **The Python report** was only byte-compiled (it needs scratch inputs that are not in the repo).
- **Flake rate** comes from roughly 85 runs of `tv.test.ts`. Other auditors were running tests at the same time on the same 4-core box, which may have raised it. I saw no port clashes.
- **Coverage:** Bun's line coverage does not report branches, so files shown at "100%" (`sharedWrites.ts`, `range.ts`, `sync.ts` at 96.7%) can still have untested branches.
- **No repo files changed** apart from this report.
- **Scratch artifacts** are in `/tmp/claude-0/-home-user-TuvaVideos/81dd5c87-daef-5003-ad39-65f9bcc41023/scratchpad/audit-07/`: full/random/coverage logs, `integration.patched.test.ts`, `tsconfig.extra.json`, `tsc-extra.log`, `nullbody.ts`.
