# Audit 08: spec, doc and code conformance, dead code

Auditor 8 of 8, 2026-11-04, read-only, against `main` at 2f7b8bf. Scope: docs/spec.md, sharing-spec.md, tv-spec.md, playback-architecture.md, playlist.md, data-model.md, chapter-pipeline.md, studio-playback.md, themes.md, docs/adr/*, CONTEXT.md, README.md, compared with src/, scripts/, migrations/.

## Summary

The behaviour rules most likely to hurt users match the code. These were checked: the 30 s Resume rule, Preferred Copy ordering, no scan at startup, one Root per machine, the Root field errors, the schema-gate banner text and Sync stopping on a mismatch, grants never made from the app, at most one Fallback per Copy, the TV route list, and the matcher thresholds. Two code defects are real and confirmed. Reloading or deep-linking `/edits` returns 404 (DOC-1). Sign-in reconciliation shelves the scan's default Type `song` as if it were a user edit, because both the code and sharing-spec still treat `other` as the default (DOC-2). The rest is doc drift. The retired Mirror still appears in user-visible strings. spec.md and data-model.md still describe the Mirror schema and the integer-id schema as normative. The ADRs are not marked superseded. CONTEXT.md retired "Local Song/Version/Artist" while the UI still uses those terms. Dead code is small: one unused module and a few unused exports.

## Findings

| ID | Severity | Status | Location | Title |
|---|---|---|---|---|
| DOC-1 | Medium | CONFIRMED | src/server/api.ts:540 vs sharing-spec §4.8 | `/edits` is a client route but the server does not serve the shell for it: reload or a direct link gives 404 |
| DOC-2 | Medium | CONFIRMED | src/server/reconcile.ts:116,122 vs spec.md §2.3, sharing-spec §2.3 | Reconciliation treats `other` as the default Type, but scans have used `song` since 2026-10-12, so a spurious "Type: song" Shelved edit appears |
| DOC-3 | Medium | CONFIRMED | src/web/Lyrics.tsx:315,318,336; LyricsPage.tsx:27; Songs.tsx:106; Artists.tsx:151; shared/listView.ts:13 | The retired "Mirror" is still shown to users (and in `/artists?kind=mirror`) |
| DOC-4 | Medium | CONFIRMED | CONTEXT.md "Sharing" intro vs UI and sharing-spec §4.6, §7.3, §7.5 | The glossary retired Local Song, Local Version and Local Artist, but the app and specs still use them, and no glossary entry defines them |
| DOC-5 | Medium | CONFIRMED | docs/spec.md §1, §2.2, §2.4, §7.2–7.3; docs/data-model.md | The v1 spec ("this document wins") and data-model.md ("the DDL there is normative") still describe the Mirror, `bun run import`, integer ids, macOS-only and single-user, with no superseded markers |
| DOC-6 | Low | CONFIRMED | docs/adr/0001, 0005, 0006 | The ADRs carry no status: 0001 is not marked superseded by 0009, and 0006 is not marked as amended by 0007 or as having its clause closed by 0009 |
| DOC-7 | Low | CONFIRMED | ADR 0009 vs src/server/sync.ts:135-150, sharing-spec §6.1, §6.4 | ADR 0009 says the Local copy is "never wiped" and that "nothing on disk is renamed". The code wipes on a full refetch and renames thumbnails at every startup |
| DOC-8 | Low | CONFIRMED | ADR 0004 vs tv-spec §6.8, §10 | ADR 0004 allows a per-play Audio preset on the TV. tv-spec defers it ("Later") and the code has none |
| DOC-9 | Low | CONFIRMED | ADR 0005, ADR 0008 | Stale wording: "lowest id" (ids are uuids; the code uses `created_at, id`), and "Import parses the Rutube id" (the import is gone; `archiveRows.ts` does it at apply) |
| DOC-10 | Low | CONFIRMED | src/web/chipView.ts:51 vs sharing-spec §2.2, §5.1 | The no-grant text reads "This account has no access to the shared library". The spec says "No video library access" |
| DOC-11 | Low | CONFIRMED | src/tv/ui.tsx:44, src/tv/tags.ts:18 vs CONTEXT "Suggested", tv-spec §5.1 | TV cards drop Suggested Artists. That contradicts "behaves like a confirmed one until rejected" and "a card is the browser's" |
| DOC-12 | Low | CONFIRMED | README "Player keys", src/shared/keyguide.ts vs keymap.ts:52-55, spec §4.5 | `⇧↑` / `⇧↓` (exact ±5 s) are bound in the code but missing from the README table and the State panel's guide |
| DOC-13 | Low | CONFIRMED | README "Run from source" vs scripts/setup.ts:31-45, sharing-spec §8.3 | The README tells Windows users `winget`, while `bun run setup` prints `scoop` commands |
| DOC-14 | Low | CONFIRMED | README "Maintainer commands", env-var line vs package.json, config.ts | `suggest-songs` is undocumented, and so are `TUVA_TV_PORT`, `TUVA_YT_CACHE`, `TUVA_SCREENSHOT_DIR`, `TUVA_TRASH`, `TUVA_EXTERNAL_ROOT`, `TUVA_ARCHIVE_URL/KEY` and the passive-port rule |
| DOC-15 | Low | CONFIRMED | spec.md §9 vs src/server/launch.ts:39-40 | The spec says the Music.app probe runs before the tab opens. The code fires it without awaiting and opens the tab at once |
| DOC-16 | Low | CONFIRMED | spec.md §5.1 vs §9; src/web/TopBar.tsx:113-117 | spec.md gives two tab orders. The code follows §9 |
| DOC-17 | Low | CONFIRMED | docs/themes.md step 5 vs src/web/Account.tsx:11 | The Theme select is in the account chip menu, not the top bar |
| DOC-18 | Low | CONFIRMED | playback-architecture.md "Verdict" vs spec.md §3.4 | playback-architecture says the remux case is "yt-dlp `.fNNN` partials". The spec and the scan skip partials |
| DOC-19 | Low | CONFIRMED | tv/shell/README.md, scripts/lg-install.ts vs tv-spec §1, §4 | An LG webOS package and install path exist, but tv-spec describes Samsung/Tizen only |

## Details

### DOC-1: `/edits` returns 404 on reload or direct link (Medium, CONFIRMED)

- **Doc:** sharing-spec §4.8 (amended #147): "a library-wide **Edits** view from the chip menu … the Edits view is the route `/edits`".
- **Code:** the client router knows it (`src/web/router.tsx:57`, `if (p === "/edits") return { name: "edits" }`). The server's shell allow-list at `src/server/api.ts:540` serves `index.html` only for `/`, `/favorites`, `/search`, `/artists`, `/songs`, `/play/:uuid` and `/lyrics/:id`. I ran the app (TUVA_PORT=4508, scratch data dir): `GET /edits` and `GET /edits?editor=x` both returned **404**, while `/songs` and `/artists` returned 200. Navigating inside the app works. A reload, a bookmark or a link pasted to another tab does not.
- **Wrong side:** the code.
- **Fix:** add `p === "/edits"` to the shell condition at api.ts:540, and add a test that walks every `router.tsx` route against the server.

### DOC-2: Reconciliation shelves the default Type (Medium, CONFIRMED)

- **Doc:** spec.md §2.3: "new Videos start as `song`; before 2026-10-12 they started as `other`". sharing-spec §2.3 (as built, #149): "Only link data the Shared row does not already say is shelved: … a Type other than the default `other` that differs".
- **Code:** the scan inserts Type `'song'` (`src/server/scan.ts:335`). `shelvedFor` skips only `other` (`src/server/reconcile.ts:122`: `local.type && local.type !== "other" && local.type !== shared.type`). I ran it with bun: `shelvedFor({type:"song"}, {type:"concert"})` returns `[{"kind":"type","type":"song"}]`, and `{type:"other"}` returns `[]`.
- **Effect:** any Video scanned after 2026-10-12 and never touched by the user, which then meets a Shared Video whose Type is not `song`, gets a Shelved "Type" edit and an unseen amber dot. The confirmation dialog also counts it as something to shelve, so it appears even when nothing real would be shelved. This happens at sign-in and on every Sync (§2.3: "every Sync also runs the matching step").
- **Wrong side:** both. The code and the sharing-spec sentence were written against the pre-2026-10-12 default.
- **Fix:** treat an unedited Type as default. Either compare against the scan default (`song`, and also `other` for older rows), or better, shelve only when the local Type was set by hand (`type_suggested = 0` and `suggestion_source = 'manual'`). Amend sharing-spec §2.3 to match.

### DOC-3: The retired "Mirror" in user-visible text (Medium, CONFIRMED)

- **Doc:** ADR 0009 ("the four glossary terms are removed from CONTEXT.md"). CONTEXT.md, Shared: "_Avoid_: … mirror (which is the retired read-only copy)". Local copy: "_Avoid_: cache, mirror". spec.md §5.4 still prescribes "From the archive Mirror", and spec.md §5.1 names the Artists kinds "all / archive / local".
- **Code (shown to users):** `src/web/Lyrics.tsx:315` "This Song is not in the Mirror (unknown song).", `:318` "This Song has no Version in the Mirror: no lyrics.", `:336` "From the archive Mirror."; `src/web/LyricsPage.tsx:27` "Lyrics from the archive Mirror."; `src/web/Songs.tsx:106` title "Only Songs with lyrics in the archive Mirror"; `src/web/Artists.tsx:151` title "Artists from the archive Mirror"; the kind value is `"mirror"` (`src/shared/listView.ts:13`), so the URL reads `/artists?kind=mirror`.
- **Wrong side:** the code (and spec.md §5.4's quoted string).
- **Fix:** say "archive" ("From the archive.", "not in the archive"). Rename the kind to `archive`, and keep reading `mirror` in the query parser for old URLs.

### DOC-4: The glossary retired terms the app still uses (Medium, CONFIRMED)

- **Doc:** CONTEXT.md Sharing intro: "They replace the retired Mirror, Local Song, Local Version and Local Artist (ADR-0009)". ADR 0009: "the `local_*` tables survive only as this machine's own rows for Unshared Videos".
- **Code and specs still use the terms:** sharing-spec §7.3 "Local Versions, Local Songs and Local Artists are this machine's rows and stay editable". §4.6 "a **Local** Artist's Repoint". UI: the "add 'X' as local song" create row, the Songs tab's "New local Song…", the "local" mark (`Lyrics.tsx:325`), and `LyricsPage.tsx:26` "A local Song: created in this library". The README maintainer table says "Local Artists".
- **Wrong side:** the glossary. It dropped a concept that still exists.
- **Fix:** add a "Local (Song, Version, Artist)" entry: this machine's own row, pointable by Unshared Videos only, never Shared, becomes a Proposed row when its Video is shared.

### DOC-5: spec.md and data-model.md still normative for the retired schema (Medium, CONFIRMED)

- **Doc:** spec.md line 3: "Where this document and a per-topic doc disagree, this document wins". §2 says "The DDL there [data-model.md] is normative". §1 says "macOS only", "Single user. No auth", "SQLite is the only store. Mirror entities are read-only and refreshed by importing". §2.2 lists `mirror_import` and `mirror_*`. §2.4 says "Trigger: CLI only, `bun run import <backup-dir>`". §7.2 and §7.3 say "refreshed after each Mirror import" and "runs over every Mirror Track after each import". data-model.md shows `video` with `id INTEGER PRIMARY KEY` and `type … DEFAULT 'other'`, plus Mirror tables.
- **Code:** migration 0015 rebuilt everything on uuid `videos` / `video_chapters` / `archive_*`. package.json has no `import` script. The Studio matcher now runs from `runArchiveFollowUps` after a Sync (`src/server/localCopy/followUps.ts:32`). README and sharing-spec §8.2 support Linux and Windows. Only two §1 bullets carry a "Superseded" note.
- **Wrong side:** the docs. A reader following "this document wins" or "the DDL is normative" gets the wrong schema.
- **Fix:** put a banner on spec.md §2 and §2.4 and on data-model.md ("superseded by sharing-spec §6.1 and migrations 0015–0018; kept as history"). Mark the macOS-only and no-auth constraints and §11's "non-macOS" as superseded by sharing-spec §8.2, and soften line 3 so that sharing-spec wins.

### DOC-6: ADR status headers (Low, CONFIRMED)

ADR 0009 has front matter `supersedes: 0001 (entirely; 0006's … clause closes here)`. ADR 0001's file has no status and still reads as in force. ADR 0006 has no front matter and still says "ADR-0001 remains in force … until the sharing map retires them". ADR 0007 says it `amends: 0006`, but 0006 does not mention that. ADRs 0002–0005 have no status block at all. **Fix:** add `status: superseded by 0009` to 0001, and `amended by 0007; final clause closed by 0009` to 0006.

### DOC-7: ADR 0009's "never wiped" and "nothing renamed" (Low, CONFIRMED)

ADR 0009 says "the Local copy is upserted row by row, never wiped" and "thumbnail files already named by identity so nothing on disk is renamed". The code does the opposite. `wipeShared` (`src/server/sync.ts:142-147`) deletes every `archive_*` and Proposed table on a full refetch, as sharing-spec §6.4 (#139) specifies. `renameLegacyThumbnails` (`src/server/thumbs.ts:29`, called at :149) renames files at every startup, as §6.1 (#137) specifies. The code follows the spec. **Fix:** add an "Amended" line to ADR 0009.

### DOC-8: ADR 0004's per-play preset (Low, CONFIRMED)

ADR 0004: "an Audio preset can be picked on the TV for the current play only". tv-spec §6.8: "No per-play preset on the TV (later, §10)". `src/tv/` has no preset picker. **Fix:** note the deferral in ADR 0004.

### DOC-9: Stale wording in ADR 0005 and ADR 0008 (Low, CONFIRMED)

ADR 0005: a provenance match picks "the lowest id when several share it". Ids are uuids since 0015, and the scan uses `ORDER BY created_at, id` (`src/server/scan.ts:327-328`). Reconciliation instead picks the lowest uuid (`reconcile.ts:79`), so the two tie-breaks differ. ADR 0008: "Import parses the id out of rutube.ru performance URLs". There is no import any more. `parsePerformanceUrl` runs at apply (`src/server/localCopy/archiveRows.ts:17,107`). **Fix:** update the wording. Optionally make the two tie-breaks agree.

### DOC-10: No-grant text (Low, CONFIRMED)

sharing-spec §2.2: the menu shows the role pill "(or 'No video library access' for an account without the grant)". §5.1 says the same. The code shows `NO_ACCESS_LINE = "This account has no access to the shared library"` (`src/web/chipView.ts:51`, rendered at `Account.tsx:143` and `:370`), and its own comment at `chipView.ts:37` still quotes the spec wording. **Fix:** pick one wording and update the other side.

### DOC-11: TV cards hide Suggested Artists (Low, CONFIRMED)

CONTEXT "Suggested": "Behaves like a confirmed one until rejected". tv-spec §5.1: "A card is the browser's: … Type and Artist tags". `src/tv/ui.tsx:44` filters `!a.suggested` on every TV card, and `src/tv/tags.ts:18` does the same in the Player's tag row. tv-spec §6.4 documents this for the tag row only ("only confirmed Artists are tags"). spec.md §2.3 counts 826 of 1733 Videos with only Suggested Artists, so on the TV roughly half the cards show no Artist. **Fix:** decide on one rule. Either show Suggested Artists dashed (the browser's `sug` style already exists on the TV tag row), or write the exception into tv-spec §5.1 and the glossary.

### DOC-12: Missing `⇧↑` / `⇧↓` (Low, CONFIRMED)

`keyAction` binds them (`src/shared/keymap.ts:52-55`, exact ±5 s), and spec §4.5 lists "⇧↑ ⇧↓ … ±5 s". The README table and `src/shared/keyguide.ts` list only `⇧←` `⇧→`. spec §4.8 asks that the guide gain "any binding the guide is missing today". The test that diffs the guide against `keyAction` evidently tolerates the gap. **Fix:** add the row to both.

### DOC-13: Windows install commands (Low, CONFIRMED)

The README Windows row says `winget install Gyan.FFmpeg` and `winget install Google.Libwebp`. `scripts/setup.ts:31-45` prints `scoop install ffmpeg` / `scoop install libwebp`, which matches sharing-spec §8.3. **Fix:** align them, preferably on winget, which ships with Windows.

### DOC-14: README gaps (Low, CONFIRMED)

- package.json has `suggest-songs`, which spec §2.3 names as `bun run suggest-songs [id] [--dry-run] [-v]`. The README maintainer table omits it.
- `config.ts` reads `TUVA_TV_PORT`, `TUVA_YT_CACHE`, `TUVA_SCREENSHOT_DIR`, `TUVA_TRASH`, `TUVA_EXTERNAL_ROOT`, `TUVA_ARCHIVE_URL` and `TUVA_ARCHIVE_KEY`. The README names only five env vars.
- The README does not say that a `TUVA_PORT` other than 4400 on the default data dir makes a passive server, which skips the remount scan (`config.ts:84`).
- `TUVA_LOCAL_ROOT` is `INSERT OR IGNORE`d at every start (`roots.ts:52-56`), so changing it adds a second Root, against "one folder per machine". That is acceptable for a test-only var, but worth a line.

Everything else in the README checked out (see "Checked and found OK").

### DOC-15: Startup order (Low, CONFIRMED)

spec.md §9: "migrations → Root availability → Music.app `playerState()` read for the Automation prompt → open the tab". `launch.ts:39-40` does `void app.studio.probe(); if (cfg.openTab) openTab(...)`. The probe is not awaited, so the tab may open first, and the Automation prompt can land on top of the newly opened tab. That is cosmetic. **Fix:** await the probe with its existing 10 s cap, or reword the spec.

### DOC-16, DOC-17, DOC-18, DOC-19 (Low)

- DOC-16: spec §5.1 lists "Library, Now playing, Favorites, Artists". §9 lists "Now playing, Library, Songs, Artists, Favorites". `TopBar.tsx:113-117` follows §9. Fix §5.1.
- DOC-17: themes.md step 5 says "A Theme select in the top bar (prototype)". The select lives in the account menu (`Account.tsx:11` imports `THEMES`). Update the doc.
- DOC-18: playback-architecture.md attributes the remux case to "yt-dlp `.fNNN` partials". spec §3.4 says partials are skipped at scan and `remux` arises only for a normally named file with no duration. Fix the topic doc.
- DOC-19: `tv/shell/appinfo.json` and `scripts/lg-install.ts` (package.json `lg-install`) add an LG webOS target. tv-spec covers the Samsung R85H only. Add a short tv-spec note or section.

## Dead code and stale artifacts

| Path / symbol | Evidence of non-use | Suggestion |
|---|---|---|
| `src/shared/lyrics/richText.ts` (`isRichText`) | No import anywhere in src/, test/, scripts/ or tv/ | Delete |
| `src/server/search.ts:162` `rebuildVideoSearch` | Alias of `rebuildSearchIndex`, referenced nowhere | Delete |
| `src/shared/lyrics/scripts.ts` `scriptDef`, `SCRIPT_KEYS`, `LYRICS_LANG` | Referenced only at their definition | Delete or un-export |
| `src/shared/songNames.ts:53` `cyrillicNames` | Referenced only at its definition | Delete |
| Test-only exports: `panelRows` (playlistPanel.ts), `filterChips` (filters.ts), `unseenVideoIds` (editHistory.ts), `parseFrameRate` (playerMath.ts; the server has its own `frameRateValue`), `defaultArtistsState` / `defaultFavoritesState` / `defaultSongsState`, `groupLinesIntoStanzas` / `numberedLines` / `validateLyricsField`, `editBelongsTo`, `registeredKeyNames` | Used only by test/ | Keep if they are the tested spec of a rule. `parseFrameRate` vs `frameRateValue` is a duplicate to merge |
| Unused exported types: `ShelvedKind`, `ReconcileRunner`, `SyncRunner`, `ArchiveFunction`, `ElevateOp`, `SetSongExposureOp`, `SharedChangesSinceArgs`, `TargetType`, `VideoAccessProfileRow`, `WriteProposedOp`, `WriteVideoArtistsOp`, `WriteVideoChaptersOp`, `WriteVideosOp`, `SharedTableName`, `OpenList`, `ButtonId`, `LinkOpKind` | No reference outside their file | Harmless. Wire types in archiveWire.ts document the archive contract, so they can stay |
| `docs/WIP.md` | Dated 2026-10-11, "Uncommitted changes on `main`". Both items are in the tree now (`--no-suggest` in fetch-youtube-info.ts, `closeStudioRef` in Player.tsx) | Delete. Move its one open question (`--force` with explicit ids) to an issue |
| `docs/prune-proposal.md` | A one-off 2026-10-11 report; the pruning is done. Cited once in spec.md §1 | Move to `docs/research/` or mark as history |
| `docs/title-match-dry-run.md` | A one-off 2026-10-11 dry-run report, referenced by nothing | Move to `docs/research/` or delete |
| `tv/hello-world/` (incl. `results-run*.jsonl`) | tv-spec §4.1: "stay as history and are not shipped". Not in tsconfig `include`, so typecheck never covers it. No package.json script | Keep as history (decided). Could move under `docs/prototypes/` |
| `tv/home-prototype/` | Same as above, but package.json still has `"tv-prototype": "bun tv/home-prototype/serve.ts"` and `.claude/launch.json:21` points at it. It is outside tsconfig, so whether it still runs against the uuid API is unverified | Drop the package.json script, or keep it with a note that it is history |
| `migrations/0003_mirror.sql` | Historical. Migrations are recorded by file name, and 0015 renames `mirror_*` to `archive_*` | Keep: removing it would break fresh databases |
| Mirror identifiers in code: `studio_track.mirror_track_id`, `kind: "mirror"` (studio/service.ts:106, Studio.tsx:301), `TIER_MIRROR` (songMatch.ts:9), "`mirror_version`" comments (lyrics/scripts.ts:7,9,34), `--mirror` CLI flag (chapters/cli.ts:16) | Not user-visible except the CLI flag and the items in DOC-3 | Rename on touch to `archive`. The DB column needs a migration, so leave it |
| TODO/FIXME/XXX/HACK | None in src/, scripts/, test/, tv/shell/ or migrations/. The only "not built yet" is the TV Live remux, which tv-spec §3.4 and §6.6 document | Nothing to do |

## Checked and found OK

- **30-second Resume rule:** `FINISHED_WITHIN_S = 30`, finished is stored as 0, and the server applies the same rule (`src/shared/resume.ts:5`, `catalog.ts:101-113`). The 5 s cadence, the TV sharing the same rule, and `adoptResume` with its 1 s / 4 s thresholds all match tv-spec §2.5.
- **Preferred Copy:** local first, then native, then pixels, then smaller size (`src/server/ranking.ts:15-25`). On the TV, local first, then the TV profile, then the browser's order (`src/tv/copies.ts:13-16`), as tv-spec §3.2 says.
- **No scan at startup:** `app.ts:41-44,79-81`. Only a remount after startup scans, and a passive server never does (`config.ts:84`). The mount poll runs every 10 s (`roots.start(10_000)`).
- **One Root per machine:** `POST /api/roots` answers 409 once a Root exists (`api.ts:898`). Run live, it returned 422 "Enter the folder's full path", "Not found" and "Not a folder", then 201, then 409 "This machine already has a videos folder", and the scan started at once (log line "scan root local done").
- **Onboarding surfaces** (panel / bar / none) are as §8.4 describes (`rootSetup.ts:76-80`).
- **Grants never made from the app:** nothing in `src/` writes `video_access`. Only `scripts/grant-video-access.ts` (with `member|editor`) does, and the README states the rule.
- **Schema gate:** `schemaGateLine` produces exactly "Update TuvaVideos: git pull, then restart" (`src/shared/session.ts:218`). Sync returns before the pull on a mismatch, both at whoami and on the batch's own `shared_schema` (`sync.ts:200,221-223`). The banner sits above the grid, cannot be dismissed, and clears on the next successful Sync.
- **Sync triggers and back-off** (1/2/4/8/10 min, focus after 10 min, no timer) are as §6.2 and §6.4 describe (`session.ts:225-262`). Watermark − 5 min with no moving back; retention is 90 days.
- **Fallback:** one per Copy (`copy.fallback_file`), a single queue, play requests first, `remux/<copyId>.<ext>`, and webm becomes mkv for AAC (`fallback.ts:40-52`). `decidePlayback` matches §3.4.
- **Live remux** is not built. It is documented as such (tv-spec §3.4, §6.6). The route is listed and answers 404 (`tv.ts:230`), and the message text matches tv-spec.
- **Missing vs unavailable vs Not on this machine:** `presence.ts` follows sharing-spec §7.1. The TV's `NOT_HERE_SQL` excludes Videos whose Copies are all Missing. The panel message matches §7.1 word for word.
- **TV route list** matches tv-spec §2.3 and ADR 0004 exactly (`tvRoutes.ts:25-51`). The TV rail order, the 24-tile cap, and the seek ramp 10/30/60/120 with 4 presses per rung and 60 s for rewind / fast-forward all match tv-spec §5.1 and §6.3.
- **Matcher thresholds:** Chapters 0.80 / 0.90 / 0.05, merge ±15 s, drop ±10 s, eligible over 20 min. Artists 0.90 / 0.92 / 0.85. Title Songs 0.95 / 0.98 / 0.97 / 0.04. Thumbnails: 480 px at 10 %, strip ≤100 frames × 160 px in 10 columns, pool of 4, single pass under 30 min.
- **Scan defaults:** new Videos start as `song`, and the Performance defaults match on YouTube or Rutube id, counting distinct Songs (`defaults.ts`). The identity order is YouTube id, content hash, Instagram, then Rutube, in both the scan and reconciliation.
- **Playlist:** the OSD strings match spec §4.8 (`playlistPlayer.ts:91-95`). The button labels are "shuffle random/results/favorites". `resumeOn` stays false inside a Playlist (`Player.tsx:303`).
- **README:** the data dir per OS (`config.ts:dataDirFor`), the binary lookup order (`TUVA_BIN_DIR`, then /opt/homebrew/bin, /usr/local/bin, then PATH: `findBin`), the defaults for `TUVA_PORT`, `TUVA_DATA_DIR`, `TUVA_LOCAL_ROOT` and `TUVA_NO_OPEN=1`, port 4400, the ⏻ quit button (`/api/quit`), the `bun run app` launcher, the yt-dlp filename template, and the section order required by sharing-spec §8.5. Every README key row matches `keyAction`, except the missing `⇧↑↓` (DOC-12).
- **ADR 0002** (browser `<video>`), **ADR 0003** (Music.app by JXA) and **ADR 0010** (browser writes, companion caches) are not contradicted by the code.

## Not covered or blocked

- I did not drive the browser UI: no visual pass on the chip menu, the Shelved drawer, Playlist panel windowing, or the edit-control hiding for Members. Strings and rules were checked in source.
- No archive or Supabase calls were made (out of bounds), so Sync, reconcile preview, poster upload and download, and the write RPCs were checked by reading only.
- Studio playback (needs macOS osascript; the probe failed on Linux as expected) and the TV on real hardware were not run.
- `docs/sharing-test-plan.md`, `docs/design-direction.md`, `docs/research/*` and `docs/agents/*` were not audited line by line.
- `tv/home-prototype` and `tv/hello-world` were not run, so whether they still work against the uuid API is unknown.
- The dead-code scan matched names textually: exports reached only through dynamic strings (worklet URLs, bundler entry points) were spot-checked, not proven.
