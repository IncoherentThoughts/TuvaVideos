# TuvaVideos TV specification

Assembled 2026-10-16 in [issue #53](https://github.com/IncoherentThoughts/TuvaVideos/issues/53) from every closed ticket on [map #43](https://github.com/IncoherentThoughts/TuvaVideos/issues/43), with the map's open items decided in the same grilling. Normative for the TV build tickets (§9). Vocabulary: `CONTEXT.md` (the **TV** section and Playback profile, Live remux, Approved TV, Playlist). The v1 spec (`docs/spec.md`) is the baseline: everything not said here is as the browser app does it, and the TV reads the same library through the same handlers.

Sources folded in: [#47](https://github.com/IncoherentThoughts/TuvaVideos/issues/47) Tizen facts ([research/tizen-2026-r85h.md](research/tizen-2026-r85h.md)), [#44](https://github.com/IncoherentThoughts/TuvaVideos/issues/44) the Plex sample ([research/plex-sample.md](research/plex-sample.md)), [#45](https://github.com/IncoherentThoughts/TuvaVideos/issues/45) how Plex decides ([research/plex-decision.md](research/plex-decision.md)), [#46](https://github.com/IncoherentThoughts/TuvaVideos/issues/46) how Plex stays instant ([research/plex-low-lag.md](research/plex-low-lag.md)), [#52](https://github.com/IncoherentThoughts/TuvaVideos/issues/52) playback strategy, [#48](https://github.com/IncoherentThoughts/TuvaVideos/issues/48) hello-world on the TV (branch `task/hello-world-tv`, `tv/hello-world/`), [#49](https://github.com/IncoherentThoughts/TuvaVideos/issues/49) TV Server scope and security ([ADR 0004](adr/0004-tv-server-on-the-home-network.md)), [#50](https://github.com/IncoherentThoughts/TuvaVideos/issues/50) home and navigation and [#51](https://github.com/IncoherentThoughts/TuvaVideos/issues/51) Player (prototype `tv/home-prototype/`, branches `prototype/tv-home` and `prototype/tv-player`; home variant B "Rails" and Player variant B "Overlay" won, A and C stay there as rejected).

---

## 1. Product, constraints and TV facts

A sideloaded app on the living-room TV that browses and plays the library with the remote, fed by a **TV Server** the user switches on in the browser app. The TV is read-only: it writes Resume positions and view counts and nothing else.

### Standing constraints

- The TV app is **read-only**: no editing (Chapters, headers, Artists, Songs, lyrics, merges), no Studio playback, no Rescan, no screenshots, no Favorites starring, no deleting.
- **Home network only.** The TV Server listens on the LAN behind a per-request IP allowlist (ADR 0004 supersedes the v1 "`localhost` only, no auth" rule for the TV Server alone). Nothing is reachable from outside the home network and the app still never touches the internet.
- The **localhost app is unchanged**: same port, same binding, same behaviour. The TV Server is a second listener in the same process over the same database and scan.
- The TV Server is **off at every launch** and only runs while the user has turned it on.
- The TV **never creates cached files** on the Mac (64 GB free on a 93 % full disk): conversion for the TV is live or not at all.
- One person, one library: the TV and the browser share one Resume position per Video, last writer wins.
- Themes stay in the browser. The TV UI wears the default tokens of `docs/design-direction.md`.

### The TV (facts from #47 and #48)

| Fact | Value |
|---|---|
| Set | Samsung **MRN85R85HAFXZA**, 2026 85" Micro RGB R85H, model group 26TV_PREMIUM2 |
| OS and engine | Tizen 10.0, Chromium M130; the TV accepts OS upgrades (2023+ sets) |
| App canvas | **1920×1080 at device pixel ratio 1**, upscaled by the TV to its 3840×2160 panel |
| Network | TV at 192.168.4.56 (sdb port 26101), Mac at 192.168.4.83 on the same Wi-Fi (a DFS channel); DUID `MTCNLIPDV7U3W` |
| Tooling | Tizen Studio 6.1 at `~/tizen-studio` (installed headless through the installer's CLI entry point), Samsung Certificate Extension 2.0.75, TV Extensions 10.0; the Tizen CLI 2.5.25 runs under Rosetta |
| Certificate | profile `TuvaVideos` (Samsung › TV › Public) in `~/SamsungCertificate/TuvaVideos/`, registered in `~/tizen-studio-data/profile/profiles.xml`; **author and distributor certificates both expire 2027-10-14** |
| Playback | every codec combination in the library direct-plays in `<video src>`, 4K VP9 and AV1 included; first frame 0.3–0.8 s, a seek plays again after ~0.3 s at 1080p and ~1.2 s at 4K over Wi-Fi; the TV sends Range requests (`bytes=0-`, `bytes=32768-`, a range near the end for the index, then one per seek) |
| Keys | arrows, Enter and Back arrive unregistered; media and colour keys need `tizen.tvinputdevice.registerKey` and the `tv.inputdevice` privilege; the colour keys live in the remote's **123 panel**, which is awkward, so nothing frequent sits only on a colour key (§8) |
| Survives | Developer Mode off and a restart; Developer Mode itself had to be re-enabled after a power cycle |
| Quirks | `requestVideoFrameCallback` fires for the first frame only; Certificate Manager holds the sdb session (quit it before `sdb connect`); the dmg's GUI installer cannot run headless |

The Mac is an M1 with no hardware AV1 decode; the app's ffmpeg is the native arm64 Homebrew build (`findBin` in `src/server/config.ts`, since 2026-10-13).

---

## 2. TV Server

Decided in #49 and written as [ADR 0004](adr/0004-tv-server-on-the-home-network.md); this section is the normative form.

### 2.1 Listener

- A second `Bun.serve` in the same process, port **4401** (`TUVA_TV_PORT` overrides it, for tests only), bound to **all IPv4 interfaces**, `idleTimeout` as the localhost listener's. It shares the database, the Scanner, the Thumbnail pool, the Fallback queue and the keyframe index: nothing is duplicated.
- Started by the **TV button** in the browser's top bar; **off at every launch**. Turning it on binds the port and logs the Mac's LAN addresses; the first time, macOS's firewall asks whether `bun` may accept incoming connections (and again after each Bun upgrade).
- **Off is a hard stop**: the listener closes, open streams and any Live remux are cut, in-flight ffmpeg for a Live remux is killed. The TV shows "TV Server turned off" over its paused frame (§4.3) and the last saved Resume position stands.
- The browser's localhost listener on 4400 is untouched; a passive server (another port on the default data dir, spec §3.2) never starts a TV Server.

### 2.2 Approved TVs and the allowlist

- Every request's **source IP** is checked. `GET /api/health` answers anyone with `{ app: "TuvaVideos TV Server" }` and nothing else, so the TV app can find the Mac (§4.2).
- Any other route from an unknown IP gets **403** with `{ error: "approve" }`; the TV shows "Approve this TV on the Mac". The browser's top bar raises **"Allow TV at ‹IP›? Allow / Deny"**.
- **Allow** adds an **Approved TV** (`approved_tv(ip, model, approved_at, last_seen_at)`, a new migration) that persists across launches. A DHCP change costs one more click. **Deny** silences that IP until the TV Server is next turned on (in memory only).
- The TV identifies itself with a `X-Tuva-TV: <model>` header (the shell sets it from `webapis.productinfo` when available, else the user agent), stored as the Approved TV's model and shown in the indicator.
- No token, no pairing code: on a single-user home network, inheriting the TV's address is the only threat and it costs one click to notice.

### 2.3 Routes

A **fixed list reusing the localhost handlers**; anything not on it is a **404**, never a passthrough. The list is the security boundary and is extended deliberately.

| To anyone | `GET /api/health` |
|---|---|
| **Reads** (Approved TVs) | `/api/videos`, `/api/videos/:id`, `/api/videos/:id/chapters`, `/api/videos/:id/audio`, `/api/audio-presets`, `/api/artists`, `/api/songs`, `/api/songs/:uuid`, `/api/favorites`, `/api/search`, `/api/copies/:id`, `/api/copies/:id/keyframes`, `/copy/:id`, `/thumbs/:id/{poster,strip}.webp` |
| **Writes** (Approved TVs) | `POST /api/videos/:id/resume`, `POST /api/videos/:id/view` |
| **TV-only** | the TV UI files (`/`, `/tv.js`, `/tv.css`, `/olchey.svg`, §4.1) and the Live remux streams (`/live/:copyId/index.m3u8`, `/live/:copyId/seg*.ts`, §3.4) |

Never exposed: Studio, Rescan, Roots, scan progress, every PATCH/PUT/DELETE, merges, screenshots, loop, reveal, choose-file, relocate, `/copy/:id/pcm`, quit, favorites toggling, audio preset writes.

`/api/videos` for the TV carries the same shape as for the browser plus, per Copy, the TV **Playback profile** decision (§3.1) so the TV app never computes playability itself.

### 2.4 Indicator and menu

The top bar's TV button shows one of:

| State | Text |
|---|---|
| off | **TV** |
| on, nobody talking | **TV on · ‹Mac IP›:4401** |
| approval pending | **Allow TV at ‹IP›? Allow / Deny** |
| on, an Approved TV made a request in the last 60 s | **TV · ‹model› · playing ‹title›** (title of the Video whose `/copy` or `/live` stream was last requested; "browsing" when none) |

Its menu: **Turn off**, and the **Approved TVs** with a Remove per row (removing one puts its next request back through the prompt).

### 2.5 Writes

- **Resume**: the same rule as the browser (`src/shared/resume.ts`): written every 5 s while playing and on pause, seek, Copy switch and leaving the Player; within 30 s of the end stores 0. One `resume_s` per Video shared by both players, last writer wins, no conflict handling.
- **View**: one `POST /api/videos/:id/view` the first time playback starts on a Player visit, as the browser does.
- Playing inside a Playlist writes no Resume (spec §4.8); views are still counted.

---

## 3. Playback

Decided in #52 from #45, #46 and #47, confirmed on the TV by #48.

### 3.1 Playback profile

- A **Playback profile** is the containers, codecs and limits one player plays as-is. There are two: **browser** (today's `decidePlayback` rule: audio in {aac, opus, vorbis, mp3, flac} and a known duration) and **TV**.
- Profiles are **data**, keyed by **file extension** (ffprobe and Plex report webm as mkv, so the container name cannot express the WebM row), with per-codec limits on **pixels or the long edge**, never a literal height (portrait 1080×1920 must pass). Each profile carries a **version**.
- The **TV profile follows Jellyfin's Tizen rules**, confirmed by #48 on this set:

  | Extension | Video | Audio | Limits |
  |---|---|---|---|
  | mkv, mp4, mov, m4v | h264, hevc, vp9, av1 | aac, ac3, eac3, opus, vorbis, mp3 | long edge ≤ 4096, ≤ 60 fps for h264, ≤ 120 fps for hevc/av1, 10-bit allowed |
  | webm | vp9, av1 | opus, vorbis | as above |

  Everything in the 2026-10-11 census direct-plays (the E-AC3 mkv included). A combination that fails on the TV later is fixed by editing this table and bumping the version, never by re-encoding video.
- A **pure decision** `(copyFacts, profile) → { video: directplay | copy | transcode, audio: directplay | copy | transcode, reason }` in `src/shared/`, shaped like Plex's. Video `transcode` is never produced for the TV and is not supported; audio `transcode` means AAC.
- **When**: every Copy is judged against every profile **once, at scan time**, stored per Copy (`copy.tv_playback` and `copy.tv_profile_version`, migration), and judged again on the next scan when a profile's version changes (a startup check marks stale rows). Nothing is decided at play time. `bun run index-keyframes`-style ahead-of-time runs are not needed: the scan is the only trigger.

### 3.2 Order on the TV

For the Preferred Copy (spec §4.2: local Root first, then one that plays as-is under the TV profile, then larger resolution, then smaller size), the TV plays:

1. the Copy's **own file** through `/copy/:id` when the TV profile plays it;
2. else its **existing Fallback** (browser-made, at most one per Copy) when the TV profile plays that;
3. else a **Live remux** (§3.4).

The TV never asks the Fallback queue to make anything, so background Fallback and Thumbnail jobs never run for it.

### 3.3 Direct play

- Plain `<video src="http://‹mac›:4401/copy/:id">`, Range streaming exactly as on localhost. 4K plays in the same element; AVPlay is not used. HDR, 10-bit and 60 fps play as-is: no tone-mapping, no frame-rate conversion.
- **Seeks** snap to the keyframe index as the browser's do (spec §4.1): the TV fetches `/api/copies/:id/keyframes` once (202 while it is being built, the seek stays exact meanwhile) and lands 0.15 s past the nearest keyframe for the plain arrows; Chapters, Resume and the Copy switch stay exact.
- `requestVideoFrameCallback` fires only for the first frame on Tizen; the TV app uses `timeupdate` for everything after.

### 3.4 Live remux

Specified here, built last and deferrable (§9): no Copy in the library needs it today, since the one E-AC3 Copy already has an audio Fallback the TV plays. It exists for future files and for a profile change.

- An **HLS stream made on the fly** at `/live/:copyId/index.m3u8`: `-c:v copy`, audio copied or converted to AAC, `-noaccurate_seek`, `-ss <t>` before `-i`, about **10 s segments** cut at source keyframes, a **full-length VOD playlist up front** (`ceil(duration/10)` entries, a segment request blocks until the segment exists), encode about **60 s ahead** of the last request then pause the encoder, prune segments more than 300 s behind, and on a request outside the produced range **kill and restart** at `-ss` with the matching start number. Shape from Plex's copy mode (#46): about 100× realtime, 0.3 s to start or seek.
- **One at a time**: a new Live remux stops the previous one. It **bypasses the single ffmpeg queue** and the Thumbnail pool's gate, so nothing in the background delays the TV. It uses the arm64 ffmpeg.
- **Leaves nothing cached**: segments live in a temp dir that is deleted when the stream stops, the TV Server turns off, or the process exits.
- HLS through native `<video>` on Tizen is capped at 1080p (MSE is FHD-only); acceptable for the exception, another reason 4K stays on direct play.
- Until it is built, the decision function still returns "live remux" for such a Copy and the Player shows "This Copy needs the TV Server's remux (not built yet)" (§6.6).

---

## 4. Shell, discovery and install

### 4.1 The shell

- The installed app is a **thin signed shell** (`tv/shell/`, `.wgt`): `config.xml` with `<content src="index.html"/>`, the `internet` and `tv.inputdevice` privileges, `<access origin="*" subdomains="true"/>` (a Tizen access origin cannot be `http://*`; the address is only known at run time, so the discovery below is the restriction in practice), a permissive CSP meta tag as jellyfin-tizen ships, `webapis.js` injected, the olchey icon at 512×423 and app id `TuvaVideos.TuvaTV`.
- At launch it finds the TV Server (§4.2), then loads the UI **live from it**: `index.html` fetches `/tv.js` and `/tv.css` from the TV Server and runs them, so UI updates ship with the Mac code and only the shell needs the certificate. Tizen APIs stay available because the page is packaged, not hosted.
- The shell registers the media keys (MediaPlayPause, MediaPlay, MediaPause, MediaRewind, MediaFastForward, MediaTrackPrevious, MediaTrackNext), the four colour keys, ChannelUp/Down, Info and the digits 0–9 (the typed-address field needs them) with `registerKeyBatch` (Exit, long Back, stays unregistered and the system handles it), and maps every key through one table (§8) that the UI code shares.
- The UI is **Preact in `src/tv/`**, sharing `src/shared/` (resume, playingFrom, playlist, fold, filters, libraryView, playerMath, stripGeometry) and bundled by `src/server/web.ts` at start next to the browser bundle. The throwaway prototype in `tv/home-prototype/` and the hello-world in `tv/hello-world/` stay as history and are not shipped.

### 4.2 Discovery

In order, each step with a 2 s timeout:

1. the **last address** the shell stored (`localStorage`), `GET http://‹addr›:4401/api/health`;
2. a **sweep of the TV's own /24** on 4401 (the TV's address from `webapis.network`, else the last address's subnet), 32 requests in flight at a time;
3. **typed**: the shell shows a D-pad numeric field (digits, dot, Back deletes) for the Mac's address. The field is pre-filled with the TV's subnet (a bare `83` means `192.168.4.83`) and Up types the dot, since the remote has none. When nothing answers the looking screen sits on this step and offers the field with Enter (§4.3); the sequence keeps retrying every 5 s except while the field is open.

The first health answer naming "TuvaVideos TV Server" wins and is stored. The shell then requests `/api/videos`; a 403 shows "Approve this TV on the Mac" and retries every 3 s until the user clicks Allow.

### 4.3 Offline states

- No server found: **"Looking for TuvaVideos on the Mac…"** with the step it is on; retries the whole sequence every 5 s; Enter opens the typed field; Back exits the app.
- Server stops mid-session (health stops answering twice in a row, 5 s apart; the shell watches it after every success and the UI may call `window.tuvaTv.restart()` on a 403 or a dead stream): the shell shows **"TV Server turned off"** over the paused frame or the current screen, keeps the last Resume write, and offers Enter to look again (back to the discovery screen) or Back to exit.
- Denied (a 403 after an earlier success, or Remove in the menu): the same "Approve this TV on the Mac" screen.

### 4.4 Install and update

- `bun run tv-install` (`scripts/tv-install.ts`): `sdb connect ‹tv›` → `tizen build-web` → `tizen package -t wgt -s TuvaVideos` → `tizen install -n TuvaTV.wgt -t ‹target›` → `tizen run`. `tizen install-permit` runs once per certificate. Installing a newer version uninstalls the previous one. TV and target names come from `tv/shell/tv.json` (ip, target, duid), not from the code.
- **UI changes need no reinstall**: the shell loads the UI from the TV Server at every launch. Only changes under `tv/shell/` do.
- **Certificate renewal is a yearly chore, not automated** (it needs a Samsung account sign-in in Certificate Manager): the shell's README carries the checklist (quit Certificate Manager before `sdb connect`, Developer Mode on with the Mac's IP, Apps › App Settings › 12345, re-create the distributor certificate with the DUID, `install-permit`, reinstall). The expiry date **2027-10-14** is recorded there. A major Tizen upgrade may wipe sideloaded apps: reinstall after one. No in-app warning.

---

## 5. Home and navigation

Verdict of #50 (variant B "Rails"); the prototype's `tv/home-prototype/variants.ts` is the reference for geometry.

### 5.1 Home

- **Rails**, in order: **Favorites**, **Library** (most watched, with the browser app's Library filter and sort carried over from its URL state at launch), **Artists**, then **Continue watching** (Videos with a Resume position, most recent first), **Recently added**, **Concerts**, **Songs with lyrics**. Each rail ends in a **See all** tile that opens the full grid for that rail (§5.3). An empty rail is not shown.
- **Header**: **Search** and **Random** (plays a random available Video, as the browser's `r`).
- A **card** is the browser's: poster with the duration in the corner, a Resume progress line when one exists, the favorite star; title; Type and Artist tags. A **Song tile** (Songs with lyrics, Songs grid) shows the poster of its newest Video, the name with its English name dimmed, counts.
- **Focus** is the browser app's full-entry highlight: an inset accent ring (`--accent`) with a faint tint around the whole card, no scale, no glow. The focused rail scrolls its row; the focused card is kept in view with a margin.

### 5.2 Side pane

- **Back** on the home, or **Left** at the start of a rail, slides in a Netflix-style pane from the left: **Library** (with filter chips: Type, Favorites, Sort, direction; Enter cycles a chip), **Favorites**, **Artists**, **Songs**, **Search**, **Random**, **Shuffle** (starts a whole-library Playlist, §6.7). Each of the first four opens a full grid in the main area.
- **Right** closes the pane back to the grid or rails; **Back** inside the pane **exits the app** (Samsung remotes have no Menu key; Back is the convention).

### 5.3 Grids

- Six-column poster grids for Library (as filtered), Favorites, Artists, Songs, search results, a Song's Videos, an Artist's Videos, and each rail's See all. Windowed like the browser's grid.
- The first tile of every Video grid is **Shuffle** (§6.7): it starts a shuffled Playlist of the grid as filtered.
- **Favorites** mixes **Video tiles and Chapter tiles**: a Chapter tile shows the parent Video's strip frame at the Chapter's time, the Chapter title over the Video's title dimmed, and opens the Video at the Chapter; order is the order starred, as in the browser.
- **A Song anywhere** (search result, Song tile, the ♪ tag in the Player) opens the grid of its Videos, Chapters included; it never autoplays. An Artist tile opens the grid of their Videos.
- **Back** from a grid returns to where it was opened from (rails, pane, search results, Player).
- **Up** from the top row reaches the header (Search, Random) or the grid's chip row when it has one.

### 5.4 Playing from

Opening a Video from a rail, grid or search snapshots that list as **Playing from** (spec §4.4); `< >` (MediaTrackPrevious/Next) step through it. Random and a URL-less open use library order.

---

## 6. Player

Verdict of #51 (Player variant B "Overlay", reshaped) plus the control decisions of #53. The prototype's `tv/home-prototype/player.ts` and `styles.css` (the `pB-*` rules) are the reference for geometry, the backdrop and the timings.

### 6.1 Layout

- The **whole video stays visible**, letterboxed in the left column at the Copy's aspect ratio. When lyrics are shown, a **standalone lyrics column** stands on the right; it is not an overlay on the video.
- **Lyrics column width**: sized to its longest line measured unwrapped, between **720 and 1060 px**; past 900 px the type shrinks first (**44 px down to 34 px**) and only then does the column widen, so lines wrap only beyond both limits. The video column takes the rest.
- Shown **only when the current Chapter's (else the Video's) Song has lyrics**: one Script at a time, no line numbers, no current line (no timings exist), the lines paged by **Channel ▲▼**, "page n of m" at the foot. The lyrics follow the Chapter the playhead is in. The title (Song, English name dimmed) and the Version pills head the column, opening on the Chapter's Version else the first; Versions are not switched from the remote (later, §10).
- **Type size at 3 m**: 44 px with 10 to 12 lines visible is the starting value; **tuned on the real TV** in the Player build ticket's HITL step, and the result written back here.

### 6.2 Column backdrop

A living take on the Lyrics Website album-page backdrop:

- the Video's poster **blurred (48 px, saturate 2.4)** and slowly drifting underneath;
- the poster **sampled into a 12×12 canvas**, its **four most vivid hues** (25° apart or more) lifted to a fixed lightness (56 / 48 %) and saturation (≥ 65 %), driving **four radial blobs** that drift and breathe on 19 to 34 s cycles with screen blending; a grey poster (black-and-white footage) falls back to warm hues spread round the wheel;
- then a light vignette, a dark tint gradient and faint grain.

The text shadow stays tight (`0 1px 2px`): a wide one on dense 44 px text veils the backdrop. The poster `<img>` carries `crossorigin` so the canvas sample works from the TV Server's origin; the TV Server sends `Access-Control-Allow-Origin` for `/thumbs`.

### 6.3 Zones and keys

The Player has one base zone and four reachable ones. **Back** always closes the open zone first and leaves the Player second (back to where the Video was opened from).

| From the video (base) | |
|---|---|
| Left / Right | seek −/+ **10 s**; pressed again within a second **30, 60, then 120 s**, the step shown large in the middle of the video; MediaRewind / MediaFastForward 60 s |
| Enter / MediaPlayPause | pause and play |
| Up | **lyrics zone** (§6.4) |
| Down | **button row** under the scrub bar (§6.5) |
| Channel ▲▼ | page the lyrics |
| `<` `>` (MediaTrackPrevious / Next) | step Playing from, or the Playlist when one is active |
| Yellow / Blue | lyrics on and off / cycle Script (also reachable without the 123 panel, below) |

Held arrows are throttled as in the browser: one seek in flight, the latest target wins.

### 6.4 Lyrics zone and tag row (Up)

- **Up** from the video reaches the **lyrics zone** with the top band shown: there **Right pulls the lyrics column in** and **Left hides it** (the chosen two-press gesture, since the colour keys sit in the 123 panel). The band names the state ("Lyrics ▸" / "◂ Lyrics"); when the Song has no lyrics the zone says why and the arrows do nothing. Down or Back returns to the video.
- A second **Up** reaches the **tag row** in the top band (Type, Artists, ♪ Song, then the Copy's container/codecs/resolution/Root as text, and "Playing from ‹list›"): Left/Right walk the tags, **Enter on a tag opens the grid** of that Type / Artist / Song's Videos, leaving the Player. Down returns to the lyrics zone, Back to the video.

### 6.5 Button row and Chapter list (Down)

- **Down** from the video pins the bottom bar and focuses the **button row under the scrub bar**: **[Shuffle] [Repeat] [Copy]**. Left/Right move, Enter acts (§6.7 for Shuffle and Repeat), Up returns to the video, Back returns to the video.
- **Down again** opens the **Chapter list** when the Video has Chapters (nothing otherwise): a vertical list over the video's left edge with time, title, a ♪ note for a Chapter with a Song, a dashed "suggested" mark; the current Chapter marked and scrolled into view; Up/Down move, **Enter jumps** (exact seek), Back or Left closes back to the button row. The title band hides while the list is open.
- **Copy** opens a list in the same place: one row per Copy (container, codecs, resolution, size, Root), the playing one marked, a Copy the TV profile cannot play as-is marked **"via remux"** and greyed until Live remux is built. Enter switches **for this play only at the same timestamp**; nothing is remembered, as in the browser.

### 6.6 OSD

- A **Netflix-style bottom bar** that fades after **3 s** and is **pinned while paused or while a zone is open**: the current Chapter's title and span, **"Next: ‹title›" in the last 20 s** (the next Chapter, or the next Playlist Entry when one is active), time and duration, a scrub bar with Chapter ticks and the Resume marker, then the button row.
- A **top band** with the Video title, the tag row and "Playing from" shows with the bar.
- Shuffle and Repeat changes, the seek step, "Resuming at m:ss", "Playlist ended", "No chapters", a Copy switch and errors flash in the OSD.
- **"Press Enter to play"** shows when autoplay is refused and clears on the first `play` event. A Copy that fails shows "This Copy did not play (container codecs)"; a Copy needing a Live remux before it exists shows "This Copy needs the TV Server's remux (not built yet)". A Root that unmounts mid-play follows spec §4.2 (next Available Copy at the same time, else "Copy unavailable").

### 6.7 Playlist on the TV

The browser's Playlist (spec §4.8) **without the panel**; the pure state in `src/shared/playlist.ts` is reused as is.

- **Starts** from the **Shuffle tile** first in every Video grid (the grid as filtered: Library, Favorites with Chapter tiles giving Chapter Entries, search results, a Song's or Artist's Videos, a rail's See all), from **Shuffle in the side pane** (whole library), or from the **Shuffle button** in the Player with no Playlist active (whole library in library order from the current Video). It starts **shuffled** with Repeat **off**.
- **Shuffle button** with a Playlist active toggles the Play order; **Repeat** cycles off → list → one; both flash in the OSD and show their state on the button. Repeat shows "one" disabled when only Playing from.
- **Entries, order, Repeat, unavailable skipping, end-of-Entry and "jumps to that Entry when opened from elsewhere"** are exactly the browser's. "Next:" in the last 20 s names the next Entry. At the end with Repeat off: paused on the last frame, OSD "Playlist ended".
- **Lifetime**: ends when a Video outside it is opened or another shuffle starts; **not stored**: exiting the app ends it, a relaunch starts clean.
- Playing inside a Playlist never writes Resume.

### 6.8 Resume, views and audio

- Opens at the shared Resume position without asking ("Resuming at m:ss" in the OSD); a `?t`-style open from a Chapter tile or Chapter list is exact. Writes per §2.5.
- One view per Player visit.
- **Audio settings**: the Video's saved Audio settings are applied through the browser's Web Audio chain (`src/web/audioEngine.ts`, shared by moving it under `src/shared/` or importing it across). **If the R85H will not route `<video>` through Web Audio** (the Player build ticket tests this first), the TV plays the sound untouched and the tag row says "audio: untouched". No per-play preset on the TV (later, §10).

---

## 7. Search

- Opened from the header or the side pane. **On-screen keyboard** on the left, driven by the D-pad: Latin, Cyrillic (with ө ү ң) and digits layers, space, backspace, a layer switch; a physical keyboard types too. **Right at the keyboard's right edge** reaches the results.
- Results on the right from `/api/search`, grouped **Songs / Videos / Artists** (the browser's Tracks and Albums groups are not shown), the matched text marked, lyric line under a Song matched through lyrics, counts per group. The browser's folding and ranking apply unchanged.
- Enter on a **Video** plays it (Playing from = the results); on a **Song** opens the grid of its Videos; on an **Artist** the grid of theirs. Back from results returns to the keyboard, Back again leaves Search.
- No voice input, no typed-letter jump list.

---

## 8. Remote key table

Registered by the shell (§4.1); one map shared by the shell and the UI (`src/tv/keys.ts`), tested as a pure table.

| Key (code) | Home and grids | Player |
|---|---|---|
| Arrows (37–40) | move focus; Left at a rail's start opens the pane; Right closes it | base: seek; zones per §6.3–6.5 |
| Enter (13) | open | pause / play; act in a zone |
| Back (10009) | grid → where it came from; home → pane; pane → exit | close zone, else leave the Player |
| Exit (10182, long Back) | exit the app | exit the app |
| ChannelUp / Down (427 / 428) | page the grid | page the lyrics |
| MediaPlayPause (10252), MediaPlay (415), MediaPause (19) | — | pause / play |
| MediaRewind / FastForward (412 / 417) | — | ±60 s |
| MediaTrackPrevious / Next (10232 / 10233) | — | `<` `>` Playing from or Playlist |
| Yellow (405) | — | lyrics on / off |
| Blue (406) | — | cycle Script |
| Green (404) | — | Chapter list (same as Down, Down) |
| Red (403) | — | unused (the prototype's variant switch) |
| Info (457) | state overlay (debug; kept, dimmed) | state overlay |
| Digits (48–57) | typed-address field in the shell; otherwise unused | unused |

Nothing frequent lives only on a colour key: lyrics (Up, side arrow), Script (Blue), Chapters (Down, Down), shuffle and repeat and Copy (Down).

---

## 9. Implementation plan

Five chained task tickets (Claude Sonnet 5.5), each a PR on `task/<slug>` with `bun test` on the pure parts it introduces, `tsc --noEmit` clean, a scripted or hand smoke run recorded in a comment, and this spec amended in the same PR where it got something wrong. 3 and 4 need 1 and 2; 2 can run beside 1; 5 is deferrable.

1. **`tv-server`** (§2, §3.1–3.3): the second listener and the TV button, Approved TVs (migration, allowlist, prompt, menu, indicator), the fixed route list, `X-Tuva-TV`, CORS for `/thumbs`, the TV Playback profile as data with the pure decision and the per-Copy scan-time result (migration, stale-version re-judging), `/api/videos` carrying it, the Resume and view writes over the TV listener, the hard stop. Tests: route list (every unlisted route 404s on 4401), allowlist states, the decision over the census combinations and portrait files, profile-version staleness.
2. **`tv-shell`** (§4): `tv/shell/` with config.xml, discovery, offline states, key registration, loading the UI from the TV Server, `scripts/tv-install.ts`, `tv/shell/tv.json`, the README with the certificate checklist. HITL: Developer Mode, Certificate Manager. Serves a placeholder `/tv.js` until 3 lands.
3. **`tv-home`** (§5, §7, §8): `src/tv/` in Preact bundled by `web.ts`, the key map, focus engine, rails, side pane, grids (Shuffle tile, Chapter tiles), Search with the keyboard, Random, Playing from snapshots. Tests: the key map, the focus geometry, the Favorites tile builder.
4. **`tv-player`** (§6): layout, lyrics column and backdrop, zones, button row, Chapter and Copy lists, OSD, seeks with the keyframe index, Playlist without the panel, Resume and views, Audio settings with the Web Audio test and the untouched fallback. HITL on the TV: type size, the backdrop, Web Audio. Tests: seek acceleration, zone transitions, Playlist stepping through `src/shared/playlist.ts`, the "via remux" marking.
5. **`tv-live-remux`** (§3.4): the HLS Live remux endpoint, one at a time, bypassing the queue, temp segments, kill-and-restart on seek, the Copy list's "via remux" rows becoming playable. Deferrable: no Copy needs it today.

---

## 10. Later

Decided out of the TV build, kept as the next tickets when wanted:

- a **per-play Audio preset** picker on the TV (ADR 0004 allowed it; no place for it in the chosen Player);
- the **Playlist panel** on the TV ("show played", jumping to an Entry);
- a stored Playlist per Approved TV that survives a relaunch;
- **themes** on the TV;
- switching Versions from the remote;
- an in-app certificate-expiry warning;
- re-downloading 4K and AV1 Copies at 1080p (#61) is unrelated to the TV, which plays them as-is.

## 11. Out of scope

- Streaming away from home; any access from outside the home network; auth beyond the IP allowlist.
- Editing anything from the TV: Chapters, headers, Artists, Songs, lyrics, merges, Favorites, deletes, relocates.
- Studio playback, Rescan, screenshots, the Audio panel's wand, the State panel's editing actions.
- Video transcoding of any kind; tone-mapping; frame-rate conversion; AVPlay.
- Voice search; a typed-letter jump list; Tracks and Albums in TV search.
- Multiple TVs playing at once as a designed case (each Approved TV works; nothing arbitrates).
