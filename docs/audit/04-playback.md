# Audit 04: Playback and the media pipeline (server side)

**Summary.** The Range server is correct for every case tested: suffix ranges, ranges past EOF, 416, multi-range, HEAD and Content-Length. It also releases file handles and the PCM ffmpeg when a client aborts. The weak spot is the Fallback pipeline's lifecycle:
- A Fallback or keyframe job that is in flight when a Copy's file changes writes a stale result over the fresh one.
- Ctrl-C closes the port at once but keeps the process alive while the job finishes. A relaunch in that window gives two FallbackQueues on one `remux/`, and a still-growing file is served as "ready".
- The TV is never served a Copy's own file when the browser judges that Copy as needing a Fallback. That breaks tv-spec §3.2.
- A play request waits behind a long scan-time transcode.

Live remux is not built (`/live/*` answers 404), so the "one at a time" rule cannot be tested yet.

Test setup: media made with ffmpeg in the scratch dir, covering h264/aac mp4, h264/ac3 mkv, hevc/opus mkv, vp9/vorbis webm, a 600 s 720p ac3 file and a 2 h ac3 file. The server ran on port 4504 (TV Server on 4594) with its own data dir, and was driven with curl and small Bun clients.

## Findings

| ID | Severity | Status | Location | Title |
|---|---|---|---|---|
| PLAY-1 | High | CONFIRMED | src/server/api.ts:342-351 | `/copy/:id` ignores the TV: a Copy the TV plays as-is gets a 503 (or the Fallback) and starts a browser Fallback job |
| PLAY-2 | Medium | CONFIRMED | src/server/app.ts:83-89, launch.ts:31-37, fallback.ts:206-214 | Shutdown closes the port and then waits for the Fallback job. A relaunch meanwhile makes two writers on one `N.tmp.ext`, and a partial file is recorded and served as ready |
| PLAY-3 | Medium | CONFIRMED | src/server/fallback.ts:186-206, keyframes.ts:131-147, scan.ts:307-313 | A Fallback or keyframe job in flight when the Copy's file changes writes a stale result after the scan cleared it |
| PLAY-4 | Medium | CONFIRMED | src/server/fallback.ts:140-163 | A play request does not preempt a running scan-time transcode: the Player shows "preparing" for the whole scan job |
| PLAY-5 | Medium | PLAUSIBLE | src/server/fallback.ts:188-206 | The Fallback ffmpeg has no timeout. A hung drive blocks the one queue for good, and shutdown waits on it |
| PLAY-6 | Low | CONFIRMED | src/server/launch.ts:31-34 | A second Ctrl-C during the shutdown wait is ignored: the user cannot quit without `kill -9` |
| PLAY-7 | Low | CONFIRMED | src/server/api.ts:351, fallback.ts:76-84 | A Fallback file removed from `remux/` while running is a 404 "file not found" until restart, not rebuilt |
| PLAY-8 | Low | CONFIRMED | src/server/playback.ts:59-63, scan.ts:231 | The browser Playback profile has no version: changing `NATIVE_AUDIO` or the rule never re-judges unchanged Copies |
| PLAY-9 | Low | CONFIRMED | src/server/relocate.ts:55, 105-107, fallback.ts:76-84 | `remux/` leaks: `dropCopy` leaves the Fallback file, and crash-left `*.tmp.*` files are never swept |
| PLAY-10 | Low | CONFIRMED | src/server/relocate.ts:105-107 | Relocate to another file clears the Fallback and TV judgement but not `keyframes` |
| PLAY-11 | Low | CONFIRMED | src/shared/prepare.ts:33-43 | `awaitCopy` polls forever when the Fallback state is `none` or `/api/copies/:id` keeps failing |
| PLAY-12 | Low | CONFIRMED | src/server/keyframes.ts:85, 138 | A Copy with a local Fallback but an unmounted Root gets no keyframe index |
| PLAY-13 | Low | CONFIRMED | src/server/stream.ts:14-41 | No ETag, Last-Modified or If-Range on `/copy/:id`: a replaced file under the same URL is spliced into a running play |

### PLAY-1: `/copy/:id` serves the browser's Fallback (or 503) to the TV even when the TV plays the Copy's own file

**Description.** `copyRoute` decides only from the browser's `copy.playback`. If that is not `native`, it serves the Fallback or answers 503 and calls `fallback.request(id, "play")`. The TV Server forwards `/copy/:id` to the same handler (tv.ts:217). That contradicts tv-spec §3.2: "the Copy's own file through `/copy/:id` when the TV profile plays it … The TV never asks the Fallback queue to make anything". The TV has no other URL for the own file, because `copyJson.url` is always `/copy/:id`.

