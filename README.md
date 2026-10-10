# TuvaVideos
Local video player with metadata info for my personal library of Tuvan music.

Spec: `docs/spec.md`. Vocabulary: `CONTEXT.md`. Decisions: `docs/adr/`.

## Run

```bash
bun install
bun run start        # port 4400, opens a browser tab; Ctrl-C stops it
```

Data lives under `~/Library/Application Support/TuvaVideos/` (`library.db`, `thumbs/`, `remux/`, `youtube-info/`, `studio-dump.json`, `log.txt`). `TUVA_PORT`, `TUVA_DATA_DIR` and `TUVA_NO_OPEN=1` override the port, the data dir and the tab for tests.

## One-off commands

| Command | Does |
|---|---|
| `bun run import <backup-dir>` | Re-imports the Mirror from a Tuvan Lyrics Archive backup (post-migration-126), then Latin titles, search index and the Studio matcher |
| `bun run latin-titles` | Fills Latin titles on Videos, Chapters and Local Artists |
| `bun run fetch-youtube-info [--limit n] [--force] [--replies]` | The only networked step: yt-dlp info + top comments for concert-length Videos into `youtube-info/` |
| `bun run suggest-chapters [ids] [--dry-run]` | Offline: writes Suggested Chapters from the cache and Mirror Performances |
| `bun run studio-match [--cached]` | Matches Mirror Tracks to Music.app tracks |
| `bun test`, `bun run typecheck` | Tests and types |
