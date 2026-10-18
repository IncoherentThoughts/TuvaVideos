# TuvaVideos
Local video player with metadata info for my personal library of Tuvan music.

Spec: `docs/spec.md`. Vocabulary: `CONTEXT.md`. Decisions: `docs/adr/`.

## Run

```bash
bun install
bun run start        # port 4400, opens a browser tab; Ctrl-C or the ⏻ button top right stops it
bun run app          # builds ~/Applications/TuvaVideos.app: a double-click launcher for the line above (needs ImageMagick)
```

Data lives under `~/Library/Application Support/TuvaVideos/` (`library.db`, `thumbs/`, `remux/`, `youtube-info/`, `studio-dump.json`, `log.txt`). `TUVA_PORT`, `TUVA_DATA_DIR` and `TUVA_NO_OPEN=1` override the port, the data dir and the tab for tests. ffmpeg, ffprobe and cwebp are taken from `/opt/homebrew/bin` (native arm64), then `/usr/local/bin`, then `PATH`; `TUVA_BIN_DIR` puts another directory first.

## Player keys

Bare keys, handled while the Player has focus (`Esc` or `v` brings focus back). The State panel (`i`) lists the same keys.

| Key | Does |
|---|---|
| `space` `p` | pause / play |
| `←` `→` | seek ±5 s |
| `↓` `↑` | seek ±60 s |
| `⇧←` `⇧→` | exact ±1 s |
| `,` `.` | frame step back / forward |
| `[` `]` | speed ∓0.1 |
| `{` `}` | speed ½ / ×2 |
| `⌫` | speed 1.0 |
| `9` `0` | volume ±5 |
| `m` | mute |
| `f` | fullscreen |
| `l` | A-B loop (A, B, off) |
| `!` `@`, `PgUp` `PgDn` | previous / next Chapter |
| `<` `>` | previous / next Video (Entry in a Playlist) |
| `r` | random Video (works anywhere) |
| `s` | screenshot |
| `o` `O` | OSD flash / always |
| `c` | add Chapter here |
| `t` | Studio playback |
| `i` | State panel |
| `y` | lyrics drawer |
| `a` | Audio panel |
| `n` `N` | Playlist next / previous Entry |
| `x` | shuffle (starts a whole-library Playlist) |
| `e` | Repeat off / list / one |
| `q` | Playlist panel |
| `/` | focus search |
| `Esc` | back to the Player |
| `v` | back to the Player (from anywhere) |

## One-off commands

| Command | Does |
|---|---|
| `bun run latin-titles` | Fills Latin titles on Videos, Chapters and Local Artists |
| `bun run fetch-youtube-info [--limit n] [--force] [--replies] [--no-suggest]` | The only networked step: yt-dlp info + top comments for concert-length Videos into `youtube-info/`; ends by running the suggest step on the ids it fetched |
| `bun run suggest-chapters [ids] [--dry-run]` | Offline: writes Suggested Chapters from the cache and the archive's Performances (the Local copy) |
| `bun run suggest-artists [id] [--dry-run]` | Re-runs the Artist matcher over the titles (Videos with a confirmed Artist are left alone) |
| `bun run studio-match [--cached]` | Matches the archive's Tracks to Music.app tracks |
| `bun run index-keyframes` | Indexes the keyframes of every Copy on a mounted Root that has none yet, so keyframe seeks are instant from the first play (otherwise each Copy is indexed when it first plays) |
| `bun test`, `bun run typecheck` | Tests and types |