**Failure scenario.** The user adds an h264/AC3 mkv and plays it on the TV before the scan-time transcode has run, for example while the queue is busy with a large file. TV profile: `directplay`/`directplay`, `order: "file"`. The TV `<video>` gets a JSON 503. Its `onError` retries once (tv/Player.tsx:555-578) and then shows "This Copy did not play". Meanwhile a play-priority browser job is queued, which also pauses Thumbnails (`playJobRunning`). Once the Fallback exists, the TV silently gets the AAC Fallback instead of the original AC3 track.

**Evidence.** In a fresh data dir, copy 6 (`mkv h264 ac3`) was requested through the TV Server:
```
GET http://127.0.0.1:4594/copy/6  ->  HTTP/1.1 503  {"state":"queued","progress":0}
/api/copies/6 -> "fallback":{"state":"queued"}  "tv":{..."order":"file"}
```

**Fix.** Let the TV route serve the source. One way: add a route such as `/copy/:id/file` (allowlisted in tvRoutes) and have `copyJson.tv` carry a `url` that follows `tvOrder` (`file` gives the own file, `fallback` gives the Fallback). Another way: have `copyRoute` take a "player" argument that the TV Server sets, and never call `fallback.request` for it.

### PLAY-2: The shutdown window lets a second instance run beside the first; the partial Fallback is recorded as ready

**Description.**
- `stop()` calls `server.stop()` first, so the port is closed at once.
- It then awaits `fallback.shutdown()`, which waits for the in-flight ffmpeg job to finish (minutes for a full-length film).
- `launch()` tests "already running" by probing `/api/health`. That probe now fails, so `bun run start` starts a second process on the same data dir.
- The new process's FallbackQueue picks the same Copy and calls `rm(tmpOut)` on the same `N.tmp.ext`, so the old ffmpeg keeps writing to an unlinked inode. Its own ffmpeg then writes a new file at that name.
- When the old process's job finishes, it `stat`s and renames the *new process's half-written file* to `N.ext`, and records `fallback_file`.
- The new process's ffmpeg keeps writing into the renamed inode. Its job then fails with ENOENT on `stat(tmp)`.

From the moment of that rename until the new ffmpeg finishes, the Fallback is "ready" while still growing and lacks its Cues/duration. If the second process is stopped in that window, a truncated file stays recorded as complete for good.

**Evidence.** SIGINT went to PID 18948 during the 2 h transcode of copy 3. Health returned 000 within 1 s. A second instance was started on the same port and data dir:
```
ps: two ffmpeg writing .../data2/remux/3.tmp.mkv (pids 19040, 25925)
old log 23:01:51 "fallback transcode done: copy 3 -> 3.mkv in 78.2s"  -> 3.mkv = 77,856,768 bytes (final is 118,269,199)
GET /copy/3 at that point -> 206, Content-Range: bytes 0-0/93585408   (growing)
new log 23:02:19 "fallback job for copy 3 failed: ENOENT ... stat '.../remux/3.tmp.mkv'"
```

**Fix.**
- Use a per-process unique temp name, e.g. `${id}.${pid}.${random}.tmp.ext`.
- After `rename`, re-check that the row still wants this result (see PLAY-3).
- Keep the listener answering `/api/health` with a "stopping" body during shutdown, or take a lock file in the data dir, so a relaunch waits or refuses.
- Better still, kill the in-flight job on shutdown, since the Fallback is rebuildable. That also fixes PLAY-6.

### PLAY-3: A stale Fallback or keyframe index is written after a rescan cleared it

**Description.** When the scan sees a changed file (scan.ts:307-313), it unlinks the Fallback and sets `fallback_file = NULL, keyframes = NULL`. A job already running for that Copy has captured `src` and the old duration. On completion it renames its output and runs `UPDATE copy SET fallback_file = ?` with no check that the Copy is unchanged. `KeyframeIndex.index` has the same pattern (`UPDATE copy SET keyframes = ?`). The scan's `enqueueScanJobs` does not re-queue: `request()` sees the running job and returns.

**Failure scenario.** A yt-dlp re-download or a re-encode replaces a file (atomic `mv`) while its transcode runs. The browser then plays the old content under the new Copy's facts, and the seek bar and keyframes don't match.

**Evidence.** Copy 3 was a 7200 s file mid-transcode. It was replaced via `mv` with a 60 s file and a rescan ran. After the job finished:
```
/api/copies/3 -> "durationS":60, "fallback":{"state":"ready"}
ffprobe remux/3.mkv -> 7200.032
```

