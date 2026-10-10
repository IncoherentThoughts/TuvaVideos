# Design direction

Decided in [issue #11](https://github.com/IncoherentThoughts/TuvaVideos/issues/11). The prototype that settled it lives on branch `prototype/design-direction` (`docs/prototypes/design-direction.prototype.html`, open by double-click). Reopen it with `?variant=B` to see the chosen direction; `?variant=A` and `C` are the rejected ones.

## Verdict: "Wall"

Dark, high-contrast, hard-edged. Deliberately unlike the Tuvan Lyrics Archive's warm, soft, low-contrast look.

- **Library** is a full-bleed poster grid. Each card: Thumbnail with the duration in the corner and a colored left edge for availability; title with a favorite badge inline; a row of tint-style tags (Type first, then Artists); a meta row of availability icon, chapter count and resolution separated by dots, indented to align with the tag text.
- **Now playing** is its own screen (top tabs: Library, Now playing, Favorites, Artists). Big player with chapter ticks on the timeline, title, then a row of availability icon, favorite badge, Type and Artist tags. Chapters are a horizontal filmstrip of cards (scrub-strip frame, timestamp, ♪ when Linked, "suggested" when Suggested, title).
- **Lyrics** are a closable right drawer: Version segmented toggle (Тыва / Latin / English) in the header, numbered lines with the current line in the accent color, superscript Footnote markers, and a bordered "Footnotes" section at the bottom like the archive.
- **Availability**: laptop icon (green) for a local Copy, landscape external-drive icon (blue) for an external Root, dashed grey drive when unavailable. Icons only, text on hover.
- **Favorite**: outline star with rounded joins inside a tinted rounded square (same 18% fill / 45% border as tag pills, yellow `--t3`).
- **Brand**: the olchey favicon from the Lyrics Archive, no wordmark.

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
