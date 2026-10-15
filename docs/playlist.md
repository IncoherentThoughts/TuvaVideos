# Playlist

Decided in a grilling session on 2026-10-15. Terms: Playing from, Playlist, Entry, Play order, Repeat, Played in `CONTEXT.md`. Spec §4.4 (Playing from) stays as written; this document is the spec for the Playlist and should be folded into §4 as §4.8 by the first implementation ticket.

## Behaviour

### Two lists, two behaviours

- **Playing from** is unchanged: `<` `>` step through the snapshot the Video was opened from, the Video loops itself when it ends, no panel. A Video opened from a grid, search, `r` or a URL is only Playing from.
- A **Playlist** exists only after a shuffle starts one. It carries a Play order, a Repeat mode and a panel. It ends when a Video outside it is opened (grid click, search, `r`, URL) or when another shuffle starts; hiding the panel does not end it. It survives a reload in the same tab (sessionStorage, next to `tuva.playingFrom`).

### Starting one

| Where | Button label | Entries | First Entry |
|---|---|---|---|
| Library grid | "shuffle random" | the grid as filtered and sorted (`shown`); the whole library when unfiltered | random |
| Search results | "shuffle results" | the result list as filtered (cap 500) | random |
| Favorites | "shuffle favorites" | every Favorite row as filtered: a Video row is a Video Entry, a Chapter row is a Chapter Entry; a Video and its Chapter both starred give two Entries | random |
| Player, shuffle icon or `x`, no Playlist active | — | the whole library in library order | the current Video |

The buttons sit at the right end of each page's `.controls` row, after the existing filter and sort controls. A Playlist starts **shuffled**, with Repeat **off**, and opens the panel.

Unavailable Videos are included, shown greyed, and skipped on advance and by `n`/`N`. If their Root mounts later they play without rebuilding.

### Entries

- A **Video Entry** plays from the start (never the Resume position) to the end.
- A **Chapter Entry** plays from the Chapter's start to the next Chapter's start, or the Video's end. The Chapter keys `!` `@` still work. Seeking or stepping past the Entry's end turns it into a Video Entry for the rest of that Video (the panel row drops the Chapter title).
- Playing inside a Playlist **never writes a Resume position** (`resumeOn` stays false for the whole Entry).
- Opening a Video that is already in the active Playlist (from anywhere) jumps to that Entry instead of ending the Playlist. If it appears more than once, the first upcoming occurrence wins, else the first.

### Play order

- **Shuffled**: a uniform random permutation (Fisher–Yates) of the upcoming Entries. Turning shuffle on again mid-Playlist reshuffles only the upcoming Entries; Played Entries keep their order. When Repeat list wraps a shuffled Playlist, it reshuffles.
- **Sequential**: the source list's order from the current Entry on. Turning shuffle off restores it.

### Repeat

Cycle **off → list → one** on each press.

- **off**: advance on end; at the end of the list, stop paused on the last frame and the panel shows "Playlist ended". `n` does nothing; `N` still goes back.
- **list**: advance; wrap at the end (reshuffling if shuffled).
- **one**: play the same Entry again (a Chapter Entry restarts at the Chapter).

A Video that is only Playing from behaves as repeat one; the repeat icon shows "one" and is disabled.

### Control bar

Right of the A-B label, before the spacer: a **shuffle** icon and a **repeat** icon, always visible, each with its key hint (`x`, `e`) in the same style as "Audio a" and "State i". With no Playlist active, shuffle starts a whole-library Playlist and repeat is disabled showing "one". With one active, shuffle toggles the Play order and repeat cycles.

### Panel

- Lives in the right-hand drawer column at the same width. Opens beneath whichever of Audio / State / Lyrics is open, or alone in their slot. Those three keep excluding each other; the Playlist panel excludes nothing. Toggle with `q`, the control-bar button, or the panel's close button; closing the panel keeps the Playlist.
- Header: "Playlist", then prev (`N`), next (`n`), shuffle (`x`), repeat (`e`), a "show played" toggle, close. Count "n of N" under the title.
- Body: the current Entry highlighted at the top, then upcoming Entries in play order. Played Entries are hidden until "show played" is on, then listed above the current one in the order they were played. "show played" resets to off whenever a new Playlist starts and is not persisted.
- Each row: Thumbnail poster, Video title (Latin title beneath when present), Chapter title for a Chapter Entry, the Video's Type and Artists as the tag line. Click jumps to that Entry (a Played one too). Unavailable rows are greyed.
- The list is windowed with the grid's `useWindowed`, about 25 rows at a time, extending on scroll. The Playlist itself holds every id.
- Fully keyboard-driven for the actions above; no key for "show played" yet.

### Keys

| Key | Action |
|---|---|
| `n` | next Entry (skips unavailable) |
| `N` | previous Entry |
| `x` | toggle shuffle; starts a whole-library Playlist when none is active |
| `e` | cycle Repeat |
| `q` | toggle the Playlist panel |

`<` `>` keep stepping Playing from when no Playlist is active and step Entries when one is. `r` ends the Playlist (it opens a Video outside it). All five keys go into the State panel's guide list, with any binding the guide is missing today.

### Out of scope

TV app; persisting a Playlist in the DB or across tabs; a key for "show played"; Chapter Entries for anything other than Favorite Chapters; saved or named playlists.

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
