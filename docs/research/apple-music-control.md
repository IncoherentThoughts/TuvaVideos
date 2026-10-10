# Research: controlling a specific Music.app track from a local server

Resolves #4 (part of map #1). Question: how can a local Bun server on macOS start, pause, seek and read the position of one specific Music.app library track for **Studio playback**, and how do we match Mirror Tracks to Music.app tracks?

Investigated 2026-10-10 on macOS 15 (Darwin 24.6.0), Music.app 1.5.6. All probes were read-only: no playback was started, and no settings or library data were changed. The player was `paused` before and after the probes.

## Recommendation (TL;DR)

- **Mechanism:** use AppleScript or JXA against Music.app, run from the Bun server through `osascript -l JavaScript`. Address each track by its **persistent ID**. To play: `play <track> with once`. To pause: `pause`. To seek: set `player position`. To read state: `player state`, `player position`, and `current track`'s `persistent ID`. This is the only mechanism that plays the user's library, including the 2472 Apple Music subscription tracks, without Apple developer credentials.
- **Do not play files in the browser.** 925 of the 1362 downloaded files are FairPlay-protected `.m4p` (codec `paac`), which a browser `<audio>` element cannot decode. Only 437 tracks are plain mp3/m4a.
- **Do not use MusicKit JS** for v1. It needs a paid Apple Developer Program membership, a MusicKit private key, a signed developer token (at most 6 months) and a user token. It also uses different IDs (`i.…`) from Music.app's persistent IDs. Everything it would add, Music.app already does locally.
- **Matching:** take a one-shot bulk JXA dump of `{persistentID, name, album, artist, albumArtist, duration, cloudStatus}`, then match on a normalized (name, album) key. Store the matched persistent ID on the Link as a Suggested match for the user to confirm. Exact name+album matched **10/20** in the sample. Normalized name+album raises that to **12/20**. The other 8 are mostly tracks that are not in the Music library at all.

## 1. Music.app scripting surface (primary source: `sdef /System/Applications/Music.app`)

Relevant entries from the dictionary dumped on this machine:

| Need | Dictionary entry | Notes |
|---|---|---|
| Start a specific track | `play` — "play the current track or the specified track or file", optional `once` boolean: "If true, play this track once and then stop." | `once` stops Music from continuing to the next album track after the clip ends. |
| Pause / resume | `pause`, `playpause`, `play` (no argument resumes) | |
| Stop | `stop` | |
| Seek | application property `player position` (real, rw): "the player's position within the currently playing track in seconds." | Writable, so seek = `set player position to 83.5`. |
| State | `player state` (enum `stopped` / `playing` / `paused`; also `fast forwarding` / `rewinding`) | |
| Which track is loaded | `current track` → `persistent ID` | Use this to confirm the reported position belongs to *our* track (the user may have changed tracks in Music.app). |
| Stable ID | `item.persistent ID` (text): "the id of the item as a hexadecimal string. This id does not change over time." | Prefer this over `database ID` (an integer that is only unique within the current library session). |
| Reveal in UI | `reveal` — "reveal and select a track or playlist" | Useful for an "open in Music" button. |
| File path | `file track.location` (file) | Present only for downloaded or local files; `shared track` (streamed) has none. |
| Library status | `track.cloud status` (enum: purchased, matched, uploaded, subscription, removed, no longer available, …) | |

Access groups in the sdef: playback commands sit in `com.apple.Music.playback`, and reads sit in `com.apple.Music.library.read`. The first time an Apple event is sent, macOS asks for **Automation** consent (System Settings › Privacy & Security › Automation) for the process that sends it. That process is the terminal or the `bun` binary that runs `osascript`.

### Sketch (JXA, run via `osascript -l JavaScript`)

```js
const M = Application('Music');
const lib = M.libraryPlaylists[0];
const t = lib.tracks.whose({ persistentID: '9C2FA8D68FF9932B' })()[0]; // Alash – Oglumga
M.play(t, { once: true });          // start
M.playerPosition = 42.0;            // seek (seconds)
M.pause();                          // pause
({ state: M.playerState(), pos: M.playerPosition(),
   pid: M.currentTrack.persistentID() });   // poll
```

`whose({persistentID})` was verified read-only: it returned exactly 1 track. A single `osascript` call took about 0.4 s wall time, including process spawn. For position polling that is fine at 1–2 Hz. If the latency is a problem, keep one long-lived `osascript` process reading commands on stdin. The playback commands themselves were **not** exercised, as the brief required. Their behaviour comes from the dictionary and should be smoke-tested in the implementation ticket. One thing to check there: `play` on a non-downloaded `shared track` (subscription, streamed) should stream through Music.app, but this is unverified.

Reference for the JXA object model and `whose`: Apple, *JavaScript for Automation Release Notes* — https://developer.apple.com/library/archive/releasenotes/InterapplicationCommunication/RN-JavaScriptForAutomation/

## 2. Where downloaded files live, and DRM

