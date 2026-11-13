# Design direction

Decided in [issue #11](https://github.com/IncoherentThoughts/TuvaVideos/issues/11). The prototype that settled it lives on branch `prototype/design-direction` (`docs/prototypes/design-direction.prototype.html`, open by double-click). Reopen it with `?variant=B` to see the chosen direction; `?variant=A` and `C` are the rejected ones.

## Verdict: "Wall"

Dark, high-contrast, hard-edged. Deliberately unlike the Tuvan Lyrics Archive's warm, soft, low-contrast look.

- **Library** is a full-bleed poster grid. Each card: Thumbnail with the duration in the corner; title with a favorite badge inline; a row of tint-style tags (Type first, then Artists); a smaller second row of colour-coded quality tags (plus the Copy count when above 1); a meta row of availability icon (external or unavailable only), chapter count and view count (each only when above 0) separated by dots, indented to align with the tag text.
- **Now playing** is its own screen (top tabs: Library, Now playing, Favorites, Artists). Big player with chapter ticks on the timeline, title, then a row of availability icon, favorite badge, Type and Artist tags. Chapters are a horizontal filmstrip of cards (scrub-strip frame, timestamp, the Song mark when Linked, "suggested" when Suggested, title; see the audit pass below).
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
--fg: #ebe9e4;      /* three real grey levels (audit pass, 2026-11) */
--fg2: #b1aea7;
--fg3: #908d87;
--accent: #c9963a;  /* ochre: what is playing (current line, progress, current Chapter) and an active filter chip */
/* tag palette: gruvbox. Type uses a fixed slot; Artists hash to a slot. */
--t1: #fb4934; --t2: #fe8019; --t3: #fabd2f; --t4: #b8bb26;
--t5: #8ec07c; --t6: #83a598; --t7: #d3869b; --t8: #ebdbb2;
--font-ui: 'IBM Plex Sans', sans-serif;
--font-lyrics: 'Inter', sans-serif;
--font-mono: 'JetBrains Mono', monospace;  /* timestamps, line numbers, OSD */
--fs: 14px;
--r: 3px;          /* small controls use .6 of it, inline marks .4 */
--pad: 8px;
```

Tag style is **tint**: `background: color-mix(in srgb, var(--c) 18%, transparent); color: var(--c); border: 1px solid color-mix(in srgb, var(--c) 45%, transparent)`. Suggested items use a dashed border. Type colors: song `--t1`, concert `--t3`, interview `--t5`, other `--t8`. Local = `--t4`, external = `--t6`.

## Audit pass (2026-11)

A pass to take the generic "AI-made" tells out of the UI while keeping Wall. Each item was picked in a throwaway toggle prototype; the rules are the last section of `src/web/styles.css`.

- **Colour**: the accent is ochre and is kept for what is playing plus the active filter chip; hover, focus rings and selected pills are neutral greys. Artist tags keep their hashed colours and the Favorite keeps its tinted square. Quality tags are coloured text, not pills. Download tiles are one colour.
- **Type**: five sizes (12 / 14 / 16 / 20 / 24). Mono is for data only (timestamps, durations, line numbers), not counts or captions. Caps labels are gone: section headings are sentence case, and a Suggested or Proposed tag is marked by a dashed border, not a caps badge.
- **Shape**: one radius (3px). Section boxes have no coloured left rail. The State dot does not pulse. State line numbers are off.
- **Top bar** buttons are ghost buttons; Library cards keep their tags on one line; Favorites rows are wider with two-line titles.
- **Filter bars** (Library, Songs, Artists, Favorites): each set of chips is one joined control, sort and its direction arrow another, count and shuffle end the row; every control is 30px tall.
- **Now playing header**: 28px controls 8px apart; "Type:" and "Artists:" are labelled rows on one left edge. Source links and Delete share one footer; Delete stays red.
- **Chapter cards**: all one height with the actions on the bottom edge. The linked Song is a gold chip with the Song mark (lyric lines with a note), so it does not read as a repeated title. Versions are one scrolling row of pills. Actions are 30px: "change" and its clear x are one split control, the red trash sits alone on the right. A repeat button next to the Favorite star loops the Chapter (it sets the A-B loop).

## Parked

- The Ledger variant's command-style filter prompt (`:fav`, `:type=concert`, `:artist=alash`, `:lyrics=…`) was liked. Revisit well after v1.
