# Design direction

Decided in [issue #11](https://github.com/IncoherentThoughts/TuvaVideos/issues/11). The prototype that settled it lives on branch `prototype/design-direction` (`docs/prototypes/design-direction.prototype.html`, open by double-click). Reopen it with `?variant=B` to see the chosen direction; `?variant=A` and `C` are the rejected ones.

## Verdict: "Wall"

Dark, high-contrast, hard-edged. Deliberately unlike the Tuvan Lyrics Archive's warm, soft, low-contrast look.

- **Library** is a full-bleed poster grid. Each card: Thumbnail with the duration in the corner; title with a favorite badge inline; a row of tint-style tags (Type first, then Artists); a smaller second row of colour-coded quality tags (plus the Copy count when above 1); a meta row of availability icon (external or unavailable only), chapter count and view count (each only when above 0) separated by dots, indented to align with the tag text.
- **Now playing** is its own screen (top tabs: Library, Now playing, Favorites, Artists). Big player with chapter ticks on the timeline, title, then a row of availability icon, favorite badge, Type and Artist tags. Chapters are a horizontal filmstrip of cards (scrub-strip frame, timestamp, ♪ when Linked, "suggested" when Suggested, title).
- **Lyrics** are a closable right drawer. Decided in [issue #12](https://github.com/IncoherentThoughts/TuvaVideos/issues/12) (variant A "Reader" of `docs/prototypes/lyrics-search.prototype.html` on branch `prototype/lyrics-search`; `?variant=B` and `C` are the rejected ones). Header: Song title with its English title dimmed, then a **Script** segmented control (Cyrillic / Latin / English) showing one Script at a time, a button disabled when the Version lacks that Script, and the choice clamped to a Script the Version has. When the Song has more than one **Version**, a row of pills under the title, the Chapter's Version badged "· this chapter", opening on the Chapter's Version else the first in display order. Numbered lines (continuous across stanzas, blank lines as spacers), no current line until playback supplies one, then that line in the accent color. Footnote **markers** are superscript accent digits; adjacent markers get a CSS comma; a marker with no entry is struck through. Hover or focus shows a two-column tooltip (number, text); click jumps to the entry and flashes it; `[` `]` cycle markers. A bordered "Footnotes" section at the bottom lists the shown Script's entries only.
- **Availability**: laptop icon (green) for a local Copy, landscape external-drive icon (blue) for an external Root, dashed grey drive when unavailable. Icons only, text on hover.
- **Favorite**: outline star with rounded joins inside a tinted rounded square (same 18% fill / 45% border as tag pills, yellow `--t3`).
- **Brand**: the olchey favicon from the Lyrics Archive, no wordmark.

- **Search results** (also #12) are a dropdown under the top-bar search box, grouped in a fixed order with a count per group: Songs, Videos, Artists, Tracks, Albums. Each row shows the name with matched text in a yellow `<mark>`, a mono type label (Video rows add the duration, Song rows add "· lyrics" when only the lyrics matched, Track rows add the album and "by Artist"), and a "Lyrics:" line holding the whole first matching lyric line. A Video row names the Songs it performs; choosing a Song or a Track with a Song opens its lyrics. **Filters**: `#songs` `#videos` `#artists` `#tracks` `#albums` anywhere in the query restrict the groups shown, `#lyrics` matches lyric text only, and a bare `#videos` lists every Video; active filters show as chips at the top of the dropdown, and a filtered group shows up to 40 rows instead of 8. **Keys**: `/` focuses the box, ↓ ↑ walk the rows across groups, Enter opens the highlighted row, Esc closes. The query is never written to the URL. Matching folds Cyrillic and Latin both ways (`saryg` → Сарыглар, `x` ≈ `kh`, `ŋ`/`ñ` → `ng`), ranks exact 0 / prefix 1 / word-start 1.5 / contains 2 with +3 for an English title and +4 for an alternate title or spelling, lyrics-only 5, and needs 3 characters before it searches lyrics. Fold every title and lyric line once at load; the prototype's per-keystroke folding was the only thing that made search feel slow.

## Tokens

```css
--bg: #1f1e1d;      /* page */
--bg2: #262624;     /* panels, cards */
--bg3: #30302e;     /* raised / selected */
--line: #3d3c3a;
--fg: #d9d8d5;
--fg2: #93918c;
--fg3: #75726c;
--accent: #d97757;  /* Claude terracotta: current line, progress, focus */
/* tag palette: gruvbox. Type uses a fixed slot; Artists hash to a slot. */
--t1: #fb4934; --t2: #fe8019; --t3: #fabd2f; --t4: #b8bb26;
--t5: #8ec07c; --t6: #83a598; --t7: #d3869b; --t8: #ebdbb2;
--font-ui: 'IBM Plex Sans', sans-serif;
--font-lyrics: 'Inter', sans-serif;
--font-mono: 'JetBrains Mono', monospace;  /* timestamps, line numbers, OSD */
--fs: 14px;
--r: 10px;
--pad: 8px;
```

Tag style is **tint**: `background: color-mix(in srgb, var(--c) 18%, transparent); color: var(--c); border: 1px solid color-mix(in srgb, var(--c) 45%, transparent)`. Suggested items use a dashed border. Type colors: song `--t1`, concert `--t3`, interview `--t5`, other `--t8`. Local = `--t4`, external = `--t6`.

## Parked

- The Ledger variant's command-style filter prompt (`:fav`, `:type=concert`, `:artist=alash`, `:lyrics=…`) was liked. Revisit well after v1.