- `~/Music/Music/` holds only `Music Library.musiclibrary` (the database) and `Previous Libraries.localized`. It has **no** `Media.localized` folder with audio, which explains the original observation.
- The probe read `location` from all 1362 `file track`s, and **all** of them sit under the legacy folder `~/Music/iTunes/iTunes Media/`. That is the media folder inherited from the old iTunes library, e.g. `…/iTunes Media/Apple Music/Alash/Achai/01 Oglumga.m4p`.
- Breakdown of the library (3000 tracks):
  - `cloud status`: subscription 2472, uploaded 417, matched 37, no longer available 59, removed 7, purchased 5, unknown 3.
  - Downloaded file tracks by extension × status: `m4p|subscription` 925, `mp3|uploaded` 397, `mp3|matched` 28, `mp3|removed` 7, `m4a|uploaded` 5.
  - The remaining 1638 are `shared track`s (cloud only, streamed; no `location`).
  - `kind` strings are **localized per track** ("Apple Music AAC audio file", "Archivo de audio AAC de Apple Music", "Apple Music AAC-Audiodatei", …), so code must never branch on `kind`. Use `cloud status` or the file extension instead.
- **DRM evidence:**
  - `afinfo` on `01 Oglumga.m4p` reports `Data format: … paac`, the protected-AAC sample entry rather than `aac `.
  - The file's `stsd` contains a `sinf` box with `frma`=`mp4a`, plus `schm`, `user`, `key ` and `priv` atoms. That is the FairPlay (`itun`) protection scheme.
  - Apple's `ITLibMediaItem.isDRMProtected` returns `true` for the same item (see §3).
  - Browsers decrypt only through EME with a licence server, so these files cannot be played by an `<audio>` element. Subscription tracks are therefore playable **only** through Music.app (or MusicKit).

## 3. Reading the library as data

| Option | Verdict |
|---|---|
| `Music Library.musiclibrary/Library.musicdb` | Proprietary binary (`hfma` header, version `1.5.6.11`) with an encrypted payload. Apple does not document it, so **don't parse it**. |
| `iTunes Music Library.xml` | Music.app writes it only if "Share Library XML with other applications" is enabled. That would mean a settings change, so it was not done. It is also redundant given the next two options. |
| **Bulk JXA property read** | `tracks.persistentID()`, `.name()`, `.album()`, … each fetch all 3000 values in one Apple event. The full dump (700 KB JSON) took about 1 s. **Recommended**, because it uses the same ID space the playback commands use. |
| **iTunesLibrary.framework (`ITLibrary`)** | Apple's official read-only library API. A Swift probe returned 4038 media items (this includes non-music items). For the same track it gave persistent ID `9C2FA8D68FF9932B`, matching JXA's `persistent ID` exactly, along with `location` and `isDRMProtected=true`. A good fallback if Apple events are slow, but it needs a small Swift helper. Docs: https://developer.apple.com/documentation/ituneslibrary/itlibrary and https://developer.apple.com/documentation/ituneslibrary/itlibmediaitem (`location`, `isDRMProtected`, `isCloud`, `locationType`). |
| `export` command (sdef) | Can return playlist XML as text without writing a file. Not needed. |

## 4. MusicKit JS / Apple Music API (alternative assessed)

- Developer tokens must be ES256 JWTs signed with a MusicKit private key. They carry your Team ID and `kid`, have a maximum lifetime of 15 777 000 s (6 months), and require Apple Developer Program membership. Source: https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens
- Library endpoints such as `GET /v1/me/library/songs/{id}` additionally need a **music user token**. The example ID is `i.PkdJNdAIrQozOW`, which is a different namespace from Music.app persistent IDs. Source: https://developer.apple.com/documentation/applemusicapi/get-a-library-song
- MusicKit on the Web (v3) docs: https://js-cdn.music.apple.com/musickit/v3/docs/index.html. This is a JS-rendered page whose body could not be fetched. Its playback API (play, seek, current playback time) is the usual reason to consider it.
- **Verdict:** it plays audio inside the browser tab, which is nice, but the costs outweigh that:
  - a paid developer account, plus token signing and rotation;
  - a second ID space to match against;
  - a hard dependency on the network and the subscription;
  - no access to the 437 uploaded or matched mp3s that are not in the catalog.

  It is not worth it for a single-user local tool. Revisit only if Studio playback must happen without Music.app.

## 5. Matching Mirror Tracks → Music.app tracks

**Mirror side** (backup `supabase_backup_20261006_200025`): `album_tracks.json` has 1176 rows (`name`, `album_id`, `artist_id` (often null), `duration` (s, sometimes null)). Each row's album name comes from `albums.json` via `album_id`. Its artist is `artists.json[artist_id]`, or else `bands.json[albums.band_id]`.

**Music side:** the bulk JXA dump from §3.

**Method:**
1. Sample 20 Mirror tracks with `random.seed(4)`.
2. Compare on an exact `(name, album)` key.
3. Compare on a normalized key: NFKD, strip diacritics, casefold, drop `(...)`/`[...]` parentheticals, collapse punctuation and whitespace.

### Sample of 20