**Fix.** Capture `size`/`mtime` (or a generation counter) at job start. Make the final step a conditional update: `UPDATE copy SET fallback_file=? WHERE id=? AND size=? AND mtime=?`. When it matches 0 rows, delete the output. Do the same for keyframes. Also, have the scan kill or abandon a running job for a Copy it rewrites (expose `fallback.cancel(copyId)`).

### PLAY-4: A play request waits for the whole running scan job

**Description.** `pump()` runs one job to completion. A "play" request only reorders the *queued* jobs (`next()`). The spec says "play requests go to the front", but a running scan transcode is never paused or preempted.

**Evidence.** The scan started the 2 h transcode of copy 3. `GET /copy/5` (60 s ac3) then answered `{"state":"queued"}` for over 70 s, until copy 3 finished (logs at 22:55:03, 22:56). On real libraries this takes about 19× realtime: around 6 min for a 2 h film.

**Fix.** When a play job arrives and `current.priority === "scan"`, kill the scan ffmpeg, re-queue it as scan, and start the play job. A transcode restarts cheaply.

### PLAY-5: The Fallback ffmpeg has no timeout

**Description.** `runJob` spawns ffmpeg with no timer. `proc.ts` `run()` has a 300 s default, and keyframes uses 600 s, but the Fallback job has neither. The docs record that external exFAT drives hang or EIO. A read that blocks in the kernel leaves the single queue stuck forever. No "play" job can then run, and `shutdown()` waits on `drained` with no limit.

**Evidence.** Code trace, fallback.ts:188-206. There is no kill path other than process exit, and `job.proc` is stored but never used.

**Fix.** Add a watchdog: kill the job when no `-progress` output arrives for N seconds (for example 60 s). Kill `job.proc` in `shutdown()`.

### PLAY-6: A second Ctrl-C does nothing

The `shutdown` handler returns at once when `stopping` is set (launch.ts:32-33). With PLAY-2's wait, Ctrl-C twice still leaves the process running for minutes.

**Evidence.** SIGINT was sent twice, 1 s apart. The process stayed alive until the job finished at 23:01:51, 67 s later.

**Fix.** On a second signal, kill the ffmpeg children and call `process.exit(1)`.

### PLAY-7: A deleted Fallback file is a hard 404 until restart

`verifyFiles()` runs only at startup. `copyRoute` serves `join(remuxDir, fallback_file)` without checking it exists. A missing file makes `serveFile` answer 404 "file not found". The Player treats that as a lost Copy (Player.tsx `onMediaError`, then `lose`) instead of "preparing".

**Evidence.** After `mv remux/3.mkv` elsewhere: `GET /copy/3` gave 404 `{"error":"file not found"}`, while `/api/copies/3` still said `"fallback":{"state":"ready"}`.

**Fix.** On ENOENT for a Fallback, clear `fallback_file`, call `fallback.request(id, "play")` and answer 503 with the preparing state.

### PLAY-8: The browser profile is never re-judged

CONTEXT.md says each Copy is "judged again when the profile changes". `copy.playback` comes from `decidePlayback`, which runs only when the scan re-probes a file, and it re-probes only when size or mtime changed (scan.ts:231). Unlike `TV_PROFILE.version` with `judgeStaleCopies`, there is no version or startup re-judge. Adding `"ac3"` to `NATIVE_AUDIO` (or removing a codec) leaves every existing Copy on its old verdict. Fallbacks for Copies that no longer need one are kept, and Copies that now need one are served raw.

**Fix.** Store a `browser_profile_version` and re-run `decidePlayback` from the stored facts at startup, the same way `judgeStaleCopies` does for the TV.

### PLAY-9: `remux/` grows without bound in two ways

1. `relocate.ts` `dropCopy` (line 55) deletes a copy row without unlinking its `fallback_file`, unlike `deleteVideo.ts:55,124` and `scan.ts:308`.
2. A crash or `kill -9` during a job leaves `N.tmp.ext`. Only a later job for the *same* Copy removes it (`rm(tmpOut)`, fallback.ts:187).

`verifyFiles` only clears rows whose file is gone and never removes files that no row references. There is also no size cap or eviction for Fallbacks of Missing Copies, which may be acceptable by design.

**Fix.** At startup, delete every file in `remux/` that no `copy.fallback_file` names, including all `*.tmp.*`. Unlink in `dropCopy`.

### PLAY-10: Relocate keeps the old keyframe index

relocate.ts:105-107 resets `fallback_file`, `tv_playback` and `content_hash` for a Copy pointed at a new file, which may be a different encode, but not `keyframes`. scan.ts:312 does reset it. Keyframe seeks on the relocated Copy then snap to the old file's GOPs.

**Fix.** Add `keyframes = NULL` to that UPDATE.

### PLAY-11: `awaitCopy` can poll forever

