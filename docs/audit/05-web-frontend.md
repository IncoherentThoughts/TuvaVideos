# Audit 05: Web frontend (src/web, and the src/shared modules it uses)

Auditor 05, 2026-11-04. Method: read the code, then ran the app (`TUVA_PORT=4505`/`4515`, scratch data dir, four
ffmpeg-made test Videos including a 21-minute one) and drove it with Playwright. Scripts and screenshots are in the session
scratchpad (`audit-05/*.cjs`). No source file was changed.

**Summary.** The lyrics/HTML path held up. A sanitizer fuzz in a real DOM (50 payloads × LINE, FOOTNOTE and
`augmentMarkers`) found no bypass. Payloads planted as raw HTML in `local_version`, and as Song, Version, Artist,
Chapter and Video titles, never ran on any page. So the security auditor's cross-site Local Song/Artist POST does
**not** become stored XSS today. The real problems are state bugs. Three are confirmed in the browser. Play stays
mounted between Videos, so per-Video UI state and late responses carry over to the next Video: a Delete dialog moves to
another Video (WEB-1), a stale response blanks the page (WEB-5), a lyrics draft is thrown away (WEB-4). The Audio
panel loses settings in two confirmed ways (WEB-2, WEB-3). One more, found by code trace and not run, is that a Sync
never reloads the in-memory library (WEB-6).

