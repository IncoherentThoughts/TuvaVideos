# Playback architecture

Decided in [issue #10](https://github.com/IncoherentThoughts/TuvaVideos/issues/10), building on the research in #3 and #2, and ratified with the rules below in [issue #14](https://github.com/IncoherentThoughts/TuvaVideos/issues/14) (why not mpv: [ADR-0002](adr/0002-browser-video-element-not-mpv.md)). The prototype that settled it lives on branch `prototype/player` (`docs/prototypes/player.prototype.mjs` + `player.prototype.html`; `node docs/prototypes/player.prototype.mjs` → http://localhost:4412).

## Verdict

- **Plain `<video src>` against a Range-capable localhost server.** No MediaSource, no mpv IPC, no transcoding for Chromium-native codecs. Key seeks land in 28–170 ms on everything up to 1080p30, external Root included; 1080p60 VP9 is the only sticky case (~0.3–0.6 s) and is tolerable.
- **Scrub throttle**: while dragging, one seek in flight, the latest pointer target wins when it lands. Click-to-seek is unthrottled.
- **Fallbacks are one-time cached files, never a pipe.** ffprobe at scan time decides: audio codec outside {aac, opus, vorbis, mp3, flac} → `-c:v copy -c:a aac` into the cache at scan time (≈19× realtime, 35 s for an 11-min file); missing duration / no Cues (yt-dlp `.fNNN` partials) → `-c copy -cues_to_front 1`, pairing the `.f251` audio sibling when present, lazily on first play (<1 s).
- **Availability** of a Root is a 1-byte read of a known Copy, not a directory listing (exFAT over FSKit returned EIO on `readdir` while reads worked).
- **Per-Copy metadata to store from ffprobe**: codecs, duration, resolution, `r_frame_rate` (frame step and frame numbers need it).

## Player behaviour

- **Keyboard capture rule**: keys are handled only while the player container has focus. No native `<video controls>` (the element would swallow space, arrows, m, f). Bare keys only; never ⌘/⌃/⌥ chords. `preventDefault` on every handled key. `/` moves focus to search, `Esc` moves it back to the player. Nothing in the binding list is swallowed by Chromium; Brave has no bare-key shortcuts outside text fields.
- **Bindings** (mpv, with two deliberate departures): space/p pause · ←→ ±5 s · ↑↓ ±60 s · ⇧ arrows exact ±1/±5 s · , . frame step (reports the frame number) · [ ] speed **±0.1 additive** (mpv's ×0.9/×1.1 never returns to 1.0) · { } 0.5× / 2× · ⌫ 1.0× · 9/0 volume **±5** (mpv's ±2 is too fine) · m mute · f fullscreen · l A-B loop (A, B, off) · ! @ and PgUp/PgDn chapter prev/next · < > prev/next Video · s screenshot · o / O OSD flash / always.
- **Visuals**: the video box takes the Copy's own aspect ratio (no fixed 16:9 pillarbox); a poster frame from ~10% in shows before first play; hovering the bar shows a frame from the scrub strip and the timestamp above the pointer; chapter cards use the same strip frames. Volume is an icon, the frame number sits beside the time while paused.
- **Screenshots** are PNGs named `<title> @ <seconds>s.png` written to `~/Desktop`. Not settable in v1; there is no settings table.
- The lyrics drawer tabs between State and Lyrics in the prototype; the real drawer is Lyrics only.

## Playback rules (issue #14)

- **Preferred Copy**: local Root first, then `playback = native`, then larger resolution, then smaller size (#13). The player shows which Copy is playing and offers a picker that switches Copy for this play only, at the same timestamp; nothing is persisted.
- **Fallback not ready**: a Copy whose Fallback has not been made yet (the Root was unmounted during the scan, or the queue is behind) starts its ffmpeg job on demand; the player shows "preparing" with progress and starts playback when the file lands. One ffmpeg queue, one job at a time, play requests go to the front; scan-time jobs fill the rest.
- **Root unmounts mid-playback**: switch to the next Copy in the Preferred-Copy ranking that is Available, at the same timestamp; with none, overlay "Copy unavailable" and keep the Resume position.
- **Resume position**: written every 5 s while playing and on pause, seek, Copy switch and leaving the page. Reopen at it without asking; a position within 30 s of the end counts as finished and reopens at 0.
- **Playing from**: `<` `>` step through the list the Video was opened from (grid as filtered and sorted, Favorites, search results), captured as a snapshot when the player opens; library order when opened by URL.
- **Chapter keys without Chapters**: no-op with an OSD "no chapters".
- **Opening a Video autoplays**; the poster shows until the first frame.
- **`f` fullscreens the player container**, so the OSD and chapter strip stay and the drawer hides.
- **Process shape**: Range streaming, the JSON API and the static UI come from the one Bun process on one port.
