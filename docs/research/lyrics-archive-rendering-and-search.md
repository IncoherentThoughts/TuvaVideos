# Tuvan Lyrics Archive: how Versions, Footnotes and search work

Research for issue #6 (map: #1). Source read: `/Users/evanwilliams/Desktop/Lyrics Website` (called "the archive" below), as of 2026-10-10. Every path below is relative to that repo unless it says otherwise. Read-only; nothing in the archive was changed.

## TL;DR

- A **Version** is one `song_lyrics` row. It holds three Script columns of **rich HTML** (`lyrics_cyrillic`, `lyrics_transliteration`, `lyrics_translation`), three **JSONB** Footnote columns (`footnotes_*`, arrays of `{id:number, text:string}`), plus `version_label`, `display_order` and `source`.
- A **Marker** is `<sup data-fn="N" class="footnote-ref">N</sup>` inline in a `<p>`. One `<p>` is one lyric line, and a blank `<p class="ln-blank"><br></p>` separates stanzas.
- The reader switches **Versions** with an index into the display-ordered list: pills on desktop, a `‹ label ›` stepper on phones. It switches **Scripts** with a segmented control. The chosen Script is clamped to one the active Version actually has.
- **Search** is one Postgres RPC, `search_archive(q, countries)`. It does case-insensitive substring matching (`strpos(lower(..))`), with no FTS, no trigram index and no transliteration folding. Results are grouped songs → artists → composers → tracks → albums and ranked inside each group by an exact / prefix / contains score. A lyric hit returns the **whole first matching line**, stripped of HTML and digits. The client highlights it with a case-insensitive `indexOf` loop.
- Almost all of the parsing logic is pure TypeScript and can be ported with little change (`src/lib/lyrics/normalize.ts`, `scripts.ts`, `markers.ts`' regex core, `trackVersion.ts`, `highlightSnippet.tsx`, `artistNameKey`). The components (`LyricsViewer`, `LyricsModal`, `SongDetailPage`, `LyricsFullscreen`, `LandingPageV3`) belong to the archive's design system and its i18n/a11y apparatus. Do not reuse them.

## 1. Storage: a Version and its three Scripts

**Entity.** `SongLyrics` in `src/types/index.ts:79-93`:

```ts
interface SongLyrics {
  id, song_id, version_label, display_order,
  lyrics_cyrillic?, lyrics_transliteration?, lyrics_translation?: string | null,   // rich HTML
  footnotes_cyrillic?, footnotes_transliteration?, footnotes_translation?: FootnoteEntry[] | null,
  source?, created_at, updated_at
}
interface FootnoteEntry { id: number /* 1-based, matches <sup data-fn="N"> */; text: string /* inline HTML */ }
```

The lyrics module re-exports this type unchanged as the read model `LyricsVersion` (`src/lib/lyrics/types.ts`).

**HTML only (ADR-0003).** `docs/adr/0003-lyrics-stored-as-rich-html-only.md`: a Script is always rich HTML or NULL, never plain text. A live count found 153 Versions and 0 plain-text Scripts. Migration `supabase/migrations/105_song_lyrics_rich_html_check.sql` enforces this with `CHECK (lyrics_x IS NULL OR lyrics_x ~ '<[a-zA-Z]')` on each column. The TypeScript mirror of that check is `RICH_TEXT_PATTERN` / `isRichText` in `src/lib/lyrics/richText.ts`.

**Footnote columns.** `supabase/migrations/032_song_lyrics_footnotes.sql` defines them as `JSONB NOT NULL DEFAULT '[]'`. Each Script has its own list. Ids are editable, need not be unique, and need not be dense (`CONTEXT.md` "Footnote"). When ids repeat, the first entry wins (`entriesById`, `src/lib/lyrics/markers.ts`).

**The Script triple.** `src/lib/lyrics/scripts.ts` holds the `SCRIPTS` array, the only place the triple is spelled out. Each row maps a key (`cyrillic | transliteration | translation`) to its text column, its footnote column, a BCP-47 tag (`tyv`, `tyv-Latn`, `en`), i18n label keys and an edit-history event type. Helpers:

- `scriptText(version, key)` returns the stored HTML, or `''`.
- `scriptFootnotes(version, key)` returns the stored entries, or `[]`.
- `presentScripts(version)` returns the Scripts whose text is non-blank after `.trim()`, in reading order.
- `effectiveScript(preferred, present)` clamps a preferred Script to one that exists. The fallback is the first present Script, and `'cyrillic'` only when the Version has none.

**HTML shape** (`src/lib/lyrics/normalize.ts`):

- One `<p>` per lyric line.
- Blank line / stanza break: `<p class="ln-blank"><br></p>`. The parser also treats an empty `<p>`, `&nbsp;` or a lone `<br>` as blank (`parseHtmlToLines`).
- Inline formatting the sanitizer allows on a line: `p br b strong i em u s sub sup span`, with attributes `class id role tabindex` plus DOMPurify's default `data-*` / `aria-*` (`LINE` profile, `src/lib/sanitize.ts`).
- Footnote bodies are inline only: `b strong i em u br sub sup`, with no attributes (`FOOTNOTE` profile).

**Reading the rows.** `getSongLyrics(songId)` in `src/lib/queries/lyrics.ts` selects all three text columns, all three footnote columns, the label, the order and `source` from `song_lyrics`, ordered by `display_order` ascending. Nothing is normalized on read.

**Default Version and Track Version** (`src/lib/lyrics/trackVersion.ts`, ADR-0009):

- `album_tracks.track_version_id` is nullable, and null means "use the Song's default", which is the first Version in display order.
- `openingVersionIndex(versions, trackVersionId)` resolves the pointer to an index. It returns 0 when the pointer is null, when it names a deleted Version, or when the list is empty.
- A new Song's first Version is labelled `'Complete'` (`DEFAULT_VERSION_LABEL`), but that label is not reserved.
- About 140 of the archive's 154 Versions are their Song's only Version (`src/components/ui/VersionStepper.tsx` doc comment).

## 2. Footnotes and Markers: encoding and rendering

### Wire format

A Marker is `<sup data-fn="N" class="footnote-ref">N</sup>`. The visible text is plain digits, not Unicode superscripts; the doc on `superscriptChar` in `src/lib/lyrics/normalize.ts` explains that superscripts 4–9 are missing from many fonts. Adjacent Markers are written back to back with no comma, and CSS draws the separator (see below).

### Legacy plain-text convention (import / paste only)

`migratePlainTextToRichText` in `src/components/lyrics/pasteMigration.ts` converts the old informal format into the HTML format:

- A body word followed by digits becomes a Marker: `word1` gives `word<sup data-fn="1">1</sup>`, and `word1,2` or `тайгам.3, 4` give multiple Markers.
- Definition lines `1. Alt: text` at the bottom become the entries.
- The inline regex is `/([^\s\d,]|,\s*)(\d+(?:\s*,\s*\d+)*)/gu`. It deliberately avoids `\w`, which is ASCII-only and would skip Cyrillic words.
- A digit run is converted only when every id in it has a definition line, which guards against real numbers in the lyric.

This is worth porting if TuvaVideos ever ingests plain-text lyrics, for example from video descriptions.

### Parsing for render (all pure, in `src/lib/lyrics/normalize.ts`)

- `parseHtmlToLines(html)` returns `LyricLine[]`, each `{innerHTML, isBlank}`. It uses the regex `/<p(?:[^>]*)>([\s\S]*?)<\/p>/gi`. If the HTML has no `<p>` at all, the whole string becomes one line.
- `groupLinesIntoStanzas(lines)` returns `Stanza[]`. Runs of blank lines collapse into one break, and line numbers are 1-based and continuous across stanzas.
- `markersInReadingOrder(html)` returns the Marker ids in reading order, keeping duplicates. Regex: `/<sup\b[^>]*\bdata-fn="(\d+)"/gi`.
- `validateLyricsField(html, footnotes)` returns `{orphanMarkers, orphanEntries, emptyFootnotes}`. An orphaned Marker has no entry, an unreferenced entry (`orphanEntries`) has no Marker, and an empty entry has blank text.
- Other helpers: `renumberFootnotesInReadingOrder` (editor only), `computeLyricsDiff`, `footnotesEqual`, `stripHtml`, `escapeHtml`, `plainTextToHtml`.

### Marker augmentation (`src/lib/lyrics/markers.ts`)

`augmentMarkers(lines, footnotes, {kind, idPrefix, label})` rewrites each `<sup data-fn>` by regex:

- It gives each occurrence a unique DOM id, `${kind}-marker-${idPrefix}-${id}-${occurrence}`.
- It adds `role="doc-noteref" tabindex="0"`.
- Unless the Marker is orphaned, it adds `aria-describedby` pointing at `${kind}-def-${idPrefix}-${id}`.
- It adds an `aria-label` built from one of three cases: `orphan`, `no-text`, or `with-text` (which includes the body stripped and clipped to 60 characters). An orphaned Marker also gets `data-orphan="true"`.
- It marks a Marker that immediately follows another `</sup>` with `data-adjacent="true"`. The CSS `sup[data-fn][data-adjacent]::before` then draws the comma between them (`src/index.css:3118-3121`).
- Only after these edits does it sanitize with the `LINE` profile.

`useAugmentedLyricLines` wraps this with a React memo and an i18n labeller. Port the function, not the hook.

### Rendering (`src/components/lyrics/LyricsViewer.tsx`)

`LyricsViewer` renders one Script of one Version. Its props are `html`, `footnotes`, `fieldId` (= `${versionId}-${script}`) and `lang`.

- Each non-blank line is a flex row: an `aria-hidden` line-number gutter, then the line's HTML.
- A blank line becomes a spacer `div` with no number.
- Below the lyric is a definitions list:
  - sorted by id with a stable sort;
  - `role="doc-endnote"`;
  - each entry's DOM id is `fn-def-${fieldId}-${id}`, with a `-dupN` suffix on repeats;
  - an entry with no Marker is coloured red;
  - an empty body shows "(empty)".
- Interaction:
  - Hover or focus on a Marker shows a tooltip, portaled to `<body>`, containing the sanitized footnote body.
  - Click, Enter or Space smooth-scrolls to the definition and flashes it for 1.6 s.
  - On touch devices (`(hover: none)`), the first tap shows the tooltip and a second tap scrolls.
  - `]` and `[` move focus to the next or previous Marker, wrapping around.
  - Escape, scrolling or blur dismiss the tooltip.

The fullscreen reader (`src/pages/songs/sections/LyricsFullscreen.tsx`) reuses the same parse → `groupLinesIntoStanzas` → `augmentMarkers` pipeline with `kind='fs'`, so its ids never collide with the page underneath. It pages through 1, 2 or 3 stanzas per screen (`clampStanzaIndex`). In single-stanza mode it shows a paired Script: an English primary pairs with Cyrillic (falling back to Latin), and any other primary pairs with English.

## 3. How the reader toggles Versions and Scripts

**Versions.** The state is an `activeVersionIndex` into the Versions list in display order.

- Song page (`src/pages/songs/SongDetailPage.tsx:2320-2340`): one `sd-pill` button per Version. Clicking one calls `setActiveVersionIndex(i)`.
- Quick-view modal (`src/components/ui/LyricsModal.tsx:103-114`): loads every Version through `getSongLyrics` and opens on `openingVersionIndex(loaded, track.track_version_id)`.
- Phone modal: `src/components/ui/VersionStepper.tsx`, which shows `‹ label ›` with "n of N", wraps at both ends, renders nothing when there are fewer than 2 Versions, and adds a "· this track" badge on the Track Version (`isTrackVersionAt`).
- The Version is not stored in the URL.

**Scripts.**

- Desktop song page:
  - Translation, when present, always has its own column.
  - Cyrillic and Latin share the other column. A two-way segmented toggle (`activeScript`) appears only when both exist (`SongDetailPage.tsx:2408-2422`).
  - The initial choice comes from the signed-in user's `profiles.preferences_lyric_script` (`'latin'` → transliteration) and otherwise defaults to Cyrillic (`SongDetailPage.tsx:212-221`).
  - Before rendering, the choice is clamped with `effectiveScript(activeScript, presentScripts(lyrics))`. This is derived, not an effect, so switching Version re-clamps on its own.
- Mobile: one panel with a three-way APG tablist (Cyrillic / Latin / English). There is a tab only for each Script the Version has, with roving tabindex and arrow / Home / End keys (`SongDetailPage.tsx:947-983, 2430-2475`).
- Quick-view modal (desktop): one column per present Script (one to three columns).
- Fullscreen: a segmented control listing the present Scripts.

## 4. Site search

**Where it runs.** Server side, in a single Postgres function. The client is `src/lib/landingSearch.ts`:

- `searchArchive(q, region)` restricts countries to `['tuvan','other']` or `['mongolian','other']`.
- `searchArchiveAll(q)` searches every country.
- Both call `supabase.rpc('search_archive', {q, countries})`.
- An in-memory cache is keyed by region, a hidden-visibility flag and the lowercased query. It is cleared once it holds more than 100 entries.
- The two search surfaces debounce the call by 200 ms and discard stale responses: the landing hero (`src/pages/landing/LandingPageV3.tsx:445-464`) and the site nav (`src/components/layout/SongsPageNav.tsx:219-243`).

**The SQL.** The current body is in `supabase/migrations/128_artist_public_names.sql`. Migration 129 did not change it. History: 068 created it, 069–071 added lyric matching and snippets, 100 added HTML stripping, and 116 lifted the 5-per-type cap.

- **Matching.** `needle = lower(btrim(q))`, then `strpos(lower(field), needle) > 0`, a plain case-insensitive substring test. There is no `tsvector`, no `pg_trgm`, no unaccent, no ё/е folding and no Cyrillic↔Latin folding. No search index exists in any migration. It works because the archive is small (about 1,176 tracks and 154 Versions).
- **Fields indexed, per result type:**
  - Song: `songs.name`, `songs.english_name`, and the lyrics, which are all three Scripts of every Version concatenated. A lyric match requires a needle of at least 3 characters.
  - Artist: `name`. The Various Artists sentinel is excluded.
  - Composer: `name`.
  - Track: `album_tracks.name`. Each result also carries the album name and the performer names, joined with " & ".
  - Album: `name`.
  - The list page's client-side filter (`src/pages/songs/SongsPage.tsx:456-461`) additionally matches `alternate_titles` and `alternate_spellings`. The RPC does not.
- **Lyric snippet ("context").** For each song, the function takes the first Version, in no defined order, that contains the needle. On that Version's concatenated Scripts it:
  1. turns `</p>`, `<br>` and literal `\n` into newlines;
  2. strips all tags;
  3. strips a legacy `{"html": "...` JSON wrapper;
  4. **deletes every digit**, which removes Marker numbers and also any real numbers in the lyric;
  5. collapses runs of spaces and tabs.

  It then splits on newlines and returns the trimmed text of the **first line that contains the needle**. So the context is the whole matching lyric line, not a window of characters. Migration 070 used a ±35-character window, and 071 replaced it with the whole line. The `~125-char` comment in `landingSearch.ts` is out of date.
- **`matched_in`.** `'name'` if the song title or English title matched, and in that case no snippet is returned. Otherwise `'lyrics'`.
- **Hidden rows.** Hidden rows are returned only when `get_my_role()` is admin, moderator or reviewer. The client filters them out again as a second check.

**Grouping and ranking.** `order by grp, score, name`.

- `grp` sets the group order: song 0, artist 1, composer 2, track 3, album 4.
- `score` within songs:

  | Score | Song title or English title match |
  |---|---|
  | 0 | Title equals the query |
  | 1 | Title starts with it |
  | 2 | Title contains it |
  | 3 | English title starts with it |
  | 4 | English title contains it |
  | 5 | Lyrics only |

- Artists, composers and albums score 0 (exact), 1 (prefix) or 2 (contains).
- Tracks score 1 (prefix) or 2 (contains).
- Ties are broken alphabetically by name.
- There is no cap on the number of results (migration 116).

**Result rendering.** One flat listbox: name, plus " · English title" or " · album"; a type label, plus "by Artist" for tracks; a region label. For lyric matches it adds a "Lyrics:" line rendered as `highlightSnippet(snippet, query)…`, with CSS ellipsis on overflow (`LandingPageV3.tsx:741-785`, `.lp-result-snippet` at `:1408`). Clicking a track lazy-loads the full joined row (`fetchTrackForModal`) and opens the quick-view lyrics modal.

**Highlighter.** `highlightSnippet(snippet, query)` in `src/components/search/highlightSnippet.tsx` is about 20 lines. It lowercases both strings and loops `indexOf` over the result, emitting text fragments and `<mark class="search-hl">` elements as React children, so it never uses `dangerouslySetInnerHTML`. The snippet is already plain text. The single style rule is `.search-hl` in `src/index.css:745`.

**Known weaknesses.** Each of these should be fixed in a port, not copied.

- No folding between scripts or spellings. A Latin query reaches Cyrillic songs only through the transliteration text, and never through titles.
- Stripping digits damages any snippet that contains numbers.
- The snippet comes from an arbitrary Version, because the lateral subquery has `limit 1` and no `order by`.
- The client highlighter matches the raw query, while the server matched the trimmed and lowercased needle. `lower()` and JavaScript's `toLowerCase()` can disagree on rare characters.
- Only the first matching line is shown, even when a song matches in several places.

## 5. What TuvaVideos could port, and what it should not reuse

### Pure logic to port

These have no React and no design tokens, except where noted.

| What | Archive path | Notes for the port |
|---|---|---|
| Script triple and helpers: `SCRIPTS`, `scriptText`, `scriptFootnotes`, `presentScripts`, `effectiveScript`, `LYRICS_LANG` | `src/lib/lyrics/scripts.ts` | Remove the i18n label keys and the `SongEditEventType` import. Keep the columns, `lang` and clamping. |
| `FootnoteEntry`, `LyricLine`, `Stanza`, `LyricsFieldIssues` types | `src/types/index.ts:74-93`, `src/lib/lyrics/types.ts` | Port as is. They match the mirrored `song_lyrics` columns. |
| `parseHtmlToLines`, `groupLinesIntoStanzas`, `markersInReadingOrder`, `validateLyricsField`, `stripHtml`, `escapeHtml`, `plainTextToHtml`, `clampStanzaIndex` | `src/lib/lyrics/normalize.ts` | Port as is. The read path needs only these. Skip `renumber…`, `computeLyricsDiff` and the paste sanitizer, because the Mirror is read-only. |
| `augmentMarkers`, `entriesById`, `markerDomId`, `footnoteDefDomId`, the `MarkerCase` logic | `src/lib/lyrics/markers.ts` | Port the function. Drop the `useMarkerLabel` / `useAugmentedLyricLines` hooks, which depend on react-i18next, and pass a plain labeller instead. |
| HTML sanitizer allowlists `LINE` and `FOOTNOTE` | `src/lib/sanitize.ts` (`PROFILE_CONFIG`) | Copy the two configs and keep DOMPurify. Mirrored HTML is still untrusted input. |
| Rich-text guard `RICH_TEXT_PATTERN` | `src/lib/lyrics/richText.ts` | Useful as an import-time assertion on the Mirror. |
| Track Version resolution: `openingVersionIndex`, `isTrackVersionAt`, `DEFAULT_VERSION_LABEL` | `src/lib/lyrics/trackVersion.ts` | Applies directly to a Chapter that points at a Song and a Version. |
| Plain-text footnote parser `migratePlainTextToRichText` | `src/components/lyrics/pasteMigration.ts` | Optional. Only needed for ingesting plain-text lyrics. |
| Match highlighter `highlightSnippet` | `src/components/search/highlightSnippet.tsx` | Pure apart from the JSX `<mark>`. Fix it to match on a normalized needle (see the next row). |
| Loose name key `artistNameKey`: NFKD, drop combining marks, lowercase, keep letters and digits, collapse doubled letters | `src/lib/artists/matchArtistName.ts` | A good starting point for a search normalizer that handles spelling variants (Kongar-ol / Kongar-ool). The archive has no Cyrillic↔Latin transliterator to port. |
| Search scoring rule: exact 0 / prefix 1 / contains 2, plus a group order | `supabase/migrations/128_artist_public_names.sql` (the `search_archive` body) | Port the rule, not the SQL. A single-user local library can run it client-side, or in SQLite, over the Mirror. |
| Snippet cleaning steps: block tags to newlines, strip tags, find the first line containing the needle | the same function | Reimplement over `parseHtmlToLines` and `stripHtml`, then remove Markers by deleting `<sup data-fn>` elements instead of every digit. |

### Tied to the archive's design system (do not reuse)

- `src/components/lyrics/LyricsViewer.tsx`: theme hook, inline palette values, `font-accent` / `font-body` tokens, i18n namespace loading. Its interaction model is worth copying as a spec: tooltip on hover or focus, scroll-to-definition, `[` and `]` navigation, touch double-tap.
- `src/components/ui/LyricsModal.tsx`, `LyricsModalMobile.tsx`, `VersionStepper.tsx`: the archive's `Modal` shell, framer-motion, CSS variables and lucide icons.
- `src/pages/songs/SongDetailPage.tsx` (3,250 lines): `sd-*` classes, pills, segmented controls, edit mode.
- `src/pages/songs/sections/LyricsFullscreen.tsx` and `src/lib/lyrics/fullscreenFit.ts`: the type-fit budget is tuned to the archive's fonts.
- `src/pages/landing/LandingPageV3.tsx` and `src/components/layout/SongsPageNav.tsx`: the listbox UI, `lp-*` styles, region labels and i18n `Trans` bylines.
- `src/index.css` footnote rules (`sup[data-fn]`, `[data-adjacent]::before`) and `.search-hl`. Re-create the behaviour (raise the Marker, draw a comma between adjacent Markers) in TuvaVideos' own styles.
- `src/lib/landingSearch.ts`: tied to the Supabase RPC, the region/country model and hidden-row roles, none of which exist in a local single-user mirror.

## 6. Implications for TuvaVideos

- The Mirror should store each Version with its three HTML columns and three footnote arrays exactly as the archive does. Every function in the "port" table above then works on mirrored rows without change.
- A Chapter's `(Song, Version)` pointer has the same semantics as a Track Version: a null Version means the first in display order. Use `openingVersionIndex`.
- Search over the Mirror can be local. The archive's own approach is a substring scan with simple scoring, and it is enough at this scale. Its known weaknesses (no folding between scripts or spellings, digit stripping, arbitrary snippet Version) are the parts to improve rather than copy.
