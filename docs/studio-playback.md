# Studio playback

Decided in [issue #15](https://github.com/IncoherentThoughts/TuvaVideos/issues/15), building on the research in #4 (why Music.app over osascript and not MusicKit or in-browser audio: [ADR-0003](adr/0003-studio-playback-through-music-app-automation.md)). Terms: Studio track, Local Studio track, Studio playback in `CONTEXT.md`.

## Mechanism

- **JXA against Music.app** through one resident `osascript -l JavaScript` child, started on the first Studio playback, reading commands on stdin, restarted if it dies. Tracks are addressed by persistent ID: `play(track, {once: true})`, `pause()`, `playerPosition` for seek, `playerState()` / `playerPosition()` / `currentTrack.persistentID()` polled at 1 Hz, 4 Hz while an A-B loop is active.
- **MusicKit JS and browser `<audio>` are rejected** for v1 (925 FairPlay files, 1638 stream-only tracks, paid developer account, second id space).
- **Automation consent**: the server reads `playerState()` once at launch so the macOS Automation prompt appears at a predictable moment. On a refused or failed command the Studio bar shows "Music.app refused — check System Settings › Automation" and Studio playback ends.
- **Library dump**: one bulk JXA read of `{persistentID, name, album, artist, albumArtist, duration, cloudStatus}` for all tracks, cached on disk, refreshed after each Mirror import and whenever a persistent id lookup misses. Never branch on `kind` (localized); filter on `cloudStatus`.
- The play and seek commands were not exercised in #4: the implementation ticket owes a smoke test, including a stream-only subscription track.

## Studio tracks

- A Video's or Chapter's Studio tracks are **derived from its Song**: Song → the Song's Mirror Tracks → each one's match, plus the Song's Local Studio tracks. There is no per-Video track link (#13's `track_id` columns are gone).
- **Studio matcher** runs over every Mirror Track after each import: key = normalized (name, album) (NFKD, strip diacritics, casefold, drop parentheticals, collapse punctuation and whitespace) against the dump; one hit → a Suggested Studio track; several → narrow by duration ±3 s then artist token overlap; name-only hits are offered, never auto-matched (#4). Suggested behaves as confirmed until rejected.
- **Miss**: the bar lists each Track of the Song with its match state; a search box over the dump lets the user pick a Music.app track — "match this Track" when a Mirror Track is selected (confirmed match), "add to Song" otherwise (Local Studio track). Allowed on Songs that already have Tracks. A Song with no Tracks on the archive and no Local Studio track shows "no studio tracks".
- **One match per Mirror Track**; multiplicity comes from the Song having several Tracks.
- **Absorption**: after an import's matching pass, a Local Studio track whose persistent id equals a fresh match for one of the Song's Mirror Tracks becomes that match (row gains `mirror_track_id`), automatically.
- **Stale persistent id** (library rebuild): `whose({persistentID})` empty → re-dump, re-match that Track; a confirmed match that now resolves differently drops to Suggested.
- **Order**: matched Mirror Tracks by album then track number, then Local Studio tracks in the order added. `t` starts the Song's remembered last-played Studio track (`studio_last`), else the first with a match.

## Player behaviour

- **Trigger**: a "Studio" button on the Studio bar and the bare key `t`. On start the Video pauses on its frame; a slim scrubbable Studio bar under the video shows track name, album, position/duration and a progress bar; `t` again or Esc stops Music.app and returns to the Video, still paused at the same timestamp. No new screen.
- **Chapters**: Studio playback from inside a Chapter plays the Chapter's Song's Studio tracks, else the Video's Song's, else "no studio tracks". The current Chapter is the one the playhead is in.
- **Keys while the bar is active**: space, ← → ±5 s, ↑ ↓ ±60 s and `l` A-B loop retarget to Music.app; 9/0 volume and m stay on the browser; every other binding is a no-op with an OSD notice.
- **Scrub**: click seeks; drag is throttled like the video (one seek in flight, latest wins); both set `playerPosition`.
- **External changes**: if polling sees another persistent id in `currentTrack`, or `stopped` after the `once` play ends, Studio playback ends silently and the Video stays paused.

## Decided in #27 (implementation)

- **Bridge**: `src/server/studio/bridge.ts`. Commands carry an id; every failure, script error or 10 s silence is `refused` and the child is killed and restarted on the next use. The launch-time `playerState()` is a separate one-off `osascript` (killed after 10 s) started from `launch.ts`, so tests that call `startApp` never touch Music.app.
- **Dump**: a one-off `osascript` (not the resident child, so a dump never blocks the transport), columns not rows, cached as `studio-dump.json`. `no longer available` tracks are never match candidates or search hits; `removed` ones are kept (they may still be local files). A refresh within 5 s of the last is reused unless forced.
- **Matcher**: only Mirror Tracks that have a Song can hold a row. A confirmed match is left alone while its id is in the dump; once the id is gone and a fresh match resolves differently it drops to Suggested. Rejecting or removing a Mirror match writes a tombstone in `studio_rejection` (migration 0004) so the next import does not suggest the same pair again.
- **Ending**: after the 2.5 s grace that follows a play, `stopped` ends Studio playback as `stopped`, a different persistent id as `external` (Music.app is then left alone). A pause from outside is shown as paused; it does not end Studio playback.
- **Music.app quirk**: after roughly 7 to 10 backward `playerPosition` writes Music.app pauses itself (reproduced with a bare JXA loop on both a stream and an uploaded file). An A-B loop therefore resumes a pause that lands within 2 s of its own jump and next to A.