The loop exits only on `ready` or `failed`. `readPrepare` maps `none` (and a missing body) to `wait`, and a non-OK `/api/copies/:id` (404 after a delete) is skipped with `continue`. Ways to reach `none`:
- The Copy was rescanned as `native` while queued: `runJob` returns early (fallback.ts:176) and `status()` then says `none`.
- `request()` was refused while `stopping` (fallback.ts:115).

The Player then shows "preparing" until the user navigates away.

**Fix.** Treat `none`, and a 404 or repeated failures, as terminal, or re-request `/copy/:id` once. Add an overall deadline.

### PLAY-12: No keyframe index while the Root is unmounted, even with a local Fallback

`KeyframeIndex.file()` prefers the Fallback path. `status()` and `index()`, however, return `none`/false when the Copy is missing or the Root is unavailable, although the Fallback in `remux/` is local and does play (`copyRoute` serves it regardless of the Root). Seeks are then exact (slow) for no reason.

**Fix.** Skip the availability check when `fallback_file` is set.

### PLAY-13: No validators on `/copy/:id`

`serveFile` sends no ETag or Last-Modified and ignores `If-Range`. Copy ids are also reused (`INTEGER PRIMARY KEY` without AUTOINCREMENT, migrations/0015:253). If a Copy's file or Fallback is replaced during a play (PLAY-3, a rescan, or a Fallback created mid-session), the media element's next Range request gets bytes of a different file under the same URL. That shows as a decode error rather than a clean reload.

**Fix.** Send `ETag` built from size, mtime and inode, plus `Last-Modified`, and honour `If-Range`: on a mismatch, send 200 with the full body.

## Checked and found OK

- **Range parsing and serving (live):**
  - `bytes=0-0`, `-100`, `-999999999` (clamped to the whole file), `305069-` and `0-9999999999` (clamped) all give a 206 with a correct Content-Range and Content-Length.
  - `-0` and `start>=size` give 416 with `bytes */size`.
  - Reversed, multi-range, other units and `1e3-` give 200 with the full body, which RFC 9110 allows.
  - HEAD returns the same headers and no body.
  - The bytes of the 206 body matched the file (`cmp`).
- **Abort mid-stream:** 30 parallel rate-limited downloads of a 22 MB Copy were cut after 1 s. The fd count went 19 → 79 → 19, with no handle left on the file.
- **`/copy/:id/pcm`:** 5 aborted streams left 0 ffmpeg children afterwards (`req.signal` abort kills it).
- **Shutdown:** after a clean stop, no ffmpeg or ffprobe from this server was left running.
- **Fallback atomicity in one process:** output goes to a temp name, a 0-byte result is refused, and `rename` publishes it. One job per Copy (`jobs` Map). A failed job is re-queued on the next request.
- **Preferred Copy ranking** (`ranking.ts`) matches CONTEXT.md: local, then native, then pixels, then smaller size, stable. Only Available Copies are taken (`api.ts:182`). The TV re-ranks by its own profile (`tv/copies.ts`).
- **TV profile judging:** it runs at startup and at the end of each scan, and when `version` changes. Changed rows are cleared by scan and relocate. The Fallback's TV decision is computed live.
- **Resume:** the 30 s rule is applied the same way on the client (`startPosition`) and the server (`recordResume`, using the playing Copy's duration). An unknown duration never counts as finished, and `?t=` is clamped. A clip under 30 s always reopens at 0, which follows the rule as written.
- **`idleTimeout: 120`:** a reader paused for 135 s had its connection reset (ECONNRESET after 5.3 MB). Media elements re-issue a Range request on resume, so this is acceptable for the browser. It is worth a check on Tizen, where `onError` retries only once.
- Seek throttle, keyframe parse/encode/decode, strip geometry, screenshot names (sanitised, no traversal, 64 MB cap, PNG check), audio settings validation, and the Studio bridge (timeouts kill the stuck child, ids per command, `failAll` on exit) were all reviewed, and no defects were found.

## Not covered / blocked

- **Live remux:** not implemented. `/live/*` answers 404 "not built yet" (tv.ts:215), so the "one at a time" rule, its ffmpeg kill on stop and the second-client behaviour cannot be tested.
- **Studio (Music.app):** these are macOS-only and `osascript` is absent here. The bridge and service were reviewed from code only.
- **`remux` playback (missing duration / no Cues, `.f251` pairing):** ffprobe estimated a duration even for a piped webm, so this path was not reached live. It was reviewed in code (`fallbackPlan` and `findAudioSibling`).
- **Real drives:** EIO and hang behaviour on external drives (PLAY-5) could not be simulated.
- **TV hardware:** the TV playback behaviour was not tested on real hardware.