| Outcome | Count | Examples |
|---|---|---|
| Exact name+album, unique | **10** | "Throat Singing Solo" / Kongurei; "Motherland" / Road to Home (uploaded mp3); "Charash Karaa" / Embodiments |
| Normalized name+album only | 2 | "Turdai mangnap Orar" vs Music "Turdai mangnap orar" (case); "Ezir-Kara (Last Stand of «Black Craw» Stallion)" (parenthetical subtitle) |
| Name found, but on a different or variant album | 3 | "Igil Solo" on Mirror album "Ay-Kherel: The Music of Tuva" vs Music "The Music of Tuva"; "Dyngyldai" on Mirror "…Kyzyl-Moscow, Vol. 1" vs Music "Achai" / "Alash" (Music also has `"Dyngyldai "` with a trailing space); "Kozhamyk" (Ug-Shig, Shaman) exists only as other artists' recordings |
| Album in library but track missing | 1 | "Kadararda Khoyum Charash - Rock Version" / Pictures Of Tuva |
| Not in library | 4 | "Хаян" / "Уван Шу" (Cyrillic); "Song of the Caravan Drivers (Live)"; "For Mother" / Nostalgia; Özüm "Otkun, Khomus…" |

**Exact name+album: 10/20. With normalization: 12/20.**

### Across all 1176 Mirror tracks

The same classifier gives:

| Outcome | Count |
|---|---|
| Exact unique | 391 |
| Exact ambiguous | 1 |
| Normalized | 204 |
| Name-only | 159 |
| Album present, track missing | 121 |
| Absent | 300 |

So about 51% get an automatic candidate, and 9 normalized keys hit more than one Music track.

Cloud status of the matched candidates:

| Cloud status | Count |
|---|---|
| subscription | 480 |
| uploaded | 94 |
| matched | 20 |
| removed | 2 |

`removed` and `no longer available` tracks may refuse to play.

### Failure modes

1. **Track absent from the library.** This is the largest cause (≈36% overall). Studio playback is simply unavailable for those tracks, and the UI should say so.
2. **Album title variants.** Examples: an artist-prefixed title ("Ay-Kherel: The Music of Tuva"), a translated or slashed title ("Ayalgalar / Melodies"), a "- Single"/"- EP" suffix, or a compilation versus the original album.
3. **Track title variants.** These include case differences, parenthetical translations or subtitles, "- Rock Version"/"(Live)" suffixes, trailing whitespace, and transliteration (Khöömei/Khoomei, Cyrillic vs Latin).
4. **Artist strings are not reliable keys.** Music has "Huun-Huur-Tu, Carmen Rizzo & Dhani Harrison" where the Mirror has "Huun-Huur-Tu", and "Alash" vs "Alash Ensemble". Use the artist only as a tie-breaker, by token containment.
5. **Same song recorded several times** (e.g. "Barlyk River" on *Where Young Grass Grows* and *Best Live*). Name-only matching would pick the wrong recording, so never auto-link on name alone.
6. **Duplicates or ambiguity within one album key** (9 cases). Break the tie by `|duration difference| ≤ 3 s` where the Mirror duration is non-null.
7. **Localized `kind`, and `removed`/`no longer available` status.** Filter on `cloud status`, never on `kind`.
8. **Persistent IDs are library-local.** They survive restarts but not a library rebuild or re-import. If `whose({persistentID})` returns empty, re-match.

### Recommended matching strategy

1. Read all tracks once with bulk JXA. Cache the dump, and refresh it on demand or when a persistent ID lookup misses.
2. Key the Music tracks by `norm(name) + norm(album)`. Look up each Mirror Track with the same key.
3. If there is exactly 1 hit, create a **Suggested** Link that stores the `persistentID`.
4. If there are several hits, filter by duration (±3 s), then by artist token overlap.
5. If the name matches but the album does not, offer the candidates in the UI. Do not auto-link.
6. If there is no hit, mark the Link as having no Studio playback.
7. The user confirms or rejects suggestions, as described in the CONTEXT glossary under "Suggested".

## Sources

- Music.app scripting dictionary: `sdef /System/Applications/Music.app` (Music 1.5.6, local).
- Apple, *JavaScript for Automation Release Notes*: https://developer.apple.com/library/archive/releasenotes/InterapplicationCommunication/RN-JavaScriptForAutomation/
- Apple, iTunesLibrary framework, `ITLibrary` and `ITLibMediaItem`: https://developer.apple.com/documentation/ituneslibrary/itlibrary, https://developer.apple.com/documentation/ituneslibrary/itlibmediaitem
- Apple Music API, *Generating Developer Tokens*: https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens
- Apple Music API, *Get a Library Song*: https://developer.apple.com/documentation/applemusicapi/get-a-library-song
- MusicKit on the Web docs: https://js-cdn.music.apple.com/musickit/v3/docs/index.html
- Empirical probes on this machine: JXA counts, locations and status; `afinfo` and atom scan of one `.m4p`; Swift `ITLibrary` probe; the Mirror backup matching script.
