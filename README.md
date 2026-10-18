# TuvaVideos

A local video player for a library of Tuvan music videos (concerts, music videos, short clips) with titles, Artists, Songs, Chapters and lyrics from the [Tuvan Lyrics Archive](https://songsofthesteppe.org). It runs from source on your machine and plays the files in one folder of yours. Signing in with video access brings the shared library's link data (titles, Artists, Songs, Chapters) through the archive; the video files themselves never leave your machine.

Developed and tested on macOS. Linux and Windows are supported in the code but untested; please open an issue with what breaks.

Spec: `docs/spec.md`, `docs/sharing-spec.md`. Vocabulary: `CONTEXT.md`. Decisions: `docs/adr/`.

## Run from source

Bun is the one manual install, plus ffmpeg (ffmpeg, ffprobe) and webp (cwebp):

| Platform | Bun | ffmpeg and webp |
|---|---|---|
| macOS | `curl -fsSL https://bun.sh/install \| bash` | `brew install ffmpeg webp` |
| Linux (Debian, Ubuntu) | `curl -fsSL https://bun.sh/install \| bash` | `sudo apt install ffmpeg webp` |
| Windows | `powershell -c "irm bun.sh/install.ps1 \| iex"` | `winget install Gyan.FFmpeg` and `winget install Google.Libwebp` |

Then, in a clone of this repo:

```bash
bun install
bun run setup        # checks Bun, ffmpeg, ffprobe, cwebp and the trash command, creates the data dir
bun run start        # port 4400, opens a browser tab; Ctrl-C or the ⏻ button top right stops it
```

`bun run setup` prints one line per check with the install command for anything missing, exits non-zero while something required is missing, and does not start the app; yt-dlp, ImageMagick and a trash command are optional. On macOS, `bun run app` builds `~/Applications/TuvaVideos.app`, a double-click launcher for `bun run start` (needs ImageMagick).

Data lives in `~/Library/Application Support/TuvaVideos/` on macOS, `$XDG_DATA_HOME/TuvaVideos` (default `~/.local/share/TuvaVideos`) on Linux and `%APPDATA%\TuvaVideos` on Windows: `library.db`, `thumbs/`, `remux/`, `youtube-info/`, `studio-dump.json`, `log.txt`. `TUVA_PORT`, `TUVA_DATA_DIR`, `TUVA_LOCAL_ROOT` and `TUVA_NO_OPEN=1` override the port, the data dir, the videos folder and the tab, for tests. ffmpeg, ffprobe and cwebp are taken from `/opt/homebrew/bin` (native arm64), then `/usr/local/bin`, then `PATH`; `TUVA_BIN_DIR` puts another directory first.

## First launch

The empty library offers two things, in either order:

- **Choose a videos folder.** Type the full path of the folder that holds your video files (`~` works, e.g. `~/Videos/Tuvan`). The app checks it ("Not found", "Not a folder", "Can't read it") and scans it at once. Later launches do not scan by themselves: the Rescan button does, and a drive that comes back is scanned when it appears. One folder per machine.
- **Sign in** with your songsofthesteppe.org account to get the shared library's titles, Artists, Songs and Chapters.

**Getting video access.** The shared library comes with the video grant. Create an account on [songsofthesteppe.org](https://songsofthesteppe.org), then ask the owner for video access (Member to watch, Video Editor to edit too); the owner grants it with `bun scripts/grant-video-access.ts <email> <level>`. Grants are never made from the app.

A Member needs no videos folder: the shared library shows with every Video "Not on this machine", and a one-line "No videos folder yet" bar above the grid opens the folder field. Dismiss it with ×; this machine remembers.

## Filenames

A Video is identified by the id in its filename when there is one. Download with yt-dlp's `[id]` suffix, the one-line template:

```bash
yt-dlp -o '%(title)s [%(id)s].%(ext)s' <url>
```

YouTube files end `[<11-character id>]`. Instagram and Rutube ids carry a prefix: `[instagram-<shortcode>]` and `[rutube-<32-hex id>]` (for those, `-o '%(title)s [instagram-%(id)s].%(ext)s'` or `[rutube-%(id)s]`). Files without an id scan in too, identified by a hash of their content.

## Updating

```bash
git pull && bun install
```

Then restart. SQLite migrations run at launch. When the archive's Shared schema has moved past your checkout, Sync stops and a banner above the grid says "Update TuvaVideos: git pull, then restart"; browsing and playback carry on from the local copy meanwhile.

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

## Maintainer commands

The owner's one-off commands for his own library; nobody else needs them.

| Command | Does |
|---|---|
| `bun run latin-titles` | Fills Latin titles on Videos, Chapters and Local Artists |
| `bun run fetch-youtube-info [--limit n] [--force] [--replies] [--no-suggest]` | The only networked step: yt-dlp info + top comments for concert-length Videos into `youtube-info/`; ends by running the suggest step on the ids it fetched |
| `bun run suggest-chapters [ids] [--dry-run]` | Offline: writes Suggested Chapters from the cache and the archive's Performances (the Local copy) |
| `bun run suggest-artists [id] [--dry-run]` | Re-runs the Artist matcher over the titles (Videos with a confirmed Artist are left alone) |
| `bun run studio-match [--cached]` | Matches the archive's Tracks to Music.app tracks |
| `bun run index-keyframes` | Indexes the keyframes of every Copy on a mounted Root that has none yet, so keyframe seeks are instant from the first play (otherwise each Copy is indexed when it first plays) |
| `bun test`, `bun run typecheck` | Tests and types |
