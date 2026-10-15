# Playlist

Decided in a grilling session on 2026-10-15. Terms: Playing from, Playlist, Entry, Play order, Repeat, Played in `CONTEXT.md`. The behaviour is spec §4.8 (folded in by #65); this document keeps the implementation plan.

## Implementation plan

Tickets in order; each is one PR on `task/<slug>`, `bun test` and typecheck green, spec section updated in the same PR.

### 1. `playlist-model`: pure state and tests

- `src/shared/playlist.ts`: `Entry = { videoId: number; chapterId?: number }`, `Playlist = { source: PlayingSource | "library-all"; entries: Entry[]; order: number[]; cursor: number; shuffled: boolean; repeat: "off" | "list" | "one" }` where `order` is the index permutation and `cursor` indexes into it.
- Functions: `startPlaylist(entries, { shuffled, startAt })`, `setShuffled(pl, on, rng)`, `cycleRepeat(pl)`, `advance(pl, playable)` returning `{ pl, ended }`, `stepBack(pl, playable)`, `jumpTo(pl, entryIndex)`, `jumpToVideo(pl, videoId)`, `widenToVideo(pl)` for a Chapter Entry that ran past its end, `upcoming(pl)`, `played(pl)`. Fisher–Yates with an injectable rng. Wrap on repeat list reshuffles.
- `src/web/playlist.ts`: in-memory store mirrored to sessionStorage key `tuva.playlist`, pub/sub like `playingFrom.ts`, `startPlaylist`, `loadPlaylist`, `updatePlaylist`, `endPlaylist`.
- Tests in `test/` for every transition, including Chapter Entry end, unavailable skipping, reshuffle on wrap and on re-enable, ended state.

### 2. `playlist-player`: end-of-Entry and modes in the Player

- `Player.tsx`: new props `playlist` (store snapshot or null) and callbacks `onPlaylistNext/Prev/Shuffle/Repeat/PanelToggle`. The `ended` handler consults the Playlist: repeat one → restart Entry; else advance via `Play.tsx` which navigates to `playHref(videoId, chapterStart)`; ended with repeat off → pause, say "Playlist ended".
- Chapter Entry end: a `timeupdate` check against the Entry's end time triggers the same path as `ended`; seeking past it calls `widenToVideo`.
- Resume: `resumeOn` stays false while a Playlist is active.
- `keymap.ts`: `n`, `N`, `x`, `e`, `q` actions; `<` `>` route to Playlist stepping when one is active. `StatePanel.tsx` BINDINGS updated and diffed against `keyAction`.
- Control bar: shuffle and repeat icons with key hints after the A-B label; disabled repeat state when no Playlist.
- `Play.tsx`: opening a Video that is in the active Playlist jumps the cursor; opening one that is not ends it (`r`, URL, grid all go through this). Spec §4.8 written here.

### 3. `playlist-start-buttons`: the three list pages

- `Library.tsx`, `SearchResults.tsx`, `Favorites.tsx`: a button at the end of `.controls` that builds Entries from `shown` (Favorites: Video rows → Video Entry, Chapter rows → Chapter Entry with `chapterId`), starts a shuffled Playlist at a random Entry, and navigates to it. Library with no filters passes `source: "library-all"`.
- Player shuffle icon / `x` with no Playlist: same, from `useStore().videos` in library order, starting at the current Video.

### 4. `playlist-panel`: the drawer panel

- `src/web/PlaylistPanel.tsx`: `<aside class="drawer playlist">`, header and rows per the Behaviour section, `useWindowed` over upcoming (and played when shown), highlight on the current row, scroll it into view on change.
- `Play.tsx` drawer column becomes a flex column: the existing exclusive panel (if any) then the Playlist panel; `styles.css` `.drawer-wrap` gains the stacked layout with both panels scrolling inside the column height. Esc in the panel closes it and refocuses the Player.
- Opens automatically when a Playlist starts; `q` and the control-bar button toggle it; open state in `useState` like the others.

### 5. `playlist-polish`

- Thumbnail rows virtualised and measured against a 1000-Entry whole-library Playlist on the laptop; key-hint styling shared with the Audio/State buttons; OSD messages for each action ("Shuffle on", "Repeat: list", "Next: <title>"); README key table.