| ID | Severity | Status | Location | Title |
|---|---|---|---|---|
| WEB-1 | High | CONFIRMED | src/web/Play.tsx:279,401-411; src/web/keys.ts:88-93 | Delete dialog follows navigation (`r`, Playlist advance) and opens for a different Video |
| WEB-2 | High | CONFIRMED | src/web/AudioPanel.tsx:111-144; src/web/audioAnalyze.ts:110 | Cancelling sampled Auto wipes and saves the Video's Audio settings; Cancel doesn't stop the measurement |
| WEB-3 | Medium | CONFIRMED | src/web/Play.tsx:247-264 | Audio change made less than 400 ms before leaving the Video is never saved |
| WEB-4 | Medium | CONFIRMED | src/web/Play.tsx:304-306,431; src/web/Lyrics.tsx:78 | Lyrics editor draft thrown away when the playhead crosses into a Chapter with a different Song |
| WEB-5 | Medium | CONFIRMED | src/web/Play.tsx:181,191-196,318,431; src/web/Player.tsx:578 | Late `api.video(oldId)` responses replace the new Video: "No such Video." and the Player restarts |
| WEB-6 | Medium | CONFIRMED (code trace, not run: needs Supabase) | src/web/session.ts:171-212; src/web/data.ts:167 | A Sync never reloads videos, artists or the Song cache: the grid shows pre-Sync data until a reload |
| WEB-7 | Medium | CONFIRMED | src/web/data.ts:50-61; src/web/writeLink.ts:121-131 | Song cache is never dropped when a Video or Chapter Song pointer changes: `?song=` filter and openLyrics are stale |
| WEB-8 | Low | PLAUSIBLE | src/web/LyricsPage.tsx:10-28 | LyricsPage keeps `confirm` and the old `song` across `/lyrics/A` → `/lyrics/B`: the Delete prompt carries over |
| WEB-9 | Low | CONFIRMED | src/web/Player.tsx:776-788 | `!` / PgUp before the first Chapter jumps *forward* to it |
| WEB-10 | Low | PLAUSIBLE | src/web/audioEngine.ts:186-191; src/web/audioCleanup.ts:58-66 | `dispose()` leaves the denoise AudioWorkletNode running (process() always returns true): one leaked per Video |
| WEB-11 | Low | CONFIRMED | src/web/keys.ts:80-93 | Global `r`, `/` and the arrows ignore an open modal `<dialog>` (only `v` checks it) |
| WEB-12 | Low | PLAUSIBLE | src/shared/playlist.ts:131 | Repeat list wrap reshuffles the whole order, so the Entry that just ended can play again straight away |
| WEB-13 | Low | CONFIRMED | src/web/styles.css:9,35; themes/*/theme.css | `.dim` (`--fg3`) text is 2.8 to 3.9:1, below 4.5:1, and it carries warnings such as "This cannot be undone." |
| WEB-14 | Low | CONFIRMED | src/shared/lyrics/sanitize.ts:17 | LINE profile keeps `id` and `class` on lyric HTML: planted lyrics can clobber app ids (`lyrbody`, `fn-def-*`) and use app classes |
| WEB-15 | Low | PLAUSIBLE | src/web/data.ts:202-214 | toggleFavorite rolls back on error to a whole-library snapshot, undoing unrelated changes made meanwhile |

Counts: High 2, Medium 5, Low 8.

---

## WEB-1 (High, CONFIRMED): the Delete dialog follows navigation and opens for a different Video

**Description.** `Play` is not keyed by `videoId` (main.tsx:45). Moving from `/play/A` to `/play/B` keeps the same
`Play` instance. `deleting` is plain `useState` (Play.tsx:279) and nothing resets it when `videoId` changes. During the
load, `Play` returns "Loading…", which unmounts the `<dialog>` without firing `close`, so `deleting` stays `true`. When
B arrives, `<DeleteVideoDialog video={v}>` mounts again and calls `showModal()` for **B**. The global `r` handler
(keys.ts:88-93) does not check for an open dialog. `r` with the dialog's autofocused Cancel button focused navigates to
a random Video. A Playlist Entry ending behind the dialog navigates too (Player keeps playing; `goTo` → `navigate`).

**Failure scenario.** The user opens "Delete from library…" on Video A and presses `r` (or a Playlist Entry ends). The
confirmation now names Video C, a Video they never asked to delete. A user who meant to delete A clicks "Delete entry"
(or "Delete and trash files"), and C is deleted, files possibly trashed.

**Evidence.** Playwright (`audit-05/del.cjs`). On `/play/<Alash song>`, click Delete, focus is on `BUTTON Cancel`, the
dialog title is "Alash song". Press `r`. The URL becomes `/play/<Third>` and `dialog[open] .ttl` = "Third".

**Fix.** Key `Play` by `videoId` in main.tsx, or reset `deleting` (and the other per-Video state, see WEB-4) in the
`[videoId]` effect. Separately, have keys.ts ignore `r`/`/`/arrows while `dialog[open]` exists (WEB-11), and close the
dialog when the Video it was opened for is no longer the one shown (pass `videoId` and compare).

## WEB-2 (High, CONFIRMED): cancelling sampled Auto wipes the saved Audio settings and does not stop

**Description.** `runAuto("sampled")` first calls `onChange(DEFAULT_AUDIO)` (AudioPanel.tsx:130). The page's
`changeAudio` debounces a PUT to the server 400 ms later, and an all-default state is stored as `null`.
`analyzeSampled` gets no AbortSignal (AudioPanel.tsx:133, audioAnalyze.ts:110). On Cancel, `abort()` and
`setAuto(idle)` run, but the loop carries on seeking, muted. Its `onProgress` sets the phase back to "busy". At the end,
`if (ac.signal.aborted) return;` skips applying, and nothing restores the settings saved before.

**Failure scenario.** A Video with hand-tuned Audio settings (on a Copy over 20 min or 1 GB, the Copies that offer
"Sample 5 places"): Auto, Sample, then Cancel. The settings are gone for good, saved as defaults. The Video goes on
jumping around muted for about 6 s after "Cancel", and a second click on Auto runs two measurements at once.

**Evidence.** Playwright (`audit-05/auto.cjs`, 21-minute Copy). Set balance to 0.1, which is saved (`GET
/api/videos/:id/audio` → `balance: 0.1`). Auto → "Sample 5 places" → click the wand to cancel. The wand still reads
"listening 20 % ×". The playhead goes on jumping, 113.7 s → 349.6 s in 1.5 s. Afterwards the saved state is `null`.

**Fix.** Pass `ac.signal` into `analyzeSampled` and check it between places. Keep the previous state and, on abort or
error, `onChange(previous)`. Measure through the chain without saving: give the engine a temporary state instead of going
through `onChange`. Ignore `onProgress` once aborted.

## WEB-3 (Medium, CONFIRMED): an Audio change in the last 400 ms before leaving is lost

**Description.** `changeAudio` debounces `api.setAudio` with a 400 ms timer (Play.tsx:258-263). The `[videoId]` effect
cleanup calls `clearTimeout(audioWrite.current)` (Play.tsx:254) and does not flush it. Nothing flushes on `pagehide`
either.

**Failure scenario.** The user nudges the EQ or balance and presses `>`/`n`, or a Playlist Entry ends, or they close the
tab. The change was heard and shown, but never saved.

**Evidence.** Playwright (`audit-05/lost.cjs`). In the Audio panel, ArrowRight on the first slider, then `>` at once.
The page moves to the next Video, and the previous Video's saved audio stays `{"state":null}`.

**Fix.** On cleanup, flush the pending write (keep the pending `{videoId, state}` in a ref and send it), and do the same
on `pagehide` with `sendBeacon`/`keepalive`.

## WEB-4 (Medium, CONFIRMED): the lyrics editor draft is lost when the playhead changes Chapter

**Description.** The drawer's target is the current Chapter's Song when that Chapter has one, else the Video's
(Play.tsx:304-306). It is rendered with `key={target.fromChapter ? "chapter" : target.songId}` (Play.tsx:431). Going from
the Video's Song into a Chapter with a Song changes the key and remounts the reader. Going from Chapter Song X to
Chapter Song Y keeps the key, but `useEffect(() => setEditing(null)…, [songId])` (Lyrics.tsx:78) closes the editor. In
both cases the `LyricsEditor` drafts are dropped without a prompt, while the Video plays on.

**Failure scenario.** In a concert, the user starts writing a Local Version of the current Song while it plays. The
next Chapter starts, and the textarea and everything typed in it vanish.

**Evidence.** Playwright (`audit-05/draft.cjs`). Video "Alash song" (Song S1) has a Chapter at 5 s linked to Song S2.
At t = 0.5, open Lyrics, "+", type a draft (the textarea holds the text). Play from 4.5 s. At t = 6.9 the drawer title
is "Second song" and there are no textareas.

**Fix.** While an editor is open, pin the drawer's target and don't follow the playhead (lift `editing` into Play, or
freeze `target` while it is set). At the least, ask before discarding a non-empty draft.

## WEB-5 (Medium, CONFIRMED): late responses for the previous Video replace the current one

**Description.** Because `Play` survives Video changes, every `setV` from a promise that started on an earlier Video
can land after the new Video loaded. These are unguarded: `refresh` (Play.tsx:181, after the favourite toggle);
`acceptChapters`'s `api.video(videoId)` (191-196); `HeaderTitle/HeaderFields/RelocateButton/AcceptAll onChange={setV}`;
the `onPickVersion`/`onChangeSong` writeLink callbacks (431); and the Player's `countView → onVideo(fresh)` (Player.tsx:578).
The old Player's pending recordView resolves after it has unmounted. With `v.id !== videoId`, Play renders "No such
Video." (Play.tsx:318). That unmounts the new Player, which remounts on the next 3 s poll and loses the playhead and
playing state.

**Failure scenario.** The user stars a Video and steps to the next while the server is slow (a scan or Sync running).
The new Video blinks to "No such Video." for up to 3 s, then starts over.

**Evidence.** Playwright (`audit-05/stale.cjs`). GET `/api/videos/<A>` is delayed 1.2 s. Click the favourite, then go to
B 150 ms later. Sampling every 250 ms gives `player ×4 | No such Video. ×7 | player`.

**Fix.** Key `Play` by `videoId` (it also fixes WEB-1 and part of WEB-4), or guard each `setV` with
`fresh.id === currentVideoIdRef.current`.

## WEB-6 (Medium, CONFIRMED by code trace): a Sync never reloads the in-memory library

**Description.** `runSync` (session.ts:171-212) dispatches `sync-end`, broadcasts the record and runs `afterSyncShare`.
It never calls `loadVideos`/`loadArtists` and never clears `songCache`. data.ts does not subscribe to the session.
`grep` finds no other `reloadAll`/`loadVideos` caller tied to a Sync. The only reloads are scan end (TopBar.tsx:51),
the user's own writes (writeLink.ts:339,359,443), Onboarding, ConflictNotice and History. `confirmSignIn` reconciles
and Syncs, and Account.tsx:269-275 just closes.

**Failure scenario.** A Member presses Sync, or signs in for the first time, or the focus Sync after ten minutes runs.
The Local copy now holds other Members' new Videos, titles, Artists and Chapters, but the grid, Artists page and search
dropdown's Video data stay as they were until the tab is reloaded. On first sign-in the shared library does not appear
at all. Only the open Video's 3 s poll picks up changes.

**Evidence.** Static trace above; not reproduced because Sync needs the archive (Supabase).

**Fix.** After a Sync that applied rows (`res.ok && res.applied`), call `reloadAll()` and clear the Song cache (export
a `forgetAllSongs()`), and announce `RELOADED_EVENT` for the open Video. Do it in each tab that gets the broadcast too.

## WEB-7 (Medium, CONFIRMED): the Song cache goes stale when a Video or Chapter Song pointer changes

**Description.** `api.song` caches each `SongDto` (with its `videos` list) for the page's life. The comment says the
Mirror only changes through the CLI, which is no longer true. It is dropped only by local Song/Version edits and row
writes (data.ts:82-86, writeLink.ts:336,431-433). Linking a Video or Chapter to a Song (writeLink's `video.update` /
`chapter.update`, local route writeLink.ts:124-131) does not forget the Song. Readers of `song.videos`: Library
`?song=` filter (Library.tsx:68-80), `openLyrics` (lyricsNav.ts:12-26), LyricsPage's list.

**Evidence.** Playwright (`audit-05/songcache.cjs`). `/?song=S1` shows "1 of 4". Link a second Video to S1, navigate
in-app back to `/?song=S1`: still "1 of 4". After a reload: "2 of 4".

**Fix.** In writeLink (both routes), forget the old and new `songId` of the Video or Chapter. Or don't cache the
`videos` part, or give the cache a short TTL.

## WEB-8 (Low, PLAUSIBLE): LyricsPage carries `confirm` and the old Song to the next page

**Description.** `LyricsPage` is not keyed by `songId` (main.tsx:46). `confirm` (the "Delete it and its local
lyrics?" prompt) and `err` are not reset on `songId` change. `song` keeps the old value until the new fetch resolves
(no reset, no alive guard). The prompt is also not guarded by `song.videos.length === 0`, unlike its button.

**Failure scenario.** The user clicks "Delete this local Song…" on A, then opens Song B from the search dropdown (which
navigates to `/lyrics/B` when no Video performs B). The Delete prompt is still there and now deletes B.

**Evidence.** Code trace (LyricsPage.tsx:10-28). Not run.

**Fix.** Key `LyricsPage` by `songId` in main.tsx, or reset `confirm`/`err`/`song` in the effect.

## WEB-9 (Low, CONFIRMED): "previous Chapter" before the first Chapter jumps forward

**Description.** In `perform("chapter")`, `i` stays −1 when the playhead is before every Chapter. `!`/PgUp gives
`Math.max(0, i - 1) = 0`, so it seeks forward to the first Chapter (Player.tsx:776-788).

**Evidence.** Key sweep (`audit-05/keys.cjs`): at t = 0.16 with one Chapter at 5 s, `!` gives t = 5.00 and the OSD
reads "Chapter: …".

**Fix.** For `dir < 0 && i < 0`, seek to 0 (or say "no earlier chapter").

## WEB-10 (Low, PLAUSIBLE): the denoise worklet outlives its Player

**Description.** `AudioEngine.dispose()` disconnects only `src` and `out` (audioEngine.ts:186-191). The
`AudioWorkletNode` made by `CleanupEngine.ensureDenoise` is still connected to `tail`. Its `port.onmessage` holds the
engine, and its `process()` always returns `true` (denoiseWorklet.ts:72,88). Per the Web Audio spec that keeps it alive
and scheduled on the shared AudioContext (never closed). Each Video played with Denoise on leaves one node, its FFT
buffers and an 8192-point analyser.

**Evidence.** Code trace. Not measured (Chrome exposes no node count).

**Fix.** Add `CleanupEngine.dispose()`: disconnect every node, `dn.port.onmessage = null`, post `{type:"stop"}`, and
have `process()` return `false` once stopped. Call it from `AudioEngine.dispose()`.

## WEB-11 (Low, CONFIRMED): global keys ignore modal dialogs

**Description.** keys.ts's capture handler checks `dialog[open]` for `v` only (line 75). The bubbling handler runs `/`,
`r` and the grid arrows whenever focus is not in a text field: a focused dialog button counts. `r` navigates under the
modal (the cause of WEB-1). The Sign-in dialog lives in TopBar, so it stays open over a new page. `/` and the arrows call
`preventDefault()` and try to focus elements made inert by the modal.

**Evidence.** WEB-1's repro (`r` from the Delete dialog's Cancel button).

**Fix.** Return early from the bubbling handler when `document.querySelector("dialog[open]")` exists, or when
`e.target` is inside one.

## WEB-12 (Low, PLAUSIBLE): Repeat list can replay the Entry that just ended

**Description.** On wrap, `advance` shuffles the whole `pl.order` (playlist.ts:131). With n Entries, the Entry that just
ended comes first again with probability 1/n, so it plays twice in a row: half the time in a two-Entry Playlist.

**Fix.** After reshuffling, if `wrapped.order[0]` is the last-played index and n > 1, swap it with a random later
position.

## WEB-13 (Low, CONFIRMED): `.dim` text fails WCAG AA contrast

**Description.** `.dim { color: var(--fg3) }` is used for whole sentences, not only decoration: DeleteVideo's "This
cannot be undone." and "Moves … to the Trash", the Lyrics "From the archive Mirror.", the Footnote "(empty)" and the
Account notices. The ratios, computed from the tokens, are below. themes.md's own rule for muted text is ≥ 3:1, and AA
for body text is 4.5:1.

| Theme | `--fg3` on `--bg` | `--fg3` on `--bg2` | Wall `--fg3` on `--bg3` |
|---|---|---|---|
| Wall | 3.47 | 3.16 | 2.76 |
| Lawson Night | 3.85 | 3.40 | |
| Mecha no Onna | 3.71 | 3.42 | |

**Fix.** Use `--fg2` (4.8 to 5.3:1) for sentences and warnings, and keep `--fg3` for hints next to stronger text. Or
lift `--fg3` to at least 4.5:1 in each theme's formula.

## WEB-14 (Low, CONFIRMED): lyric HTML can set `id` and `class`

**Description.** The LINE profile (ported byte for byte from the archive) keeps `class`, `id`, `role` and `tabindex`.
Lyrics written by any Video Editor (Proposed Versions), or by any website through the cross-site Local Song POST the
security auditor reported, keep them. `<span id="lyrbody">` duplicates the drawer body's id (the target of the Lyrics
button's `aria-controls`). `id="fn-def-<prefix>-<n>"` hijacks `document.getElementById` in the Footnote jump
(Lyrics.tsx:132). Any app `class` (overlay, menu, card…) styles planted text as app UI. That is not script execution,
but it can spoof UI.

**Evidence.** Seeded `<span id="lyrbody">clobber</span>` came back in `/api/songs/:id` and rendered with that id.

**Fix.** In the web reader, after `augmentMarkers`, drop or prefix `id`/`class` that the app did not add (e.g. allow
only `footnote-ref` and `ln-blank` classes and the marker ids `augmentMarkers` writes).

## WEB-15 (Low, PLAUSIBLE): toggleFavorite rollback restores a stale snapshot

**Description.** `const before = state.videos` is taken before the request, and on error `set({ videos: before })`
(data.ts:202-214). Any `replaceVideo`/`loadVideos` that landed while the request was in flight (the Play poll, a
view count, a scan reload) is undone in the grid. The error also leaves the sticky "Server problem:" banner.

**Fix.** Roll back only that Video's `favoritedAt` against the current `state.videos`.

---

## Checked and found OK

- **HTML sinks.** Every `dangerouslySetInnerHTML` was traced: Lyrics.tsx:349,365,375, SearchBox.tsx:25-65,
  SearchResults.tsx:83-103, Library.tsx:40. Lines go through `augmentMarkers` → `sanitizeLine` on the client. Footnotes
  are sanitized by the server on every read (songs.ts:35-36, which covers archive, Proposed and local rows). All search
  highlighting goes through fold.ts `highlightHtml`/`escapeHtml`, which escapes `& < > "`. Server `htmlToLines` decodes
  entities, and the client escapes again.
- **Sanitizer fuzz** (sanitize.ts tokenizer). 50 payloads in Chromium: unquoted, `/`-separated, tab and newline
  attributes; nested `<b<img>`; quoted `>` in attributes; comments `<!--!>`; `<?`/`<!x>`; script/style/title/textarea/
  xmp/noembed; svg and math mXSS; table foster-parenting; entity-encoded quotes; and marker-regex injection through
  `augmentMarkers`. Each ran through all three paths, was parsed into the DOM and checked. No disallowed element and no
  `on*`/`style`/`href`/`src` attribute came out. Rebuilding tags and escaping attribute values makes the output safe
  however the parse goes.
- **End-to-end planted payloads.** `<img onerror>`/`<svg onload>` as a Video filename/title, Song name and English
  name, Version label, Local Artist name and Chapter title, plus 13 raw-HTML lyric lines and footnotes written straight
  into `local_version`. Pages: Library, Now playing with the drawer open, every marker hovered, `/lyrics/:id`,
  Artists, Songs, `/search?q=…` and the dropdown. `window.__xss` stayed undefined, with no dialog and no injected
  handler. This covers the cross-site Local Song/Artist chain: it gives no XSS with the sanitizer as it is.
- **Links built from Shared data.** YouTube, Instagram and Rutube hrefs and `sourceLink` all have a fixed
  `https://…/` prefix, so a `javascript:` URL can't be planted.
- **Theme loading.** theme.ts accepts only registry ids. index.html accepts `^[a-z0-9-]+$` only, and the server
  refuses `..`. No theme data reaches HTML.
- **Player keys.** Every README Player key was run in the browser (`audit-05/keys.cjs`): space, p, ←→, ⇧←→, ↑↓, `,` `.`,
  `[` `]` `{` `}`, ⌫, 9, 0, m, l, `!` `@`, PgUp, PgDn, `<` `>`, o, O, i, y, a, n, N, x, e, q, `/`, Esc. Each does what
  the README says, apart from WEB-9. `keyguide.ts` matches the README. ⇧↑/⇧↓ (±5 s exact) exist but neither lists them
  (doc gap only). Plain arrows snap to keyframes: with sparse keyframes "→ +5 s" went 0.3 → 10.15, as the Keyframe seek
  definition says. Player keys fire only while the container itself has focus. Global keys skip text fields. Lyrics
  `[` `]` stop propagation, so they never reach the Player's speed keys.
- **Player lifecycle.** The Player is keyed `${v.id}:${nonce}`. Media listeners belong to the element, which is thrown
  away with the Player. Document and window listeners, the 50 ms tick and the OSD and seek timers are all cleared. The
  `load()` after `removeAttribute("src")` drops the queued `pause` event (HTML load algorithm), so no Resume 0 is
  written on leave. Async Copy loads are guarded by `token`.
- **Other effects.** SearchBox aborts and debounces earlier requests. SearchResults aborts. The Play and Lyrics
  reader fetches use `alive` guards (apart from WEB-5's list). AudioPanel meters, CleanupSection rAF, StatePanel,
  Studio timers, TopBar scan poll and useWindowed's IntersectionObserver all clean up.
- **Playlist model.** start, setShuffled, advance (skips unavailable, wrap only with Repeat list), stepBack, jumpTo,
  jumpToVideo, widenToVideo, `isPlaylist` validation of sessionStorage, and `nextEntry` (Repeat one only for `via:
  "end"`). Chapter Entry end detection. Repeat one restart. Ended state.
- **Router.** Trailing slashes, `?t=` validation, UUID-only `/play/` paths, no-op on navigating to the same URL,
  modifier and middle clicks left to the browser.
- **Large libraries.** The grid, search results and Playlist panel are windowed. Library filtering and sorting are
  memoised on `[videos, st]`. Search runs on the server, debounced.
- **Dialogs.** Native `showModal()` dialogs (Delete, Sign in, History, Proposed rows) get the browser's focus trap and
  Esc, and autofocus Cancel or OK. The Player, drawers and panels give focus back to the Player on close.

## Not covered / blocked

- Sync, sign-in, Proposed/Elevate and conflict flows were not run end to end, because they need a Supabase archive.
  WEB-6 is static.
- Studio playback was not run: it needs macOS `osascript` and Music.app.
- Chapters.tsx inline editing, HeaderEdit pickers, History/Shelved views, TvButton and Relocate got only a skim.
- No measured performance profile on an 1800-Video library: this machine had 4 Videos.
- Screen-reader behaviour was not tested; accessibility was limited to focus, labels and contrast.
- My test server on 4505 was killed by another auditor's `pkill` partway through. I restarted it on 4515 and redid the
  affected steps.
