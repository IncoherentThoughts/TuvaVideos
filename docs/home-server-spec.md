# TuvaVideos Home Server specification

Assembled 2026-11-26 from the grilling session that settled the design. Decisions: [ADR 0011](adr/0011-the-mac-mini-is-the-home-server-reached-over-tailscale.md) (Home Server, Tailscale, Approved devices) and [ADR 0012](adr/0012-live-streams-may-re-encode-video.md) (Live streams may re-encode). Vocabulary: `CONTEXT.md` (**Library Server**, **Home Server**, **Approved device**, **Live stream**, **On the Home Server**). Amends `docs/tv-spec.md` §2, §3.4, §4.2–4.3 and §11 and `docs/sharing-spec.md` §1 (Favorites and Resume per machine) where they disagree; this document wins.

Points marked **[proposed]** were not put to the user in the grilling; they are this draft's defaults and are listed again in §13.

---

## 1. Product, people and constraints

The library lives on a TerraMaster USB drive plugged into the **Mac mini** (Apple M6, ffmpeg 9 with VideoToolbox), Root `/Volumes/Server/Khöömei/Collection`, 2,180 Copies. The mini becomes the **Home Server**: it serves on its own, the Samsung TV reaches it without any other Mac running, and the user's other Macs (the laptop) stream the Videos they lack from it, at home and away, over Tailscale.

### Who

- **The owner** is the only person who connects to the Home Server from other machines. Their Resume positions and Favorites follow them across their machines through it.
- **Other Members** (later, editing link data and adding Videos) never connect to the mini. They keep their own libraries and get link data through Sharing, unchanged.

### Standing constraints

- **Tailscale is the only way in from away.** Nothing is exposed to the public internet; no port forwarding, no tunnel, no app-level login.
- **Remote Macs are watch-only on the server.** Browse, play, Resume, Favorites, download a Copy. Edits to link data go through Sharing as today; Studio, Rescan, Roots, deletes and screenshots stay local to each machine.
- **A local Copy is preferred over the Home Server's** whenever one is usable (§5.3).
- **Original quality by default, everywhere.** Lower qualities and automatic re-encoding come from the Live stream (§7); nothing is cached.
- The localhost app on 127.0.0.1:4400 is unchanged. The Library Server stays on **4401**.

---

## 2. Library Server

The TV Server of `docs/tv-spec.md` §2, renamed, serving Macs as well as TVs.

### 2.1 Listener and health

