# TuvaVideos downloader specification

Assembled 2026-11-08 in [issue #194](https://github.com/IncoherentThoughts/TuvaVideos/issues/194) from every closed ticket on [map #186](https://github.com/IncoherentThoughts/TuvaVideos/issues/186). Normative for the build tickets in §11. Vocabulary: `CONTEXT.md`, the **Downloading** section (Download, Download queue, Download job, Reference size, Failure report) and the Sharing terms it leans on (Shared, Standalone, Member, Video Editor, Root, Copy, Not on this machine). The sharing spec (`docs/sharing-spec.md`) is the baseline: everything not said here is as the app does it today. This spec replaces its §11 line "The in-app yt-dlp downloader".

Where a ticket's resolution and this document disagree, this document wins. Sources folded in: [#187](https://github.com/IncoherentThoughts/TuvaVideos/issues/187) yt-dlp install, self-update and JS runtime ([research/yt-dlp-install.md](research/yt-dlp-install.md)), [#188](https://github.com/IncoherentThoughts/TuvaVideos/issues/188) progress, errors and resumability ([research/yt-dlp-progress-errors.md](research/yt-dlp-progress-errors.md)), [#189](https://github.com/IncoherentThoughts/TuvaVideos/issues/189) Instagram login and cookies ([research/instagram-auth.md](research/instagram-auth.md)), [#190](https://github.com/IncoherentThoughts/TuvaVideos/issues/190) Shared size and duration columns, [#191](https://github.com/IncoherentThoughts/TuvaVideos/issues/191) Instagram sign-in approach, [#192](https://github.com/IncoherentThoughts/TuvaVideos/issues/192) Download queue lifecycle, [#193](https://github.com/IncoherentThoughts/TuvaVideos/issues/193) the dialog and card prototype (variant B, branch `prototype/downloader-dialog-193`, `src/web/prototype/`). The three research notes were merged to `docs/research/` with this spec.

---

## 1. Product, people and constraints

A Member's library lists every Shared Video, most of them Not on this machine. The Downloader fetches those files from their sources (YouTube, Instagram, Rutube) with yt-dlp, names them so a scan makes them Copies, and puts them in the Root. Two entry points feed one Download queue: the **download dialog** from the avatar menu (many Videos at once) and the **download button** on a Not-on-this-machine card (one Video, to the front).

### Who

Anyone whose library shows Videos Not on this machine: Members, and Standalone users with a leftover Local copy. No new grant, no new role. A Video Editor uses it the same way.

### Standing constraints

- **Only Videos with a source id.** A Video is downloadable when it has `youtube_id`, `instagram_id` or `rutube_id`. Hash-only Videos are left out of every option, count and estimate, and get no card button.
- **The server runs the queue.** The Bun companion owns the Download queue and the yt-dlp processes; it is persisted in `library.db`. Closing the tab or the dialog loses nothing. A quit or crash is offered for resuming at the next launch; partial files continue.
- **One queue, two parallel downloads.** Instagram runs one at a time inside those two slots (§5.4).
- **Nothing about the user goes to the archive.** Downloads are local. The only Shared write is the Reference size (§3), filled by a Video Editor's machine.
- **The app's own binaries.** yt-dlp and deno are installed by the app into the data dir; Bun is never used as yt-dlp's JS runtime (§2).
- **Polling, not push.** Live progress is read by polling, like the rest of the app (§6).
- **Cookies only go to yt-dlp.** Instagram cookies are never logged, never sent to the browser, never shared (§5).

---

## 2. yt-dlp and deno

### 2.1 Where they live

`<dataDir>/bin/` (`dataDirFor` in `src/server/config.ts`): `yt-dlp` (`yt-dlp.exe` on Windows) and `deno` (`deno.exe`). The directory must be writable by the app, since `yt-dlp -U` writes `.new`/`.old` beside the binary.

Lookup order for yt-dlp: `TUVA_BIN_DIR`, then `<dataDir>/bin`, then `/opt/homebrew/bin`, `/usr/local/bin`, `PATH` (a new `findDownloaderBin` beside `findBin`, so a user's own `TUVA_BIN_DIR` still wins). The app only ever runs `-U` on the binary it installed itself; a Homebrew or pip yt-dlp is used as found and never updated.

### 2.2 Install

On first use of the Downloader (the dialog opening, or a card's button), if no yt-dlp is found, the server installs it; the dialog shows "Installing yt-dlp… (37 MB)" with progress and the card button waits.

| Platform | yt-dlp asset | deno asset |
|---|---|---|
| macOS arm64 / x64 | `yt-dlp_macos` (universal) | `deno-aarch64-apple-darwin.zip` / `deno-x86_64-apple-darwin.zip` |
| Linux x64 / arm64 (glibc) | `yt-dlp_linux` / `yt-dlp_linux_aarch64` | `deno-x86_64-unknown-linux-gnu.zip` / `deno-aarch64-unknown-linux-gnu.zip` |
| Windows x64 / arm64 | `yt-dlp.exe` / `yt-dlp_arm64.exe` | `deno-x86_64-pc-windows-msvc.zip` / `deno-aarch64-pc-windows-msvc.zip` |

musl Linux is out of scope for now (§12).

- **yt-dlp:** fetch `https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS`, take the line for the asset, download the asset from the same `latest/download/` path, compare SHA-256, `chmod 755`, write to `<bin>/yt-dlp.tmp` and rename into place. A mismatch deletes the download and reports "yt-dlp download failed its checksum"; nothing is installed. Channel: **stable** (the README recommends nightly; stable is chosen for fewer surprises, and `-U` keeps it current).
- **deno:** the latest `denoland/deno` release (v2.9.8 at writing) from `https://github.com/denoland/deno/releases/latest/download/<asset>`, verified against `<asset>.sha256sum` from the same release, unzipped (the zip holds one `deno` executable), `chmod 755`, renamed into place. A deno 2.3+ or Node 22+ already on `PATH` is used instead and nothing is installed (deno on `PATH` needs no flag; Node needs `--js-runtimes node`). With an installed deno, every yt-dlp call passes `--js-runtimes deno:<bin>/deno`.
- **curl-cffi** (Instagram's signed-out path needs impersonation): bundled in every asset above. The README excludes only the zipimport `yt-dlp` and `yt-dlp_x86`. A found, non-app yt-dlp is checked once with `yt-dlp --list-impersonate-targets`; with none available, Instagram Videos are still tried, but their failures carry the note "this yt-dlp has no impersonation (curl-cffi)".
- **macOS Gatekeeper:** a file written by `fetch` carries no quarantine attribute, so no prompt is expected. Untested; verified in the verification ticket on a clean Mac (§10).

### 2.3 Self-update

`yt-dlp -U` on the app-installed binary, at most once per 24 h, recorded as `ytdlp_checked_at` in the `download_setting` table (§4.1). It runs before a job starts when no download is running and the last check is over 24 h old, and never while a yt-dlp process is alive. Failure (exit 100, or no network) keeps the old binary and is logged; the job starts anyway. deno is updated the same way by re-running the install when its release is newer, at most weekly. A failed extraction does not trigger an extra update.

### 2.4 ffmpeg

`--ffmpeg-location dirname(config.ffmpeg)` when `ffprobe` sits in the same directory (the Homebrew case); otherwise `--ffmpeg-location config.ffmpeg` and `dirname(config.ffprobe)` prepended to the child's `PATH`. yt-dlp therefore uses the same ffmpeg as the rest of the app.

### 2.5 Tool status

`GET /api/downloads/tools` returns `{ ytdlp: { path, version, source: "app"|"found"|"missing", checkedAt }, jsRuntime: { kind: "deno"|"node"|"none", path, version }, impersonation: boolean }`. With no JS runtime and no way to install one (offline), the dialog shows "YouTube needs deno; it will be installed when you are online" and YouTube Videos are held as waiting (§4.2), not failed.

---

## 3. Reference size

A Shared estimate of what a Download will weigh, taken from one Video Editor's Copy (#190).

### 3.1 Archive columns

On the Shared `public.videos` table (Lyrics Website repo, migration 144 by that repo's rules): `size_bytes bigint`, `duration_s real`, `height integer`, all nullable, with `check (size_bytes > 0)`, `check (duration_s > 0)`, `check (height > 0)`. `write_videos` accepts the three fields on insert and update with the same validation. pgTAP covers the new fields, and the RLS snapshot (`supabase/tests/live-rls-snapshot.json`) is regenerated. `shared_changes_since` carries them like any column. The live apply is HITL.

### 3.2 Local copy

Local migration `0022_reference_size.sql`: the same three columns on the Local copy's `videos` table (migration 0015) and in its `*_all` view (0021). `applyShared` and `src/shared/archiveWire.ts` (`VideoRow`) carry them. Standalone rows never set them.

### 3.3 Fill

- **Which Copy:** among this machine's non-Missing Copies of the Video, the one with the greatest `height` ≤ 1080; if none is ≤ 1080, the largest by `size`. Copy columns `size`, `duration_s`, `height` already exist.
- **When:** fill-empty, like `poster_path` (sharing spec §6.5). Only a Video Editor's machine writes, and only when all three Shared fields are null. `GET /api/reference-size/candidates` lists Shared Videos with null Reference size and a qualifying Copy here; the browser writes each through `write_videos` update (`p_payload: { size_bytes, duration_s, height }`), as `runPosterUpload` does in `src/web/sharing.ts`, and applies the result to the cache. It runs at the same trigger as the poster upload (after a scan and after Sync). Never overwritten, so existing Shared Videos backfill on the owner's next scan; no script.
- **Edit history:** one edit per Video, field `reference_size`, like the poster's.

### 3.4 Estimates

Per Video, for the chosen quality:

| Quality | Size |
|---|---|
| 720p | `size_bytes` × 0.5 |
| 1080p (default) | `size_bytes` × 1.0 |
| Best | `size_bytes` × 1.6 |

The ratios are keyed on a Reference height of 1080. For a stored `height` below the target, the size is not scaled up (a 480p Reference at 1080p stays ×1.0, since the source likely has nothing better). For a stored height above 1080 (the "largest" fallback), 1080p is ×(1080/height)² and 720p ×(720/height)².

- **No Reference size, but a duration:** `duration_s` × 2.5 Mbit/s (≈ 1080p H.264) × the ratio. The duration comes from the Shared `duration_s`.
- **Neither:** the Video is counted but carries no size; totals say "+ N without an estimate".
- **Displayed with "≈"** everywhere before a job runs. Once a Video is sized by yt-dlp (§4.3), its exact size replaces the estimate.
- **Time** = total size ÷ throughput. Throughput is 2 MB/s, labelled "assumed", until a job has finished at least one Video; after that, the most recent job's average throughput (bytes downloaded ÷ downloading seconds), stored as `last_throughput_bps` in `download_setting`.
- **Disk:** free space of the destination's volume (`statfs`), shown in the footer. Confirm is disabled when the total estimate × 1.1 exceeds it.

---

## 4. The Download queue

### 4.1 Tables in `library.db`

Local migrations `0023_download_setting.sql` (the `download_setting` table, ticket 1) and `0024_download_queue.sql` (the rest, ticket 5):

```sql
CREATE TABLE download_job (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('bulk', 'card')),
  option TEXT,                 -- 'full' | 'random' | 'type' | 'artist' | 'favorites'; NULL for a card
  quality TEXT NOT NULL CHECK (quality IN ('720', '1080', 'best')),
  dest_dir TEXT NOT NULL,      -- absolute path
  dest_root_id INTEGER REFERENCES root(id),  -- NULL when the folder is outside every Root
  created_at TEXT NOT NULL,
  finished_at TEXT,
  cancelled_at TEXT
);
CREATE TABLE download_item (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES download_job(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('youtube', 'instagram', 'rutube')),
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,         -- snapshot for the Failure report
  queue_pos REAL NOT NULL,     -- lower runs first; a card click takes min - 1
  state TEXT NOT NULL,         -- §4.2
  reason TEXT,                 -- failure class, §4.4
  error_line TEXT,             -- last ERROR: line verbatim
  est_bytes INTEGER, exact_bytes INTEGER, done_bytes INTEGER,
  speed_bps REAL, eta_s REAL,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,             -- backoff deadline
  file_path TEXT,              -- final file, once known
  log_path TEXT NOT NULL,      -- per-item yt-dlp output
  started_at TEXT, finished_at TEXT,
  UNIQUE (job_id, video_id)
);
CREATE INDEX download_item_runnable ON download_item(state, queue_pos);
CREATE TABLE download_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Keys in `download_setting`: `ytdlp_checked_at`, `deno_checked_at`, `last_throughput_bps`, `queue_paused` (`1` when the user paused), `instagram_auth` (JSON, §5.2), `instagram_notice_ack_at`. The per-item log lives at `<dataDir>/downloads/<job_id>/<item_id>.log`; a job's directory is deleted with the job.

A Video is in at most one live item at a time across jobs: adding a Video that is already queued or running in another job moves that item instead of inserting a second.

### 4.2 Item states

`queued` → `sizing` → `downloading` → `merging` → `scanning` → `done`.

Other states: `waiting` (offline, rate-limited site, missing JS runtime; returns to `queued` by itself), `failed` (with `reason`), `cancelled`, `skipped` (a Copy appeared by other means while queued: checked when the item is picked), `done_outside` (finished into a folder outside every Root; no scan).

- **sizing:** `yt-dlp --simulate -J -f <selector> <url>` (§4.3); `exact_bytes` = Σ `requested_formats[].filesize` (else `filesize_approx`, else null for HLS/DASH). Not a separate process per pass when the queue is long: the item is sized when picked, just before it downloads. A sizing failure is a download failure, classified the same way.
- **downloading:** progress lines (§4.3). Two streams (`bv+ba`) report separately; the item's `done_bytes` is the finished streams' sizes plus the current stream's `downloaded_bytes`, against `exact_bytes`.
- **merging:** the `postprocess` template's `started` status.
- **scanning:** after yt-dlp exits 0, the final path from `--print after_move:filepath` is scanned (§4.6).

A **job** is running while any item is in `queued`, `sizing`, `downloading`, `merging`, `scanning` or `waiting`; finished otherwise. `finished_at` is set then.

### 4.3 Running yt-dlp

One process per item, spawned through `src/server/proc.ts`, cwd the destination:

```
yt-dlp --newline --no-colors --no-update --no-playlist
  --continue --part --no-overwrites --no-mtime
  --retries 10 --fragment-retries 10 --retry-sleep exp=1:30
  --ffmpeg-location <§2.4> [--js-runtimes deno:<path>]
  -f <selector> [--merge-output-format <mp4|mkv>]
  -o <template>
  --progress
  --progress-template "download:TUVA %(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s"
  --progress-template "postprocess:TUVAPP %(progress.status)s"
  --print after_move:"TUVAFILE %(filepath)s" --no-simulate
  [--cookies <file> | --cookies-from-browser <browser>]   # Instagram retry only, §5
  <source_url>
```

- **Selectors:**

| Quality | `-f` |
|---|---|
| 720p | `bv*[height<=720][vcodec~='^(avc1\|vp0?9)']+ba[acodec~='^(mp4a\|opus)']/b[height<=720]` |
| 1080p | `bv*[height<=1080][vcodec~='^(avc1\|vp0?9)']+ba[acodec~='^(mp4a\|opus)']/b[height<=1080]` |
| Best | `bv*+ba/b` |

  `--merge-output-format mp4` when the chosen video codec is `avc1`, `mkv` otherwise (VP9 + Opus, and Best's AV1). The sizing pass's `requested_formats` tells which.
- **Output templates** (the existing provenance names, `src/server/filename.ts`): YouTube `%(title).150B [%(id)s].%(ext)s`; Instagram `%(title).150B [instagram-%(id)s].%(ext)s`; Rutube `%(title).150B [rutube-%(id)s].%(ext)s`. `--restrict-filenames` is not used (titles are Tuvan Cyrillic); `--windows-filenames` is added on Windows. A unit test asserts that `parseFilename` reads each template's output back to the item's source id.
- **Parsing:** lines starting `TUVA ` update the item (`NA` = null); `TUVAPP started` → `merging`; `TUVAFILE ` sets `file_path`. Every stdout and stderr line is appended to the item's log. *Verified on a real `bv+ba` download (yt-dlp 2026.10.21, `jNQXAC9IVRw`, #200):* `--print` implies `--quiet`, which silenced the progress templates entirely until `--progress` was added (and `--no-simulate` keeps the run a download). `TUVA` and `TUVAFILE` arrive on stdout but `TUVAPP` arrives on **stderr**, so the parser reads both streams, and the two pipes' relative order is not guaranteed (a `TUVAPP` can trail `TUVAFILE`). Each stream ends with one `finished` line (`eta` `NA`); every post-processor reports its own `started`/`finished` pair (two pairs in the merge), so `merging` is entered once. `total_bytes_estimate` was `NA` and `total_bytes` known for both streams, whose sum equalled the sizing pass's `exact_bytes` (545262). yt-dlp's own `[download]` chatter is not printed under `--quiet`, so the log holds only these lines and `ERROR:`/`WARNING:` text. The server writes progress to the row at most once a second.
- **Exit:** 0 with `file_path` → scanning. Non-zero → classified from the last `ERROR:` line (§4.4).
- **Kill:** cancel and pause send SIGTERM, then SIGKILL after 5 s. `.part` / `.part.ytdl` / `.fNNN` files stay for `--continue` unless the item is cancelled.
- **Partial files and scans:** `PARTIAL_SEGMENT` in `filename.ts` already ignores yt-dlp's partials, so a Rescan during a download imports nothing half-done.

### 4.4 Failure classes

From the last `ERROR:` line, by regex in `src/server/downloads/classify.ts`, tested on the messages in the research notes and `docs/research/failed-youtube-downloads.md`:

| Class (`reason`) | Match (case-insensitive) | Action |
|---|---|---|
| `unavailable` | `Video unavailable`, `This video is unavailable`, `has been removed`, `There is no video in this post` | failed, permanent |
| `private` | `Private video` | failed, permanent |
| `geo` | `geo restrict`, `not available from your location`, `in your country` | failed, permanent |
| `login_wall` | Instagram: `redirected to the login page`, `Restricted Video`, `empty media response` | Instagram path §5.4; reason shown as "login wall or removed post" |
| `private_follow` | `only available for registered users who follow` | failed, "private: follow required" |
| `cookies_expired` | the warning `account cookies are no longer valid` (any line) | failed, "cookies expired"; flips the auth row (§5.2) |
| `needs_signin` | (set by the queue, §5.4) | not tried |
| `youtube_signin` | `Sign in to confirm`, `Please sign in` (YouTube bot check) | rate-limit path (treated like 429) |
| `rate_limited` | `HTTP Error 429`, `rate-limited`, `Too Many Requests` | §4.5 |
| `disk_full` | `No space left on device`, `Errno 28` | stops the job, §4.5 |
| `network` | `Unable to download`, `timed out`, `Connection`, `Temporary failure in name resolution`, `Got error` after retries, `HTTP Error 5\d\d` | §4.5 |
| `no_js_runtime` | `JavaScript runtime`, `n challenge`, `Signature extraction failed` | waiting until a runtime exists, then once more; failed after |
| `unknown` | anything else | failed, retryable by Retry failed |

The `error_line` is kept verbatim; the Failure report shows the class's words and, under the card's pop-up, the log tail.

### 4.5 Scheduling, offline and rate limits

- **Picking:** the runner fills two slots with the lowest `queue_pos` items in `queued` whose `not_before` has passed, whose site is not paused, and, for Instagram, only when no other Instagram item is running and the Instagram pause (§5.4) has elapsed.
- **Network:** a `network` failure (after yt-dlp's own retries) puts the item back to `queued` (not failed, `attempts` unchanged) and pauses the whole queue as **offline**. The runner probes connectivity (`HEAD https://www.youtube.com/generate_204`, 5 s timeout) every 15 s, doubling to 2 min, and resumes on the first success. Dialog: "Waiting for connection…". Interrupted items resume from their `.part`.
- **429 / YouTube sign-in check:** the item returns to `queued` and only that **site** pauses: 1 min, then 5, then 10. The third consecutive rate limit on one item fails it as `rate_limited`. Other sites keep downloading. A success on the site resets its backoff.
- **Disk:** before Confirm, the estimate check of §3.4. At run time, `disk_full` fails the item, pauses the queue and shows "Disk full: free space on <volume> and press Resume".
- **Pause:** `queue_paused = 1`; running processes are killed (partials kept) and their items go back to `queued`. Resume clears it.
- **Cancel job:** running items killed; their and every queued item's partials deleted (the files matching the item's id under the destination); those items → `cancelled`; the job gets `cancelled_at`.
- **Cancel one Video:** the same for one item (a log-list row's ×, the card's ×).
- **Retry failed:** every `failed` item of the job → `queued`, `attempts` reset, `reason` cleared, permanent reasons included (a removed video can come back; the user asked). The report updates as they run.
- **Throughput:** at job finish, `last_throughput_bps` = Σ bytes ÷ Σ downloading seconds over the job's done items, if any finished.

### 4.6 File to Copy

When yt-dlp exits 0, the runner calls a new `Scanner.scanFile(rootId, relPath)`: a single-file entry around `processEntry` (`src/server/scan.ts`), followed by the same finishing steps scoped to the one Video (`judgeStaleCopies`, `judgeBrowserCopies`, `matchNewVideos` for a new Video, a search index update). It takes the scan lock like a Rescan; if a Rescan is running, it waits for it. The result: the Video has a Copy, `presence` turns it playable, and the card swaps on its next poll. A failed probe fails the item as `unknown` with the probe error. A destination outside every Root skips the scan and ends `done_outside`.

### 4.7 Resume after quit or crash

At startup the runner starts nothing. If any job has items in a live state, those items are reset to `queued` and `GET /api/downloads` reports `resumePrompt: { jobId, left, estBytes }`. The first tab shows a bar: "Download job: N Videos left (≈ X GB) — **Resume** / **Discard**". Resume starts the runner; Discard cancels the job (deletes partials). If the job's destination Root is unmounted, the bar says "waiting for <Root>" and Resume is disabled until it is mounted. A card click while the prompt is open adds its job of one and starts the runner, which resumes the old job too.

**Quit guard:** ⏻ (`POST /api/quit`) while items are running asks "N downloads are running. Quit anyway? They will resume next time." The server kills the processes (partials kept) before exiting.

### 4.8 Retention

Only the latest **bulk** job and its Failure report are kept. A new Confirm deletes older finished bulk jobs (rows and log directories). Card jobs are deleted when they finish successfully; a failed card job stays until Retry or dismissal (§8). The latest bulk job stays reachable from the avatar menu ("Last download…") until the next Confirm.

---

## 5. Instagram

### 5.1 Signed out first

Every Instagram item is tried signed out. Only a `login_wall` failure triggers a retry with cookies, and only when cookies are configured.

### 5.2 Setup and storage

`instagram_auth` in `download_setting`, one of:

- `{ "kind": "none" }` (default) — row shows "signed out".
- `{ "kind": "browser", "browser": "firefox" | "safari" | "chrome" | "brave" | "edge" | "chromium" | "opera" | "vivaldi", "lastWorkedAt"?, "expired"? }` — "cookies from <browser>". Only the name is stored. On macOS, the picker notes that Chrome-family browsers raise a keychain prompt and Safari may need Full Disk Access.
- `{ "kind": "file", "lastWorkedAt"?, "expired"? }` — "cookies.txt, last worked <date>". The chosen file (through `/api/choose-file`) is copied to `<dataDir>/instagram-cookies.txt` with mode 0600; the original path is not kept. The first line must be `# HTTP Cookie File` or `# Netscape HTTP Cookie File`, else it is refused with "Not a Netscape cookies.txt". Labelled **recommended**, with the advice to export it from a throwaway account in its own browser profile.
- `expired: true` shows "expired" in red with the change link.

Clearing the setting deletes the copied file. The setting lives in the dialog's **Instagram row**, shown only when the current selection includes Instagram Videos. The control center does not exist yet; when it is built it carries the same setting (§12).

### 5.3 Notice

Before cookies are used the first time, a one-time notice must be acknowledged (`instagram_notice_ack_at`): Instagram may lock or ban accounts used this way; Meta's terms bar automated collection; use a throwaway account. Setting cookies without acknowledging is not possible.

### 5.4 Pacing and failures

- Instagram items run one at a time, with a random 3–8 s pause between them.
- On a `login_wall` with cookies configured: one immediate retry with cookies. Success sets `lastWorkedAt`. A second `login_wall` fails the item as "login wall or removed post". `cookies_expired` fails it as "cookies expired" and sets `expired`.
- On the first `login_wall` in a job **without** cookies: that item fails as "login wall or removed post", and every remaining Instagram item of the job is set `failed` with `needs_signin` ("needs sign-in") without being tried. Retry failed after adding cookies re-runs them.

---

## 6. HTTP API

All under the existing host check (`hostError`), JSON, on `src/server/api.ts`, implemented in `src/server/downloads/`.

| Method and path | Does |
|---|---|
| `GET /api/downloads/tools` | §2.5 |
| `POST /api/downloads/tools/install` | installs yt-dlp and deno if missing; progress via `GET /api/downloads/tools` |
| `POST /api/downloads/plan` | body `{ option, n?, seed?, type?, artistId?, quality, destDir? }` → `{ videos: [{ id, title, artists, source, durationS, estBytes, posterUrl }], totals: { count, estBytes, withoutEstimate, estSeconds, throughputAssumed }, freeBytes, destInRoot, instagramCount }`; also `options` counts per tile (§7) |
| `POST /api/downloads/jobs` | body `{ option, quality, destDir, videoIds }` → the new job; the browser sends the picked ids |
| `POST /api/downloads/card` | body `{ videoId }` → a job of one at the front, or moves an existing item to the front |
| `GET /api/downloads?logCursor=<n>&job=<id>` | queue snapshot: running job(s), items (state, bytes, speed, eta, reason), per-Video map for cards, `paused`, `offline`, site pauses, `resumePrompt`, and new log lines since the cursor (with the next cursor) for the selected job |
| `POST /api/downloads/pause` / `resume` | §4.5 |
| `POST /api/downloads/jobs/:id/cancel` · `/retry-failed` · `/discard` | §4.5, §4.7 |
| `POST /api/downloads/items/:id/cancel` · `/retry` · `/dismiss` | one item |
| `GET /api/downloads/items/:id/log?tail=200` | the card's pop-up |
| `GET /api/downloads/jobs/:id/report.txt` | the Failure report (§9), `Content-Disposition: attachment` |
| `GET /api/downloads/settings` · `PUT` | Instagram auth (§5.2) and the notice ack; never returns cookie contents |
| `POST /api/choose-folder` | macOS `osascript -e 'choose folder'`, like `/api/choose-file`; other platforms return 501 and the dialog shows a path field |

**Polling:** 1 s while the dialog is open or any card on screen is queued or running; otherwise the grid's existing refresh. Log lines come by cursor so the page never re-reads the whole log.

---

## 7. The download dialog

Variant B, "One sheet". The prototype (`src/web/prototype/DownloaderPrototype.tsx`, with `downloaderSim.ts` faking the queue) is the visual source; the build replaces the sim with §6 and drops `?variant=` and the floating bar. Entry: avatar menu → **Download videos…** (shown when any downloadable Video is Not on this machine), and **Last download…** when a bulk job is kept (§4.8).

### 7.1 Layout

Left: the **Artwork** panel, a placeholder until the owner describes it (§12). Right: one sheet, no steps. The page behind doesn't scroll. Closing the dialog loses nothing.

### 7.2 Choosing

- **Option tiles:** five in a row, each in its own theme hue: **Full archive** (everything downloadable and Not on this machine), **Random** (N, default 20, with reroll), **By Type**, **By Artist**, **Favorites**. Each shows its count, then size and time with no dot between them ("≈ 41 GB 5 h"). Every tile always shows its control (Random's N + reroll, a Type select, an Artist select), so choosing never changes the layout; using a tile's control selects the tile.
- **Quality:** segmented **720p / 1080p / Best**, default 1080p; changes every estimate.
- **Destination:** "Into Root <name>" with **Change…** (`/api/choose-folder`). With several Roots, the default is the first mounted one in Root order. A folder outside every Root shows "Videos downloaded here won't appear in the library" and **Back to Root**.
- **Instagram row** (§5.2), when the selection includes Instagram Videos.
- **Picker** (every option but Full archive): a row per Video with checkbox, thumbnail, title, artists, **Length** and **Size** columns, and a **Select all / Deselect all** checkbox with "N of M picked". It fades in when the option changes. Full archive shows a short note ("All N Videos not on this machine") instead of a list.
- **Footer:** free disk space and the primary button **"Download N Videos (≈ X GB) ~time"**, disabled when nothing is picked or the disk is too small (§3.4). "+ N without an estimate" and "speed assumed" appear beside it when they apply.

### 7.3 Log

After Confirm, the same dialog turns into the job's log:

- A big percent, then "n of N downloaded · k failed".
- The overall bar, with **"X MB of Y GB ~time · speed"**. The speed is coloured by pace with the theme's red / yellow / green: < 1.5 MB/s, < 4 MB/s, ≥ 4 MB/s. "Waiting for connection…", "Paused", "YouTube paused for 5 min (rate limit)" replace the speed when they apply.
- One row per Video, sorted running → failed → queued → done; marks ↓ / ! / ✓, none for queued. A running row shows its own "of ~time · speed" line; a failed row its reason; every row a × (cancel) while live.
- **Show yt-dlp output · n lines · k errors**: a full-width button with a terminal icon (no caret). The output is coloured like yt-dlp's own `--color`: ERROR red, WARNING yellow, percent blue, speed green, ETA yellow, `[tags]` cyan (the app colours it; yt-dlp runs with `--no-colors`).
- Buttons: **Pause / Resume**, **Cancel**, **Save failure report (.txt)**, **Retry failed (k)**, and **New download** once the job is finished.

### 7.4 Theme fixes from the prototype

- The primary button needs a selector that wins over every theme's `.btn` styling (Lawson Night showed the bug).
- Selects use one shared chevron instead of native arrows.

---

## 8. The card

From the prototype's variant A, replacing sharing spec §7.1's "one small download mark":

- **Idle:** a small round download button in the poster's corner. On hover it expands to show the estimate ("≈ 120 MB"). Click: `POST /api/downloads/card`; the click does not open the Player. Hash-only Videos keep the old mark with no button.
- **Queued:** a "Queued #n" pill; "Queued · next" when it is at the front.
- **Running:** a "42% · 31 s" pill and a 4 px progress strip across the bottom of the thumbnail. "Merging…" / "Adding…" during `merging` / `scanning`.
- **Failed:** a red "Failed ▾" pill opening a pop-up with the reason, the tail of the yt-dlp output scrolled to the error (`/items/:id/log`), **Retry** and **Dismiss**. It stays until one is pressed.
- **Done:** "✓ Downloaded" until the next poll shows the Copy, then an ordinary card.

A card shows its Video's queue state whatever started it (the dialog or the card). The Not-on-this-machine panel in the Player (sharing spec §7.1) gets the same **Download** button beside the source link.

---

## 9. The Failure report

Plain text, UTF-8, from `GET /api/downloads/jobs/:id/report.txt`, filename `TuvaVideos failed downloads <YYYY-MM-DD>.txt`:

```
TuvaVideos — failed downloads
Job of 2026-11-08 21:14 · 1080p · into /Volumes/Server/Khöömei/Collection
12 of 340 Videos failed

<title>
  <source url>
  <reason words> — <error line>

…
```

Reason words: "unavailable", "private", "not available in your country", "login wall or removed post", "private: follow required", "cookies expired", "needs sign-in", "rate limited", "disk full", "network", "no JavaScript runtime", "unknown error". Retry failed updates the report.

---

## 10. Testing

- **Unit (`bun test`):** the progress-line parser, the failure classifier (every row of §4.4 on real messages from the research notes), the estimate maths (§3.4 incl. the height rules and the without-estimate count), the selectors and output templates round-tripping through `parseFilename`, the queue state machine with a fake runner (pause, cancel, retry, offline, per-site backoff, Instagram one-at-a-time and needs-sign-in, resume after restart, retention), the cookies.txt header check, and the Reference size Copy choice.
- **Fake yt-dlp:** `test/fixtures/fake-yt-dlp.ts`, a script that the queue tests point `TUVA_BIN_DIR` at, which replays scripted progress, errors, exit codes and a small real clip as its output file. The queue and scan-in are tested end to end with it, offline.
- **Archive (Lyrics Website):** pgTAP for the three columns and `write_videos`; the RLS snapshot.
- **Real downloads (verification ticket):** on this Mac and a clean Mac account: install from scratch (Gatekeeper, checksums), one YouTube, one Instagram reel signed out, one Rutube Video; the progress template on a real download (including a `bv+ba` merge and an HLS source); pull the network mid-download and restore it; kill the server mid-download and resume; a full-disk run on a small disk image. The agent's browser pass on the dialog and card in Lawson Night and one light theme (muted, per the smoke-test rule). Message wordings that differ from the classifier become fixes.

---

## 11. Implementation plan

Build tickets run on Claude Opus 5.5 (`claude-opus-5-5`), one per ticket in its own worktree on branch `task/<slug>`, chained by GitHub issue dependencies. The gate is `bun run ci` (and `npm run ci` in the Lyrics Website for ticket 2).

| # | Ticket | Scope | Blocked by |
|---|---|---|---|
| 1 | `downloader-tools` ([#197](https://github.com/IncoherentThoughts/TuvaVideos/issues/197)) | §2: `findDownloaderBin`, install of yt-dlp and deno with checksums, PATH detection of deno/Node, daily `-U`, impersonation check, `GET /api/downloads/tools` + install endpoint, ffmpeg location, migration 0023 (`download_setting`). | — |
| 2 | `reference-size-archive` ([#198](https://github.com/IncoherentThoughts/TuvaVideos/issues/198)) | §3.1 in the Lyrics Website checkout by that repo's rules: migration 144, `write_videos` fields, pgTAP, RLS snapshot; live apply HITL. | — |
| 3 | `reference-size-app` ([#199](https://github.com/IncoherentThoughts/TuvaVideos/issues/199)) | §3.2–3.3: local migration 0022 incl. the `*_all` view, `archiveWire`, `applyShared`, candidates endpoint, the browser fill beside the poster upload. | 2 |
| 4 | `ytdlp-runner` ([#200](https://github.com/IncoherentThoughts/TuvaVideos/issues/200)) | §4.3–4.4 for one item, no queue: argument builder, selectors, templates, progress parser, sizing pass, classifier, the fake yt-dlp fixture. Pure modules in `src/server/downloads/` with tests. | — |
| 5 | `download-queue` ([#201](https://github.com/IncoherentThoughts/TuvaVideos/issues/201)) | §4.1–4.2, 4.5–4.8, §5.4 pacing, §6 endpoints except plan and settings: migration 0024, runner and slots, offline and per-site backoff, `Scanner.scanFile`, resume prompt endpoint, quit guard on the server, retention, the report (§9). | 1, 4 |
| 6 | `download-plan` ([#202](https://github.com/IncoherentThoughts/TuvaVideos/issues/202)) | §3.4 and the plan endpoint: options and their counts, Random with seed, Type, Artist, Favorites, estimates per quality, throughput, free disk, `/api/choose-folder`. | 3 |
| 7 | `download-dialog` ([#203](https://github.com/IncoherentThoughts/TuvaVideos/issues/203)) | §7: port variant B from `prototype/downloader-dialog-193` onto §6, avatar menu entries, resume bar and quit question in the web app, theme fixes (§7.4). | 5, 6 |
| 8 | `card-download` ([#204](https://github.com/IncoherentThoughts/TuvaVideos/issues/204)) | §8: card button and states, the Player panel's Download button, the 1 s card polling. | 5 |
| 9 | `instagram-cookies` ([#205](https://github.com/IncoherentThoughts/TuvaVideos/issues/205)) | §5.1–5.3 and the cookies retry of §5.4: settings endpoints, cookies.txt copy and check, browser choice, the notice, the dialog's Instagram row, expired detection. | 5, 7 |
| 10 | `downloader-verification` ([#206](https://github.com/IncoherentThoughts/TuvaVideos/issues/206)) | §10's real-download pass (HITL where it needs a clean Mac or a small disk), the browser pass, fixes as follow-ups, then the owner's pass. | 1–9 |

1, 2 and 4 start together; 3 follows 2; 5 needs 1 and 4; 6 needs 3; 7 needs 5 and 6; 8 follows 5 alongside 6 and 7 (different files: the card and Player vs. the dialog); 9 follows 7.

---

## 12. Later and not yet specified

- **Artwork** for the dialog's left panel: to be described by the owner; a placeholder ships.
- **The control center** tab: when built, it carries the Instagram setting (§5.2) and a yt-dlp row (version, update now).
- **Platform details:** Windows and Linux paths and binary names are as in §2.2 but untested; musl Linux, and a Windows `choose-folder`, come when a collaborator needs them.
- **Nightly channel** for yt-dlp, if stable proves stale for YouTube.
- Sharing or downloading hash-only Videos (no source link), as its own effort.
- A "Download these N" entry point from the grid's current filter. Artist, Type and Favorites in the dialog cover it for now.
