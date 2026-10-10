# Playback architecture

Decided in [issue #10](https://github.com/IncoherentThoughts/TuvaVideos/issues/10), building on the research in #3 and #2. The prototype that settled it lives on branch `prototype/player` (`docs/prototypes/player.prototype.mjs` + `player.prototype.html`; `node docs/prototypes/player.prototype.mjs` → http://localhost:4412).

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
- **Screenshots** are PNGs named `<title> @ <seconds>s.png` into a user-settable folder.
- The lyrics drawer tabs between State and Lyrics in the prototype; the real drawer is Lyrics only.