- Same listener, port and route list as today, plus the Mac-only routes of §2.3.
- `GET /api/health` keeps `app: "TuvaVideos TV Server"`, because installed TV shells match on that string (`tv/shell/discovery.js`, `HEALTH_MARK`) and a shell change costs a reinstall with the Samsung certificate. It gains `name` (the Mac's computer name), `home` (true on the Home Server), `drive` (`"mounted"` when any Root is mounted, else `"unmounted"`) and `version` (the app's commit). Code renames `TV_APP_NAME` and friends to Library Server names; the wire string stays. **As built (#237):** `version` is the short git commit of the checkout the app runs from (package.json's version when there is no git); `home` is false until the Home Server toggle exists (#240); the `TV_APP_NAME` constant is gone, the wire string lives in `src/server/libraryServerHealth.ts` (`HEALTH_APP`), and the TV page's `<title>` reads "TuvaVideos Library Server". The top bar button reads "Library Server" ("Library Server on · ip:port" while serving). The shell's own wording (`tv/shell`) still says "TV Server" until the shell is reinstalled (#245).

### 2.2 Serve on launch, login and sleep

- A per-machine setting, **Serve on launch**, off by default (laptops keep today's behaviour: off at every launch, started from the top bar).
- With it on, the app starts the Library Server at launch, and **Open at login** becomes available: the app installs a LaunchAgent in `~/Library/LaunchAgents` that starts the app bundle at login **without opening a browser tab** (`--background`). **[proposed]** LaunchAgent rather than a Login Item, since the app is a Bun process inside a bundle built by `scripts/make-app.ts`.
- While the Library Server is on and Serve on launch is set, a `caffeinate -i -w <pid>` child keeps the Mac from idle-sleeping; it ends with the process.
- **Drive not plugged in**: the server keeps serving. Videos on unmounted Roots are Unmounted as today; health reports `drive: "unmounted"`, and the TV shows **"Server drive not connected"** instead of a grid of unplayable Videos. Macs show the Home Server's Videos as Unmounted, not On the Home Server.

### 2.3 Routes for Approved Macs

Everything Approved TVs get (tv-spec §2.3), plus:

| Route | Purpose |
|---|---|
| `GET /api/home/index` | Every Video with its Copies, identity (`id`, `youtube_id`, `content_hash`), Copy facts and the **browser** Playback profile decision per Copy, and, for Videos never Shared, their title, Latin title, Type and Chapters (§5.1). `ETag` so an unchanged index costs nothing. |
| `GET /api/me/state?since=<ts>` | Resume positions and Favorites changed since `ts` (§6). |
| `PUT /api/me/resume`, `PUT /api/me/favorite` | Writes from another machine of the owner's (§6). |
| `GET /api/approvals`, `POST /api/approvals/:ip` | Pending TV approvals and Allow / Deny (§3.2). |
| `GET /copy/:id` with `download=1` | The whole file for a Download from the Home Server (§8), Range-resumable. |

Macs never get anything the TV is denied (tv-spec §2.3, "Never exposed").

---

## 3. Approved devices

Migration: `approved_tv` becomes **`approved_device`** (`ip`, `kind` `tv`|`mac`, `name`, `model`, `via` `tailscale`|`click`, `tailscale_login`, `approved_at`, `last_seen_at`); existing rows become `kind = 'tv', via = 'click'`. Migration `0025_approved_device.sql` (table rebuilt, `kind` and `via` CHECK-constrained, defaults `'tv'` and `'click'`); `name` is a Mac's computer name and stays NULL for TVs, which have only `model`.

### 3.1 Tailscale devices, on sight

- A request from a Tailscale address (100.64.0.0/10, or fd7a:115c:a1e0::/48) is checked with `tailscale whois --json <ip>` (CLI at `/usr/local/bin/tailscale`, else inside `/Applications/Tailscale.app`). If the peer's user is the same as this Mac's own Tailscale user (`tailscale status --json` → `Self.UserID`), it is an Approved device at once, `via = 'tailscale'`, `kind = 'mac'` unless whois says otherwise. Another user's device, or a failed lookup, falls through to §3.2.
- Results are cached per IP for 10 minutes. The decision is a pure function over the two JSON answers (tested without Tailscale).
- Macs always reach the Home Server by its Tailscale name (§4.1), so they come in over Tailscale even at home; the click path is for TVs.

### 3.2 Everyone else, one click from any approved Mac

- Unchanged on the server Mac's own tab (tv-spec §2.2).
- In addition, every Mac with this Library Server set as its Home Server shows that server's pending approvals in its own top bar, **"Allow TV at ‹IP› on ‹mini name›? Allow / Deny"**, from `GET /api/approvals` polled every 5 s while the laptop is connected. Allow or Deny goes through `POST /api/approvals/:ip`. Nobody needs to sit at the mini.
- The top bar menu on the mini lists Approved devices with kind and how they were approved; Remove works for both (a Tailscale device removed is re-approved on its next request: removing it only clears the row).

---

## 4. Picking a server

### 4.1 On a Mac

- Control center gains **Home Server**: a single field holding a Tailscale name or address (`mac-mini`), with Test (calls health, shows name, version and drive). Empty means no Home Server; nothing in §5–§8 runs.
- On the mini, the field shows **"This Mac is the Home Server"** instead (a toggle, which sets `home: true` in health). A Mac that is its own Home Server never connects to itself.
- Connection state shows in the top bar: "Home · mac-mini" (connected), "Home · unreachable" (§9). Health is checked at launch, on focus when the last check is older than 60 s, and every 30 s while anything is streaming from it.

### 4.2 On the TV

Replaces tv-spec §4.2's "first answer wins". **Shell change**: needs a reinstall (`bun run tv-install`).

- **At startup** the shell tries the last address and runs the /24 sweep together (2 s), collecting every server that answers. One server (or only the last one) answers: connect straight away, no prompt. More than one: a **server picker** listing each by `name`, Home Server first and marked, the last used one focused.
- **During a session** the side pane's menu gains **Server: ‹name›**. Choosing it lists the servers found by a fresh sweep; picking one stops playback (Resume is written first) and the shell reloads the UI from that server. Switching is only ever by hand.
- **If the server drops** (tv-spec §4.3, two missed health checks), "‹name› stopped answering" offers Look again (sweep and picker) or Back to exit.
- Each server serves its own UI, so the TV may show slightly different UI versions on the mini and a laptop. Accepted.

---

## 5. A Mac streaming from the Home Server

### 5.1 The home index

- The laptop's companion fetches `GET /api/home/index` at connect, on window focus when older than 10 minutes, and from a refresh button; never on a timer. It is stored in two tables in the laptop's `library.db`: **`home_copy`** (the mini's Copy id, its Video's identity, facts, browser decision) and **`home_video`** (Videos the laptop does not know, with the mini's title, Latin title, Type and Chapters). Both are replaced wholesale at each fetch. **[proposed]** separate tables so nothing from the mini ever touches the laptop's own rows, Shared data or Sync.
- **Matching**, per mini Video: the same `id` (every Shared Video), else the same `youtube_id`, else the same `content_hash`. Unmatched mini Videos go to `home_video`.

### 5.2 What shows

- A laptop Video with no usable local Copy and a matched `home_copy` is **On the Home Server**: server mark, not greyed, playable. With no match it stays **Not on this machine**.
- Each `home_video` row appears in grids, search and Favorites as a Video **On the Home Server**, with the mini's titles, Type and Chapters, **read-only** here: no tag editing, no Chapter editing, no Share. Its Thumbnails are proxied from the mini's `/thumbs`.
- Shared Videos keep the laptop's own Shared data as their titles and tags; the mini's copy of those is ignored.

### 5.3 Preferred Copy

The selection rule gains one step: a **local** Copy that is usable (Root mounted, not Missing) is always first; then the Home Server's Copies, ordered by the existing rule (plays as-is under the browser profile, larger resolution, smaller size). The per-play Copy switcher lists both groups, the remote ones labelled "Home Server".

### 5.4 Playback path

- The browser never talks to the mini. The laptop's companion proxies `/home/copy/:homeCopyId` and `/home/live/…` to the mini's `/copy/:id` and `/live/…`, passing Range through. **[proposed]** One origin for the tab (no CORS, no mixed state), and the Approved device is the laptop's Tailscale address.
- On the Library Server `/copy/:id` today picks the file by the **TV** Playback profile (`src/server/tv.ts`, the `copy` route). For a request from an Approved device of `kind = 'mac'` it picks by the **browser** profile instead, as the localhost app does (`src/server/api.ts`, the `order === "fallback"` branch): the Copy, or its Fallback when the browser needs one.
- Keyframe index: fetched from the mini (`/api/copies/:id/keyframes`) through the same proxy, so Keyframe seek works.
- Audio settings: those of the laptop's own Video when it has one; for a `home_video`, the mini's saved Audio settings, read-only.

---

## 6. Resume and Favorites follow you

### 6.1 Data

- Migration: `video_local.resume_at`, `video_local.favorite_at` (time of the last star or unstar; `favorited_at` null with `favorite_at` set means unstarred), and `chapter_local.favorite_at` likewise. Existing rows: `resume_at = last_played_at`, `favorite_at = favorited_at`.
- Keys between machines are the **Video identity** (`youtube_id` else `content_hash`), not `id`, so Unshared Videos match. Chapters are keyed by (Video identity, Chapter start in ms). **[proposed]** Chapter ids differ between machines for Unshared Videos.
- The Home Server is the store. Every write on a connected Mac goes to its own `library.db` first, then to the mini; while unreachable it waits in a **`home_outbox`** table and is sent in order on reconnect.
- **Newest wins** on both sides, by `resume_at` / `favorite_at`. At connect and on each focus check the laptop pulls `GET /api/me/state?since=<last pull>` and applies newer rows.

### 6.2 First connect: back up, then the laptop replaces the mini

1. The first time a Mac connects to a Home Server (no `home_server_first_sync_at` in its settings), Favorites do not sync yet. A dialog says the laptop's Favorites will replace the mini's and asks for a backup: **Export Favorites…** saves a JSON file (Video identity, Chapter start, `favorited_at`, title for the reader) where the user chooses. The dialog cannot be passed without a saved file; Cancel leaves the Mac connected for streaming, with Favorites unsynced, and asks again at the next connect.
2. After the export, the laptop's Favorites **replace** the mini's in one request; the mini's prior Favorites are written to `favorites.before-home-sync-<date>.json` in its data directory first.
3. Resume positions at first connect are merged newest-wins (§6.1), no replace.
4. **Import Favorites…** in the control center reads such a file back, newest-wins against what is there.

### 6.3 Through a laptop's Library Server

A TV playing from the laptop writes Resume to the laptop like any local write, which goes to the Home Server through the outbox. Nothing special in the TV.

---

## 7. Live stream

Builds tv-spec §3.4, which was specified but never built (`src/server/tv.ts` answers the `live` route with 404), and extends it to re-encode video and to serve Macs.

### 7.1 When

- **Picked quality**: the Player offers **Original** (default, every play), **1080p**, **720p**, **480p**, chosen for one play and never remembered. A quality at or above the Copy's own height is not offered. Original plays the Copy or Fallback directly as today; anything else is a Live stream.
- **Automatic**: a Copy that neither it nor its Fallback suits the player's Playback profile (for example AV1 or 4K on a TV that cannot play it) plays as a Live stream at the profile's largest allowed size. The Playback profile decision gains a video `transcode` result (tv-spec §3.1 never produced it before).
- **Copy mode**: when only the container or audio is wrong, the video is copied, as tv-spec §3.4 specified.

### 7.2 How

- Route `/live/:copyId/index.m3u8?q=orig|1080|720|480` and segments `seg<n>.ts`, the tv-spec §3.4 shape: 10 s segments, a full-length VOD playlist up front, `-ss` before `-i`, encode about 60 s ahead of the last request then pause, prune segments more than 300 s behind, and kill-and-restart at the requested segment for a jump outside the produced range.
- **Encode mode**: `-c:v h264_videotoolbox`, `-vf scale=-2:<h>`, keyframes forced every 10 s so segments align on any restart (`-force_key_frames expr:gte(t,n_forced*10)`). **[proposed]** bitrates 8 Mbit/s (1080p), 4 Mbit/s (720p), 1.5 Mbit/s (480p), capped at the source's own; audio AAC 160 kbit/s stereo (the Video's Audio settings are applied by the player as today, not baked in).
- **Two at a time per server.** A stream belongs to the requesting device; that device starting another replaces its own. A third device gets **503** `{ error: "busy", streams: [‹device name›, ‹title›] }` and the player shows "‹server› is busy streaming to ‹devices›". Bypasses the ffmpeg queue and Thumbnail gate (tv-spec §3.4).
- **Nothing cached**: segments in a temp dir deleted when the stream stops, the Library Server turns off, or the process exits. Hard stop kills both.
- **Players**: the TV plays HLS natively (capped at 1080p). The desktop Player uses native HLS when `canPlayType('application/vnd.apple.mpegurl')` answers, else a bundled **hls.js**. Seeking and Keyframe seek over a Live stream snap to segment starts.

---

## 8. Download from the Home Server

- `download_item.source` gains `'home'` (migration). A Video On the Home Server shows the download button as today; for it the source is the Home Server, and the download dialog offers the laptop's Roots as the destination, with "Home Server" as the source line instead of a quality choice (the mini's Preferred Copy is fetched as it is).
- The job fetches `/copy/:id?download=1` through the proxy into the queue's temp file, resumes with Range after a drop, checks the size (and the SHA-256 for a hash-identified Video), then moves the file into the chosen Root at **the mini's `rel_path`**. A scan makes it a Copy, and the Video stops being On the Home Server.
- **[proposed]** For a `home_video` (never Shared), the scan's new local Video takes the mini's title, Latin title, Type and Chapters as its own Unshared data; Song and Version pointers to the mini's Local rows are dropped.
- Failure classes added to the Failure report: **Home Server unreachable** (retried when it returns), **disk full**, **size or hash mismatch**.
- Reuses the downloader's queue, dialog, card and Failure report (`docs/downloader-spec.md` §4, §7–§9).

---

## 9. When the Home Server cannot be reached

- On a Mac: Videos On the Home Server go back to **Not on this machine**; `home_video` rows hide; Resume and Favorite writes wait in `home_outbox`; a stream already playing pauses with **"Home Server unreachable"**, keeps the Resume position, and offers Retry. Downloads from it wait (§8).
- On a TV: tv-spec §4.3 with the server's name, and the picker (§4.2).

---

## 10. Testing

`bun run ci` stays the gate (CI is local-only).

- **Pure functions**: the Tailscale approval decision (§3.1); identity matching (§5.1); the Preferred Copy rule with remote Copies (§5.3); newest-wins merge and outbox ordering (§6.1); Live stream playlist and segment arithmetic, quality options for a given Copy height, and slot arbitration (§7.2).
- **Two servers in one test**: a second companion on another port and data dir (`TUVA_TV_PORT` already exists for tests) as the Home Server, with whois stubbed; covers the index, proxying with Range, Resume and Favorites both ways, first-connect replace, and a download.
- **ffmpeg**: one short fixture through encode mode, checked for segment count and keyframe at each segment start.
- **Real hardware (manual, last)**: the TV finding the mini alone, then the picker with the laptop also serving; the laptop at home and on a phone hotspot at 720p; pulling the TerraMaster mid-session.

---

## 11. Implementation plan

Each a ticket on map [#236](https://github.com/IncoherentThoughts/TuvaVideos/issues/236); dependencies (plan numbers) in brackets.

1. [#237](https://github.com/IncoherentThoughts/TuvaVideos/issues/237) **Library Server rename and health**: code rename, health fields (§2.1), `approved_device` migration (§3). []
2. [#238](https://github.com/IncoherentThoughts/TuvaVideos/issues/238) **Serve on launch**: setting, LaunchAgent and `--background`, caffeinate, drive-unmounted health and TV message (§2.2). [1]
3. [#239](https://github.com/IncoherentThoughts/TuvaVideos/issues/239) **Tailscale approval and remote Allow** (§3.1, §3.2). [1]
4. [#240](https://github.com/IncoherentThoughts/TuvaVideos/issues/240) **Home Server setting and home index**: control center field, `home_copy` / `home_video`, matching, On the Home Server in grids, search and Favorites (§4.1, §5.1, §5.2). [3]
5. [#241](https://github.com/IncoherentThoughts/TuvaVideos/issues/241) **Streaming from the Home Server**: proxy, Preferred Copy rule, keyframes, Audio settings (§5.3, §5.4). [4]
6. [#242](https://github.com/IncoherentThoughts/TuvaVideos/issues/242) **Resume and Favorites follow you**: migrations, `/api/me/*`, outbox, export / import, first-connect replace (§6). [4]
7. [#243](https://github.com/IncoherentThoughts/TuvaVideos/issues/243) **Live stream**: copy and encode modes, two slots, profile `transcode` decision (§7.1 automatic, §7.2). []
8. [#244](https://github.com/IncoherentThoughts/TuvaVideos/issues/244) **Quality picker**: desktop Player and TV, hls.js (§7.1). [5, 7]
9. [#245](https://github.com/IncoherentThoughts/TuvaVideos/issues/245) **TV shell: several servers**: sweep collecting all, picker, side pane switch, reinstall (§4.2). [1]
10. [#246](https://github.com/IncoherentThoughts/TuvaVideos/issues/246) **Download from the Home Server** (§8). [5]
11. [#247](https://github.com/IncoherentThoughts/TuvaVideos/issues/247) **Unreachable states** (§9). [5, 6]
12. [#248](https://github.com/IncoherentThoughts/TuvaVideos/issues/248) **Real-hardware verification** (§10). [all]

1, 7 and 9 can start in parallel; 7 touches only the Live stream and the profile decision.

---

## 12. Later and out of scope

- **Later**: adaptive bitrate (several renditions at once); a remembered per-device quality; HEVC encode for the TV; Favorites import with replace; streaming from a laptop's Library Server to another Mac.
- **Out of scope**: public internet access; any login beyond Tailscale identity and the IP allowlist; other Members connecting to the Home Server; editing through the Home Server; caching transcodes.

---

## 13. Open points for the user

Defaults this draft chose that the grilling did not settle:

1. A **LaunchAgent** for Open at login (§2.2).
2. **Separate `home_copy` / `home_video` tables**, never mixed into the laptop's own rows (§5.1).
3. **The companion proxies** all Home Server traffic for the browser (§5.4).
4. Chapter Favorites keyed by **(Video identity, start time)** (§6.1).
5. Live stream **bitrates** of 8 / 4 / 1.5 Mbit/s (§7.2).
6. A downloaded never-Shared Video **inherits the mini's titles, Type and Chapters** (§8).
7. The mini keeps a **JSON backup of its own Favorites** before the laptop's replace them (§6.2).
