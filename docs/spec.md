# TuvaVideos v1 specification

Assembled in [issue #17](https://github.com/IncoherentThoughts/TuvaVideos/issues/17) from every closed ticket of [map #1](https://github.com/IncoherentThoughts/TuvaVideos/issues/1). Vocabulary is `CONTEXT.md`; a capitalised word here (Video, Copy, Root, Chapter, Suggested, Mirror, Studio track…) carries the meaning given there. Where this document and a per-topic doc disagree, this document wins; the per-topic docs hold the reasoning and the prototypes.

Everything here is decided; the grilling in #17 closed every open item.

Source documents: [data-model.md](data-model.md) · [playback-architecture.md](playback-architecture.md) · [studio-playback.md](studio-playback.md) · [chapter-pipeline.md](chapter-pipeline.md) · [design-direction.md](design-direction.md) · ADRs [0001](adr/0001-mirror-referenced-by-uuid-without-foreign-keys.md), [0002](adr/0002-browser-video-element-not-mpv.md), [0003](adr/0003-studio-playback-through-music-app-automation.md) · research under `docs/research/`.

---

## 1. Product

A single-user, offline, macOS-only local player for a personal library of Tuvan music videos. One Bun + TypeScript process serves a browser UI on localhost: it scans two Roots (an external drive and the laptop), plays Copies in a plain `<video>` with mpv-style keys, and enriches Videos with Types, Artists, Chapters, lyrics and Studio tracks mirrored from the Tuvan Lyrics Archive.

### Standing constraints

- Single user. No auth. `localhost` only. macOS only.
- The app never touches the network. One-off scripts under `scripts/` may (yt-dlp, YouTube).
- SQLite is the only store. Mirror entities are read-only and refreshed by importing a newer archive backup.
- Thumbnails are cached locally so the library can be browsed while every Copy is unavailable.
- Local Copy always wins when both Roots are available.
- Chapters live only in the database; container files are never rewritten.
- Launch is one command that opens a browser tab.

### Library facts (2026-10-10)

| Root | Path | Files | Size |
|---|---|---|---|
| external | `/Users/evanwilliams/Desktop/Хөөмей` (moved off the drive 2026-10-10; was `/Volumes/General/хөөмей/Хөөмей`) | ~1930 | ~229 GB |
| local | `/Users/evanwilliams/Desktop/Khoomei/Videos` | 90 | 15 GB |

~2000 files total (Batch 7 added 2026-10-10: 636 mkv downloads of Performance ids missing from the library, all new ids, plus one `.info.json` per file), 220 YouTube ids with 2+ Copies, 12 ids present in both Roots, ~26 GB redundant (cleanup is #18, deferred). Containers: webm, mp4, mkv; codecs H.264 / VP9 / AV1 (16 files, Batch 6) with Opus / AAC / Vorbis; one E-AC3 file; ~13 unmerged yt-dlp partials. The external drive was returning I/O errors on 2026-10-10 (#21); v1 must work with it absent.

---

## 2. Storage and data model

Decided in #13 ([data-model.md](data-model.md)). The DDL there is normative.

### 2.1 Files on disk

`~/Library/Application Support/TuvaVideos/` (overridable by env var for tests):

| Path | Holds |
|---|---|
| `library.db` | the SQLite database |
| `thumbs/<video-id>.poster.webp`, `thumbs/<video-id>.strip.webp` | Thumbnails, one pair per Video |
| `remux/` | Fallback files, one per Copy that needs one |

`bun:sqlite`, numbered `.sql` migrations applied at startup, tracked with `PRAGMA user_version`, no ORM.

### 2.2 Entities

- **root** — path + kind (`local` / `external`).
- **video** — identity (`youtube_id` else `content_hash`), title, Latin title (+ source), Type (+ suggested flag), Song/Version uuids (+ suggested flag + source), `favorited_at`, `resume_s`, `last_played_at`, thumbnail bookkeeping.
- **copy** — one file in one Root: `rel_path`, size, mtime, ffprobe facts (duration, container, codecs, width, height, `r_frame_rate`), `playback` kind (`native` / `remux` / `transcode`), `fallback_file`, `missing_since`.
- **artist** / **video_artist** — Mirror Artists (with `mirror_id`) and Local Artists (NULL) in one table; ordered per Video.
- **chapter** — `start_s` + title (+ Latin), optional Song/Version, `suggested`, `source`, `favorited_at`. No end time: a Chapter runs to the next Chapter's start or the Video's end. Chapters carry no Artists in v1.
- **chapter_rejection** — tombstones `(video_id, source, start_s)`.
- **studio_track** / **studio_last** — see §7.
- **mirror_import** — one row per import with counts and dangling-ref count.
- **mirror_*** — song, version, artist, album, album_credit, track, track_artist, performance; DDL in `research/mirror-import-mapping.md`. `mirror_song.is_hidden` is kept (migration 0005).
- **search** — one FTS5 table (§6).

### 2.3 Rules

- **Identity**: the `[youtubeId]` in the filename; otherwise SHA-256 of the whole file (computed only for id-less files). Several files with one id are Copies of one Video.
- **Scan** (§3.2): new file → new Copy, new Video unless identity matches. Defaults from the Mirror: id on exactly one Performance → Type `song` with that Song Suggested (source `performance`); id on 2+ Performances → `concert`; else `other`. Skipped: `.fNNN` / `.part` / `.temp` partials, `._*`, non-video files. A rescan never overwrites an edited title, Type, Song or Artists. A file gone from a mounted Root sets `missing_since`; an unmounted Root changes nothing; a Missing Copy whose file returns clears `missing_since`.
- **Song pointers are columns**: one Song/Version per Video or Chapter; every Suggested value records its source. There is no per-Video track link; Studio tracks derive from the Song.
- **Favorites** are `favorited_at` on Video and Chapter. **Resume** is `resume_s` + `last_played_at` on Video. **View count** is `view_count` on Video (migration 0009): the Player posts one view (`POST /api/videos/:id/view`) the first time playback starts on a Now playing visit; `DELETE` resets it. It is not shown on cards or rows: the State panel reports it, the Library grid, Favorites and the search results page can sort by it, and a right-click on a Video in any list opens a small menu that shows and resets it. Nothing was imported from mpv: it keeps only resume positions, no play history.
- **Artists**: a Local Artist has `mirror_id` NULL. Created from the Artist chip editor (§5.3) when the search finds no Mirror Artist. Merged manually from the Artists tab (§5.1): "merge into…" with a Mirror Artist search rewrites `video_artist` rows and deletes the Local row. No automatic merge on import.
- **Suggested Artists** (the Artist matcher, `src/shared/artistMatch.ts`, migration 0006): a Video's title (and the uploader name when its YouTube info is cached) is cut into segments at the usual separators and brackets; every window of 1–4 words is folded (Cyrillic → Latin, `kh` → `h`, group words like "ensemble" / "группа" dropped) and scored with Jaro-Winkler against every name of every Artist. Accept at 0.90 (0.92 for a one-word name, same first letter, at least ¾ of its length); a window never has more words than the name; a shorter window needs two words aligned with the start or end of the name, each word alike (0.85, or one edit for words of three letters or fewer); generic words (tuva, khoomei, live…) match nothing alone; the near-tie rule is the Song matcher's (0.05). Rows land in `video_artist` with `suggested = 1`, dashed in the UI with a "suggested" mark and a ✓ that confirms them all; × on one rejects it (`artist_rejection` tombstone, never offered again). A Video with any confirmed Artist is left alone; otherwise its suggestions are replaced on every run. Runs for a new Video at scan, after every scan, after an import, and from `bun run suggest-artists [id] [--dry-run]`. Setting the Artists by hand confirms the list given and rejects the Suggested ones left out. 2026-10-11 library: 826 of 1733 Videos get a suggestion (940 rows; 101 Videos already curated).

### 2.4 Mirror import

- Source: a post-migration-129 backup of the archive (2026-10-07 or newer). Older band-shaped backups are unsupported.
- Imported: songs (hidden ones too: the archive's hidden flag is kept on `mirror_song.is_hidden` but means nothing here and is not shown; they carry a third of the Performance ids), song_lyrics, artists, albums, album_artists, album_tracks, album_track_artists, song_performances. Dropped: the archive's `zz_` test song and its rows, composers, bands, tags, history, profiles, staff/personal tables, and the columns listed in the research doc.
- **Re-import is one transaction**: delete every `mirror_*` row, insert the new set, upsert `artist` by `mirror_id`, write a `mirror_import` row. Local tables untouched; a dangling uuid stays and renders as "unknown song" / "unknown artist" (ADR-0001).
- After every import: rebuild the search index, run the Studio matcher (§7.3), run the Latin-title fill for rows whose source is `archive`.
- Trigger: CLI only, `bun run import <backup-dir>`. No import UI. A pre-migration-126 backup is refused. Song alternate titles and spellings are kept on `mirror_song`, indexed as their own search rows, shown dimmed under the Song title in the drawer, and read by the Song matcher through the shared `songNames` helper. The Various Artists sentinel gets no `artist` row; a Track whose Song is hidden stays on its Album with the Song link cleared. Performance defaults count distinct Songs, not Performance rows (#25).

### 2.5 Latin titles

A one-time task (and a step after import) fills `title_latin` on Videos and Chapters and `name_latin` on Local Artists: `archive` when tied to a Mirror Song/Artist (the archive's alternate spelling or transliteration Script, never `english_name`), else `table` through the transliteration table in [data-model.md](data-model.md#latin-titles). Titles already Latin stay NULL. Manual edits set `manual` and are never regenerated.

---

## 3. Server, scanning and streaming

### 3.1 Process shape

One Bun process on one port serves Range streaming, the JSON API and the static UI (#14). Children it may own: the ffmpeg queue (§3.4), the resident `osascript` child (§7.1).

Lifecycle in §9.

### 3.2 Scan

- At startup and on an explicit rescan, walk each mounted Root; for each new or changed (size/mtime) file run ffprobe once and store the per-Copy facts; compute SHA-256 only for id-less files.
- Root availability is a 1-byte read of a known Copy, never `readdir` (exFAT over FSKit returned EIO on `readdir` while reads worked).
- **Triggers**: startup, a "Rescan" button in the top bar, and a remount. No `fs.watch` (unreliable on exFAT). New files appear only on a Rescan or a remount.
- **Mount poll**: every 10 s the server does the 1-byte read on each Root. An unmounted Root that becomes Available triggers a scan of that Root; a Root that disappears flips its Videos to unavailable (and the Player follows §4.2).
- **Unmounted at startup**: the Root is skipped, its Videos are unavailable, no error is shown.
- **Progress**: a small top-bar indicator with files seen / probed while a scan runs.

### 3.3 Streaming

- Each Copy is served as-is from its path with `Accept-Ranges: bytes` and 206 responses. Range is mandatory (without it `seekable` is empty). Content-Type by extension (`video/webm`, `video/mp4`, `video/x-matroska`); Chromium sniffs the container anyway.
- A Copy whose `playback` is `remux` or `transcode` is served from its `fallback_file` instead.

### 3.4 Fallbacks and the ffmpeg queue

ffprobe at scan time decides `playback`:

| Condition | `playback` | Job | When |
|---|---|---|---|
| audio codec outside {aac, opus, vorbis, mp3, flac} (the E-AC3 file) | `transcode` | `-c:v copy -c:a aac` | at scan time, ≈19× realtime |
| ffprobe reports no format duration (the no-Cues case) | `remux` | `-c copy -cues_to_front 1` (mkv/webm) or `-movflags +faststart` (mp4), pairing a `.f251` audio sibling when present | lazily on first play, <1 s |
| otherwise | `native` | none | |

Written as cached files under `remux/` named `<copyId>.<ext>` (a transcode of a webm lands in mkv, since webm cannot hold AAC), never a live pipe. yt-dlp `.fNNN` partials themselves are skipped at scan (§2.3), so `remux` arises only for a normally named file without a duration; in the 2026-10-10 library no Copy needs it. A Copy whose Fallback is not ready answers `GET /copy/:id` with 503 + `Retry-After` and a JSON state; the UI polls `/api/copies/:id`. One ffmpeg queue, one job at a time; play requests go to the front, scan-time jobs fill the rest. A Copy whose Fallback is not ready plays after a "preparing" state with progress.

### 3.5 Thumbnails

One poster and one scrub strip per Video (not per Copy), from the Preferred Copy, settings from #9:

| Item | Setting |
|---|---|
| Poster | 1 frame at 10% of duration, 480 px wide, WebP q75 (~14 KB) |
| Strip | N = min(100, floor(duration_s)) frames at slice centres, 160 px wide, 10 columns × ceil(N/10) rows, WebP q40 (~190 KB) |
| Encoder | ffmpeg PNG piped to `cwebp` (local ffmpeg lacks libwebp) |
| Extraction | single pass `-skip_frame nokey` for H.264 under 30 min; seek-per-frame otherwise; 4 files in parallel |
| Whole cache | ~230 MB for ~1200 Videos |

Probe for no-video first; cap N at duration; treat I/O errors from the external Root as retryable, never as "no video". Strip geometry (frames, columns, rows, frame size) is recorded per Video in `video.strip_*` columns so the UI can map a timestamp to a tile; `strip_frames = 0` means poster only. "Newest first" means newest Copy mtime. When single-pass extraction yields nothing (too few keyframes), the pool falls back to seek-per-frame. The cache from #21 (`scripts/generate-thumbnails.mjs`, `manifest.json`) is the seed. The app generates missing Thumbnails itself after each scan, newest Videos first, in a pool of 4 ffmpeg processes separate from the Fallback queue (§3.4); the pool pauses while a play-requested Fallback job runs. A Video whose only Copies are unavailable waits for the next scan.

---

## 4. Player

Decided in #10 and #14 ([playback-architecture.md](playback-architecture.md), ADR-0002).

### 4.1 Element and seeking

Plain `<video src>` over the Range server. No MediaSource, no mpv IPC, no transcoding for Chromium-native codecs. Scrub drag is throttled: one seek in flight, latest pointer target wins; click-to-seek is unthrottled.

### 4.2 Copy selection

- **Preferred Copy**: local Root first, then `playback = native`, then larger resolution, then smaller size. The Player shows which Copy is playing and offers a picker that switches Copy for this play only at the same timestamp. Nothing is persisted.
- **Root unmounts mid-play**: switch to the next Available Copy in that ranking at the same timestamp; with none, overlay "Copy unavailable" and keep the Resume position.

### 4.3 Resume and autoplay

- Resume position is written every 5 s while playing and on pause, seek, Copy switch and leaving the page (`POST /api/videos/:id/resume`). A Video reopens at it without asking; within 30 s of the end counts as finished and is stored as 0. The Player's tick runs on a timer, not `requestAnimationFrame`, so a background tab keeps writing Resume and looping A-B (#24).
- Opening a Video autoplays; the poster shows until the first frame.

### 4.4 Playing from

`<` `>` step through a snapshot of the list the Video was opened from (grid as filtered and sorted, Favorites, search results), taken when the Player opens; library order when opened by URL. They skip Videos with no Available Copy and wrap at both ends (#24).

### 4.5 Keyboard

Keys are handled only while the Player container has focus. No native `<video controls>`. Bare keys only, never ⌘/⌃/⌥ chords, `preventDefault` on every handled key. `/` moves focus to search, `Esc` moves it back to the Player. `r` is global (any screen, outside a text field): it plays a random Available Video, never the one on screen, so pressing it from the Player keeps shuffling.

| Key | Action |
|---|---|
| space, p | pause / play |
| ← → | ±5 s |
| ↑ ↓ | ±60 s |
| ⇧← ⇧→ / ⇧↑ ⇧↓ | exact ±1 s / ±5 s |
| , . | frame step back / forward (OSD shows the frame number; needs `r_frame_rate`) |
| [ ] | speed ±0.1 (additive; departs from mpv) |
| { } | speed 0.5× / 2× |
| ⌫ | speed 1.0× |
| 9 0 | volume ±5 (departs from mpv's ±2) |
| m | mute |
| f | fullscreen the Player container (OSD and chapter strip stay, drawer hides) |
| l | A-B loop: set A, set B, off |
| ! @, PgUp PgDn | previous / next Chapter (no-op with OSD "no chapters" when the Video has none) |
| < > | previous / next Video in Playing from |
| r | random Available Video (also the top-bar **Random** button; global, not Player-only) |
| s | screenshot: the current frame drawn to a canvas and posted to the server, which writes `<title> @ <seconds>s.png` to `~/Desktop` (`TUVA_SCREENSHOT_DIR` only for tests) |
| o / O | OSD flash / always on |
| t | Studio playback (§7.4) |
| y | open / close the lyrics drawer (OSD "no lyrics" when neither the Chapter nor the Video has a Song) |
| a | Audio panel (also an "Audio" button, §4.7): the Video's Audio settings in the drawer slot; opening it closes the State panel and the lyrics drawer, and either of those closes it |
| i | State panel (also a "State" button): in the drawer slot while no lyrics are shown, under the Player when they are; `<video>` state, the last seeks with their latency, a key log (handled / passed, with the focused element) and this key table. Kept from the player prototype; stays on during Studio playback |

### 4.6 Visuals

The video box takes the Copy's own aspect ratio. A poster frame shows before first play. Hovering the bar shows the scrub-strip frame and timestamp above the pointer. Chapter ticks on the timeline; chapter cards use the same strip frames. Volume is an icon; the frame number sits beside the time while paused.

### 4.7 Audio settings

Many Copies are badly mixed, quiet, or carry sound on one channel only. The Audio panel (`a`, or the Audio button beside State) fixes that per Video, in the drawer slot, with live in/out level meters per channel at the top:

- **Channels**: routing (Stereo as recorded, Mono, Left or Right in both ears, Swap), balance, and a volume per output channel.
- **Equalizer**: seven bands (60 Hz low shelf to 12 kHz high shelf, ±12 dB). Built-in presets (Flat, Voice, Instruments, Old recording, Bright, Warm) and custom ones: "+ Save…" stores the current seven bands under a name; a custom preset can be overwritten by saving its name again or deleted from its chip. Built-in names are reserved.
- **Level**: a preamp (−12…+18 dB) and a leveler (a compressor with make-up gain; one amount slider).

The chain runs in the browser (Web Audio on the `<video>` element) and is built only when the Video has non-default settings or the panel is open, so untouched Videos play straight. Settings are per Video and persist across sessions (`video_audio`, written 400 ms after the last change; the defaults delete the row). Presets are shared across Videos (`audio_preset`). A double-click on any slider returns it to its neutral value; Reset in the header clears the Video's settings.

---

## 5. Screens and design

Decided in #11 and #12 ([design-direction.md](design-direction.md)). Direction "Wall": dark, high-contrast, hard-edged. Tokens and tag style there are normative.

### 5.1 Navigation

Top tabs: **Library**, **Now playing**, **Favorites**, **Artists**; a search box, a **Random** button (a random Available Video, `r`) and the Rescan button in the top bar.

**Artists tab**: every Artist with at least one Video (Mirror and Local), with Video count and the poster of their most recent Video; clicking opens the Library grid filtered to that Artist. Filter by name (folded, Latin or Cyrillic), by kind (all / archive / local); sort by name, Video count or latest Video; state in the query string (`/artists?q=&kind=&sort=&dir=`). Local Artists are marked and carry the "merge into…" action (§2.3). A Local Artist's name is edited in place (click it; `PATCH /api/artists/:id`); a Mirror Artist's name belongs to the archive and is not editable. The list fills the width as a multi-column grid. Mirror Artists with no Video are not listed.

**Songs tab** (`/songs`, `GET /api/songs`): every Mirror Song some Video or Chapter points at (confirmed or Suggested), with its English name, Video and Chapter counts, whether the archive holds lyrics for it, and the poster of its newest Video. Opening one follows the search dropdown's rule (§6.2): Now playing on the first Video performing it with the drawer open, else `/lyrics/:songId`. Filter by name, "with lyrics" only; sort by name, Videos, Chapters or latest Video; same multi-column grid.

**Favorites tab**: the same multi-column grid; filter by kind (Videos and Chapters / Videos / Chapters), Type, availability and title; sort by date starred (default, newest first), title, duration, date added or views (`/favorites?show=&type=&available=&q=&sort=&dir=`).

### 5.2 Library

Full-bleed poster grid. Card: Thumbnail with duration in the corner and a coloured left edge for availability; title with inline favorite badge; tint tags (Type first, then Artists); meta row of availability icon, chapter count and resolution.

**Filters**: chips for Type (song / concert / interview / other), Availability (available only / all) and Favorites; Artist filter set from the Artists tab or a search filter. **Sort**: title, duration, date added, last played, views; default date added, newest first. Filter and sort state live in the URL query so a reload keeps them. The grid, the Favorites list and the Artists tab are keyboard-walkable: arrows move focus, Enter opens, `f` toggles Favorite on the focused card or row.

A Video's index row carries its linked Song's name and English name after the titles (+3, like an English title), so a Song search lists the Videos linked to it, confirmed or Suggested; Video rows and Library cards show the Song as a tag, dashed with a "suggested" mark while the link is only Suggested.

**Typed filters**: the same filters can be typed into the search box, no clicking needed: `#available`, `#fav`, `#type:concert`, `#artist:Radik_Tyulush` (underscores for spaces, matched against folded Artist names), and the group filters of §6.2. A query made only of filters, committed with Enter, applies those filters to the Library grid (written to its URL state) and closes the dropdown. Filters followed by search text, without Enter, just narrow the dropdown results. Enter on a highlighted row always opens that row.

### 5.3 Now playing

Its own screen. Big Player (§4) with chapter ticks; title; row of availability icon, favorite badge, Type and Artist tags; horizontal filmstrip of Chapter cards (strip frame, timestamp, ♪ when the Chapter has a Song, "suggested" mark, title). Suggested Chapter cards offer confirm / reject / attach Song; per Video, confirm all. Studio bar under the video (§7.4). Lyrics drawer on the right (§5.4).

**Manual Chapters** (keyboard-first): `c` adds a Chapter at the playhead; the new filmstrip card opens with an inline title field (Enter saves, Esc cancels). A focused card offers: edit title inline; **edit the timestamp by typing it** (`m:ss` or `h:mm:ss`, also accepts a bare seconds number) in the card's time field; `.` sets the Chapter's start to the playhead; `←` `→` nudge the start ±1 s and seek the Player to the new start so it can be heard; attach a Song through the search box scoped to Songs (with the Version pills when the Song has several); `⌫` deletes after a confirm. Deleting a Suggested Chapter is a rejection (tombstone, §8); deleting a confirmed or manual one leaves no tombstone. Keys inside a card go to the card, not the Player (focus rule, §4.5).

Decided in #26: `c` creates the Chapter at once (source `manual`, untitled) so the card exists; Esc on its title field deletes it again (no tombstone), Enter saves and gives focus back to the Player, and anything typed between `c` and the card opening is kept for the title. Card keys: Enter/`e` title, `t` time field, `.` start to playhead, `←` `→` ±1 s (held keys accumulate; each step seeks), `s` Song picker, `⌫` delete behind an inline confirm, `y` / `x` confirm / reject a Suggested Chapter, `f` Favorite, Space seek, Esc back to the Player. A start that is already taken (`UNIQUE (video_id, start_s)`) is refused with a message, never nudged. Editing the title or start of a Suggested Chapter confirms it (it is the person's now); moving it also tombstones the old start so the suggestion does not return there. Attaching a Song does not confirm. Starts are stored to the millisecond. The lyrics drawer follows the Chapter the playhead is in (no remount, no focus grab); a Version pill badged "· this chapter" needs the Chapter's `version_id` set with its pills.

**Video metadata is edited inline on the header**: click the Type tag → menu of the four Types; click the title → text field; a "Song:" row opens the Songs search (and Version pills); click the Artist row → a chip editor with an Artist search. When the search finds no Mirror or Local Artist, the editor shows a clearly marked **create action** (a plus icon with "add 'X' as local artist") distinct from the match rows, so creating is never mistaken for matching. Edits set the Suggested flag off and the source to `manual`; a rescan never overwrites them.

### 5.4 Lyrics drawer

Closable right drawer, variant "Reader" (#12). Header: Song title with English title dimmed; a Script segmented control (Cyrillic / Latin / English) showing one Script at a time, disabled when the Version lacks it, choice clamped to a Script the Version has. When the Song has several Versions, a row of pills; the Chapter's Version badged "· this chapter"; opens on the Chapter's Version else the first in display order. Numbered lines continuous across stanzas with blank lines as spacers. No current line (no timed lyrics exist). Footnote markers are superscript accent digits; adjacent markers get a CSS comma; a marker with no entry is struck through; hover/focus shows a two-column tooltip; click jumps to the entry and flashes it; `[` `]` cycle markers while the drawer has focus (the Player's speed keys apply only while the Player has focus; focus is the dispatcher, as for `/` and Esc). A "Footnotes" section at the bottom lists the shown Script's entries.

Rendering port: the archive's `scripts.ts`, `normalize.ts`, `markers.ts` regex core, `trackVersion.ts`, `highlightSnippet`, with its sanitizer allowlists (`LINE`: `p br b strong i em u s sub sup span`; `FOOTNOTE`: `b strong i em u br sub sup`) applied by a dependency-free server-side tokenizer, not DOMPurify (#25). A Song no Video performs opens at `/lyrics/:songId`. One `<p>` is one line; `<p class="ln-blank">` is a stanza break.

Which Song the drawer shows: the current Chapter's Song (the Chapter the playhead is in), else the Video's Song, else the drawer is empty with "no lyrics".

### 5.5 Favorites

One dense list (not grid cards) of Videos and Chapters ordered by `favorited_at`, newest first, with a chip to show Videos / Chapters / both. Favorites is a Playing-from list.

- **Video row**: poster, title, duration, Type and Artist tags, availability icon.
- **Chapter row** (more compact): the parent Video's thumbnail showing the strip frame at the Chapter's time, the Chapter title, then the parent Video's title in `--fg2`; **under the thumbnail a slim progress bar in the accent colour with a small gold (`--t3`) marker at the Chapter's position** within the Video. Opening it plays the Video from that Chapter.

### 5.6 Availability and brand

Laptop icon (green `--t4`) for a local Copy, external-drive icon (blue `--t6`) for an external one, dashed grey drive when unavailable; icons only, text on hover. Favorite: outline star in a tinted rounded square (`--t3`). Brand: the olchey favicon, no wordmark. Base type size 16 px; the Song chip is clicked to change the Song, with one × beside it to clear; Version pills appear in the header only right after a Song with several Versions is chosen (until one is picked); otherwise the drawer's Version pills set the Video's Version; "Add at playhead" sits by the Chapters heading; the playing Copy in the picker is a tinted row, no edge bar; the Now playing metadata rows a notch larger than body text. Dashed borders mark Suggested items only (Type tag, Song chip, Chapter card, Studio row); the confirm tick, the empty Favorite star and the "add as local" row are solid. A Video with a `youtube_id` shows a dim "YouTube: youtube.com/watch?v=…" line under the Chapter strip that opens the page in the browser (the app itself stays offline).

### 5.7 Component inventory

| Component | Used by |
|---|---|
| TopBar (tabs, SearchBox, Random, Rescan, scan indicator) | all screens |
| SearchBox + ResultsDropdown (groups, rows, filter chips) | TopBar |
| Tag (tint / dashed Suggested), AvailabilityIcon, FavoriteBadge, Thumbnail (poster / strip-frame) | everywhere |
| FilterChips, SortMenu | Library, Favorites |
| VideoCard (grid) | Library |
| FavoriteVideoRow, FavoriteChapterRow (with ChapterPositionBar) | Favorites |
| ArtistRow (+ MergeInto) | Artists |
| Player (video, Timeline with chapter ticks + hover frame, OSD, CopyPicker, PreparingOverlay, UnavailableOverlay) | Now playing |
| VideoHeader (editable Title, TypeMenu, SongRow, ArtistChipEditor with CreateLocalArtist) | Now playing |
| ChapterStrip + ChapterCard (view / edit modes, Suggested actions, ConfirmAll) | Now playing |
| StudioBar (track list, match search, scrubber) | Now playing |
| LyricsDrawer (ScriptControl, VersionPills, LyricLines, FootnoteTooltip, Footnotes) | Now playing |
| SongSearch, ArtistSearch (shared pickers over the search index) | VideoHeader, ChapterCard, StudioBar |

---

## 6. Search

Decided in #13 (index) and #12 (behaviour).

### 6.1 Index

One FTS5 table `search(kind, ref_id, text, text_folded)` with `tokenize = 'unicode61 remove_diacritics 2'`, rebuilt after every scan, import and Latin-title run. Rows: Video titles, Chapter titles, Artist names, Song names (+ alternate titles and spellings), and lyric text one row per line per Script per Version, HTML stripped. `text` holds original and Latin title together; `text_folded` holds an ASCII form (ŋ → ng, ö/ü → o/u, `x` also indexed as `kh`).

### 6.2 Results

Dropdown under the search box, groups in fixed order with counts: **Songs, Videos, Artists, Tracks, Albums**. Chapters appear inside the Videos group as "Video title › Chapter title" rows and open the Video at that Chapter. Row: name with matches in a yellow `<mark>`, a mono type label (Video rows add duration; Song rows add "· lyrics" when only lyrics matched; Track rows add album and "by Artist"), and a "Lyrics:" line with the whole first matching lyric line. A Video row names the Songs it performs. Choosing a Song or a Track with a Song opens its lyrics; choosing a Video opens Now playing.

Filters `#songs` `#videos` `#artists` `#tracks` `#albums` anywhere in the query restrict groups; `#lyrics` matches lyric text only; a bare `#videos` lists every Video. Active filters show as chips; a filtered group shows up to 40 rows instead of 8. Keys: `/` focuses, ↓ ↑ walk rows across groups, Enter on a highlighted row opens it, Esc closes. **Enter with no row highlighted** (a text query, not filter-only) opens the **results page** `/search?q=`: every Video the query matches (a Chapter match stands for its Video), laid out exactly like the Library grid, in rank order, as a Playing-from list, followed by the Videos performing a matched Song (by name or by lyrics). Each card marks why it matched: the match in the title (or the Latin title), up to two matching Chapter titles with their timestamps, the Song name, and the first matching lyric line. The dropdown never writes the query to the URL, only this page does.

Ranking: exact 0 / prefix 1 / word-start 1.5 / contains 2, +3 for a match on an English title, +4 on an alternate title or spelling, lyrics-only 5. Lyrics are searched only from 3 characters. Matching folds Cyrillic ↔ Latin both ways (`saryg` → Сарыглар, `x` ≈ `kh`, `ŋ`/`ñ` → `ng`); fold once at index time, never per keystroke. FTS5 (prefix queries on `text` and `text_folded`) supplies the candidates; the scorer above orders them within each group in TypeScript. No `bm25`.

---

## 7. Studio playback

Decided in #15 ([studio-playback.md](studio-playback.md), ADR-0003) on #4.

### 7.1 Mechanism

JXA against Music.app through one resident `osascript -l JavaScript` child started on first use, commands on stdin, restarted if it dies. Tracks by persistent ID: `play(track, {once:true})`, `pause()`, `playerPosition` for seek; `playerState / playerPosition / currentTrack.persistentID` polled at 1 Hz (4 Hz during an A-B loop). The server reads `playerState()` once at launch so the macOS Automation prompt appears predictably; a refused command shows "Music.app refused — check System Settings › Automation" and ends Studio playback. MusicKit JS and browser `<audio>` are rejected.

### 7.2 Library dump

One bulk JXA read of `{persistentID, name, album, artist, albumArtist, duration, cloudStatus}` for all tracks, cached on disk, refreshed after each Mirror import and on any persistent-id miss. Filter on `cloudStatus`, never on the localized `kind`.

### 7.3 Studio tracks and the matcher

- A Video's or Chapter's Studio tracks derive from its Song: Song → Mirror Tracks → each one's match, plus the Song's Local Studio tracks. One match per Mirror Track.
- **Matcher** runs over every Mirror Track after each import: key = normalized (name, album) (NFKD, strip diacritics, casefold, drop parentheticals, collapse punctuation/whitespace) against the dump; one hit → Suggested; several → narrow by duration ±3 s then artist token overlap; name-only hits are offered, never auto-matched.
- **Miss UI**: the Studio bar lists each Track of the Song with its match state and a search box over the dump: "match this Track" (confirmed match) or "add to Song" (Local Studio track). A Song with no Tracks and no Local Studio track shows "no studio tracks".
- **Absorption**: a Local Studio track whose persistent id equals a fresh match for one of the Song's Mirror Tracks becomes that match automatically.
- **Stale id**: lookup miss → re-dump, re-match; a confirmed match is touched only once its id has left the dump, and then drops to Suggested. A rejected Suggested match is remembered in `studio_rejection` (migration 0004) so the next import does not suggest it again; `no longer available` tracks are excluded from matching and search (#27).
- **Order**: matched Mirror Tracks by album then track number, then Local Studio tracks by `added_at`. `t` starts `studio_last` for the Song, else the first with a match.
- Pre-implementation task: run the matcher over the Mirror and record the hit rate; smoke-test play/seek including a stream-only track.

### 7.4 Player behaviour

Trigger: a "Studio" button and the key `t`. The Video pauses on its frame; a slim scrubbable Studio bar under the video shows track, album, position/duration and progress. `t` or Esc stops Music.app and returns to the Video, still paused. Inside a Chapter, the Chapter's Song's tracks are used, else the Video's Song's. While the bar is active: space, ← → ±5 s, ↑ ↓ ±60 s and `l` retarget to Music.app; 9/0 and m stay on the browser; everything else is a no-op with an OSD notice. Click seeks, drag is throttled. If polling sees another track or `stopped` after the `once` play ends (2.5 s grace after each play), Studio playback ends silently and the Video stays paused; a pause from outside does not end it. Shift-arrows retarget like the plain arrows. Music.app pauses itself after ~7–10 backward seeks, so the A-B loop resumes a pause that lands within 2 s of its own jump (#27). The launch-time `playerState()` read opens Music.app if it is not running.

---

## 8. Chapter pipeline

Decided in #16 ([chapter-pipeline.md](chapter-pipeline.md)) on #5.

1. **Fetch** (`scripts/`, online): per eligible Video one yt-dlp call (`--skip-download --write-info-json --write-comments`, `max_comments=200,200,0,0`, `comment_sort=top`, `--sleep-requests 1`, 5 s between Videos) writes `<id>.info.json` (YouTube info) to a cache outside the app. Resumable; cached ids skipped unless forced. A second pass with `max-replies-per-thread=5` only where stage 2 found nothing.
2. **Suggest** (in the app, offline, re-runnable): reads the cache plus Mirror Performances, parses, matches Songs, writes Suggested Chapters.

**Eligible**: Type concert, any Video with a YouTube id over 20 min, plus an explicit id list.

**Sources**: description block (parser from #5, ≥3 ascending entries) wins; else best comment block (pinned/uploader first, then likes, then entry count); Performance `t=` offsets always become Suggested Chapters with the Song attached and the Song's name as title, merged with a text Chapter within ±15 s (text supplies time and title, Performance supplies Song). yt-dlp's `chapters` field is unused. No Chapter at 0:00 is invented.

**Song matcher**: fold both sides (NFKD, strip diacritics, casefold, Cyrillic → Latin by the transliteration table, ŋ → ng, x/kh folded, parentheticals and punctuation dropped), Jaro-Winkler: ≥0.80 among Songs linked to the id through Performances, ≥0.90 Mirror-wide; near-tie (gap <0.05) attaches nothing and is reported. Thresholds tuned on the #5 sample.

**Re-runs**: same-source Suggested Chapters on a Video are replaced wholesale; a suggestion within ±10 s of a confirmed or manual Chapter is dropped; a rejection is a tombstone in `chapter_rejection` and never returns.

**Trigger**: CLI only, `bun run suggest-chapters [ids]`; the YouTube-info cache path is `TUVA_YT_CACHE`, defaulting to `~/Library/Application Support/TuvaVideos/youtube-info/`.

Decided in #26: the parser strips a leading bullet or dash (`- 0:10 Song`), which the #5 reference parser did not; an entry with no title is kept with an empty title. A run replaces every automatic Suggested Chapter (`description`, `comment`, `performance`) of each Video it looks at, not only those of the source it just used, because a run regenerates all three; a Favorite on a replaced Chapter passes to the new one at the same start (±1 s). Rules run before the matcher, so the report counts only Chapters that were written. A merged Chapter keeps the text source (the tombstone and the ±10 s rules use it); a Performance with no text entry within ±15 s is its own `performance` Chapter. The suggest step looks at every Video with cached YouTube info or a Performance carrying `t=`; Videos with cached info and no block are listed in `<cache>/no-block-ids.txt`, which `scripts/fetch-youtube-info.ts --replies` reads (extractor `max_comments=1000,200,800,5`, one marker file per id). Thresholds stay 0.80 / 0.90 / 0.05 (see the #26 comment for the sample numbers); `--linked`, `--mirror` and `--near-tie` override them for tuning runs. Endpoints: `GET|POST /api/videos/:id/chapters`, `PATCH|DELETE /api/chapters/:id`, `POST /api/chapters/:id/confirm|reject`, `POST /api/videos/:id/chapters/confirm-all`.

---

## 9. Launch and lifecycle

- **Start**: `bun run start` (alias `tuva`) starts the server on port **4400** (`TUVA_PORT` overrides, for tests only), then opens `http://localhost:4400` in the default browser. If a TuvaVideos health endpoint already answers on the port, it only opens the tab.
- **Logs**: stdout and `~/Library/Application Support/TuvaVideos/log.txt`.
- **Stop**: Ctrl-C. SIGINT lets the ffmpeg job in flight finish, kills the osascript child, checkpoints SQLite, exits.
- **Startup order**: migrations → Root availability → scan of mounted Roots (in the background) → Music.app `playerState()` read for the Automation prompt → open the tab.
- **UI stack**: Preact + TypeScript bundled by Bun, hand-rolled history routing: `/` Library, `/play/:videoId[?t=]` Now playing, `/favorites`, `/artists`, `/songs`; filters and sort in the query string. Tabs in this order: Now playing, Library, Songs, Artists, Favorites.

---

## 10. Implementation plan

Six task tickets (Claude Sonnet 5.5), in order, each leaving a working app:

1. Server, schema and migrations, scan, mount poll, Range streaming, Fallback queue, Thumbnails, launch script.
2. Library grid, Artists tab, Favorites list, search index and dropdown with typed filters, keyboard navigation.
3. Player: keys, OSD, Copy picker, Resume, Playing from, fullscreen, screenshots.
4. Mirror import CLI, Latin-title fill, lyrics drawer.
5. Chapters: filmstrip, manual editing, Suggested review, the Suggest CLI step and the fetch script.
6. Studio playback: osascript child, dump, matcher, Studio bar, miss UI.

**Definition of done** for each: `bun test` unit tests on the pure parts (folding, transliteration, Song and Studio matchers, timestamp parser, Copy ranking, Chapter merge rules) plus a scripted smoke run against the real library. Player key handling is verified by hand (already exercised in the prototype), not automated.

## 10a. Pre-implementation and one-off tasks

- Thumbnail cache completion once the external drive reads again (#21).
- Duplicate Copy cleanup (#18, deferred; needs the drive).
- Music.app matching trial and play/seek smoke test (§7.3).
- Chapter fetch over eligible Videos (§8 stage 1).
- Latin-title fill (§2.5).
- Mirror import from the 2026-10-07 backup or newer (§2.4).
- `scripts/download-missing-youtube.sh` with `missing-youtube-ids.txt` (665 Performance ids with no Copy; `research/missing-youtube-performances.md`) is a library-growth tool, not part of the app.

---

## 11. Out of scope for v1

- Timed (karaoke) lyrics — no per-line timestamps exist.
- Writing Chapters into mkv/mp4 containers.
- Menu bar app or login item.
- Syncing any edit back to the Tuvan Lyrics Archive.
- Auth, multi-user, non-macOS.
- MusicKit JS / in-browser audio for Studio tracks.
- A settings table or settings UI (screenshot folder, ports and paths are fixed or env vars).
- Artists on Chapters.
- Per-Video Copy pinning.
- The Ledger-style command filter prompt (`:fav`, `:type=concert`) — parked; the `#` typed filters (§5.2) cover the need.
- Archive images (133 artist/album pictures in the backup) — dropped from the import.
- Album covers on Studio tracks — wanted later; the likely source is Music.app artwork over JXA, not the archive images.
