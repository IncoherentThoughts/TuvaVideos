# Audit 06: TV app (client, shell and its server routes)

Auditor scope: `src/tv/**`, `tv/shell/*`, `src/server/tv.ts`, `tvRoutes.ts`, `tvJudge.ts`, `scripts/tv-install.ts`, `scripts/lg-install.ts`, checked against `docs/tv-spec.md`, ADR 0004 and `CONTEXT.md`. This covers functional correctness. Network security belongs to another auditor.

## Summary

The pure parts are solid: the key table, the zones reducer, focus geometry, discovery and the rails. The TV tests pass (142/142). The worst defect is on the server. `/copy/:id` over the TV listener decides what to serve by the **browser's** Playback profile, ignoring the TV's. So the TV plays a browser Fallback instead of a file it can play as-is. When no Fallback exists, the request **starts a Fallback transcode on the Mac** (a reproduced High that breaks spec §1 and §3.2). On the client:
- One refused connection kills the play with a false "did not play (codecs)" message and no recovery.
- Holding an arrow throws the playhead tens of minutes.
- Focus is lost after the library reloads (Library grid) and after a Search layer switch.
- Back from the Player re-reads the library before the final Resume write.
- A UI bundle that fails to parse leaves a black screen where Back is dead. The bundle needs Chromium 85+, but `config.xml` allows install on Tizen 6.0 (Chromium 76).

Repro environment: a scratch library (49 generated clips, including an AC3 mkv and a VP9 webm), the server on `TUVA_PORT=4506` and `TUVA_TV_PORT=4507` with 127.0.0.1 approved, and headless Chromium (Playwright) driving `http://127.0.0.1:4507/` with arrow, Enter and Escape keys. Scripts are in the session scratchpad (`audit-06/pw*.js`).

## Findings

| ID | Severity | Status | Location | Title |
|---|---|---|---|---|
| TV-1 | High | CONFIRMED | src/server/api.ts:342-353 | `/copy/:id` ignores the TV profile: it serves the browser Fallback, or starts a Fallback transcode for the TV |
| TV-2 | Medium | CONFIRMED | src/tv/Player.tsx:555-578, 254-280, 688-701 | A brief server or network loss during play ends in a permanent, false "This Copy did not play (codecs)" |
| TV-3 | Medium | CONFIRMED | src/tv/Player.tsx:307-318, src/tv/seekStep.ts:244-254, src/tv/input.ts:131 | Auto-repeat of a held arrow climbs the seek ramp: 1.5 s of holding seeks about 26 min |
| TV-4 | Medium | CONFIRMED | tv/shell/shell.js:151-170, 198; tv/shell/config.xml:3; src/server/web.ts:67-73 | A tv.js that fails to parse or throws at boot leaves a black screen with Back dead; the bundle needs Chromium 85+, but install is allowed on Tizen 6.0 (M76) |
| TV-5 | Medium | CONFIRMED | src/tv/main.tsx:237, 255-261; src/tv/Grid.tsx:130-133; src/tv/screen.tsx:412-417 | Focus lost in a windowed grid when the post-Player reload reorders it; the next key is swallowed and lands on the header |
| TV-6 | Low | CONFIRMED | src/tv/main.tsx:255-259 | Back from the Player re-reads `/api/videos` before the final Resume POST: home and grids show a stale position |
| TV-7 | Low | CONFIRMED | src/tv/Search.tsx:158-160 | Enter on a keyboard layer key (abc / АБВ / 123) drops focus to `<body>`; the next key is swallowed and focus jumps to the first key |
| TV-8 | Low | CONFIRMED (trace) | src/tv/Player.tsx:654-659, 524-533 | Adopting another player's Resume position echoes a write 0.4 s later, which can overwrite a newer write from the browser |
| TV-9 | Low | PLAUSIBLE | tv/shell/discovery.js:63-67, 163, 214 | Enter (typed field) during a background connect leaves `typing` stuck: the screen sits on "Approve" or the retries stop |
| TV-10 | Low | CONFIRMED (trace) | scripts/lg-install.ts:129-131, 144-155 | `process.exit` inside `try/finally` leaks the temp `.ipk` directory on every failed step |

---

### TV-1: `/copy/:id` ignores the TV profile (High, CONFIRMED)

**Description.** `copyRoute` decides from the `copy.playback` column, which is the **browser** decision (`decidePlayback`: audio in aac/opus/vorbis/mp3/flac and a known duration):

```ts
if (c.playback !== "native") {
  if (!c.fallback_file) {
    const st = s.fallback.request(id, "play");
    return json({ state: st.state, ... }, 503, { "retry-after": "2" });
  }
  return serveFile(req, join(s.cfg.remuxDir, c.fallback_file), ...);
}
```

The TV listener reuses this handler unchanged (`src/server/tv.ts:232`). Meanwhile the TV app picks the Copy from `copy.tv.order` (`"file" | "fallback" | "live"`, `api.ts:141-145`) and always loads `c.url = /copy/:id`. So:
- **`tv.order = "file"` but browser `transcode`/`remux`** (an mkv with AC3/E-AC3 audio, or a file whose duration is unknown): the TV gets the AAC Fallback instead of the file its profile plays as-is. If no Fallback exists, the TV request **queues a play-priority Fallback job**, which writes a cached file on the Mac. This breaks spec §1 ("The TV never creates cached files on the Mac") and §3.2 ("The TV never asks the Fallback queue to make anything"). The TV meanwhile gets a 503 and fails. A `remux`-only Copy (unknown duration) gets no Fallback at scan time (`enqueueScanJobs` only queues `transcode`), so on the TV it always takes this path.
- The tag row and Copy list show the file's codecs (ac3) while the Fallback (aac) is what plays.

**Failure scenario.** A concert mkv with E-AC3 audio whose Fallback is not made yet, still queued, or failed. Or any file with unknown duration. The TV opens it, `<video>` gets a 503, the Player retries once after 1.5 s and then shows "This Copy did not play (mkv h264/eac3)". Meanwhile ffmpeg transcodes the whole audio track onto a 93 % full disk.

**Evidence (ran).** With AC3 Copy 46 (`playback=transcode`, `tv.order=file`) and its Fallback ready, `curl :4507/copy/46 | ffprobe` reports `h264, aac`: the Fallback, not the AC3 file. After clearing `fallback_file` in the scratch DB, `curl -i :4507/copy/46` returned `503 {"state":"preparing"}`, and the server log shows `fallback transcode start (play): copy 46` and then `done`, with `remux/46.mkv` recreated.

**Fix.** Give the TV listener its own copy route, or pass a profile flag into `copyRoute`. Serve by `tvOrder`: `file` gives the own file, `fallback` gives the Fallback file only if it exists, and `live` gives 404/409. Never call `s.fallback.request` from the TV. Add a test that a TV-port `/copy/:id` for a `transcode` Copy with `tv.order=file` returns the original bytes and queues nothing.

### TV-2: A short outage permanently fails the play with a codec message (Medium, CONFIRMED)

**Description.** `onError` asks `/api/videos/:id`. That fails while the server is unreachable, so it falls back to the cached DTO. The Copy still reads `available`, so it is "intact": the Player retries once after 1.5 s, and on the second error calls `lose(id, markFailed=true)`. That adds the Copy to `r.failed`, unloads `src` and shows `failedMessage` ("This Copy did not play (webm vp9/opus)"). The recovery effect (lines 688-701) only re-attaches Copies *not* in `r.failed`, so the play never recovers once the server is back. Spec §4.3 lets the UI call `window.tuvaTv.restart()` "on a 403 or a dead stream", but the UI only does it on a 403 (`data.ts:260`). The shell's own "turned off" overlay needs two health misses 5 s apart, so outages under about 10 s (a Wi-Fi drop, the TV Server toggled, a server restart) never show it.

**Evidence (ran, `pw6.js`).** `/copy/*` and `/api/videos/*` were aborted with `connectionrefused` from the moment the Player had read its Video. Result: `"This Copy did not play (webm vp9/opus)"`, `src` removed. After the routes were restored, 12 s later (past one 10 s poll) it was unchanged.

**Fix.** On a media error, tell a network failure apart from a decode failure. Use `video.error.code === MEDIA_ERR_NETWORK` (or `api.video` itself failing): keep the Copy out of `r.failed`, show "Lost the TV Server, retrying…", and retry with backoff, or call `tuvaTv.restart()` after N failures. Reserve `failedMessage` for `MEDIA_ERR_DECODE` or `MEDIA_ERR_SRC_NOT_SUPPORTED` with a server that is answering.

### TV-3: A held arrow seeks tens of minutes (Medium, CONFIRMED)

**Description.** Arrows are not in `NO_REPEAT`, so every keydown auto-repeat reaches `seekBy`. `nextSeekStep` counts each repeat as a "press within a second", climbing to the 120 s rung after 12 events. `seekBy` steps from `R.seekTarget`, so throttling issues fewer seeks but does not slow how fast the target grows.

**Evidence (ran).** Simulating a 500 ms repeat delay and 50 ms repeat interval gives +400 s after 1 s, +1600 s after 1.5 s and +5200 s after 3 s (`ramp.ts`). In the browser (`pw4.js`), paused at 47 s, 30 repeat events 50 ms apart moved the playhead to the end (178 s of 180 s), badge "+120 s".

**Failure scenario.** The user holds Right to scrub a little in a 90-minute concert and lands near the end.

**Fix.** Ignore `e.repeat` for the ramp: either count repeats as staying on the current rung, or rate-limit repeats to one step per ~250 ms. Climb rungs only on discrete presses, which is the spec's "kept pressing" wording.

### TV-4: Boot failure gives a black, dead screen; old engines cannot parse the bundle (Medium, CONFIRMED)

**Description.** `loadUi` hides the shell (`el.hidden = true`) before `/tv.js` runs. `js.onerror` fires only for a failed load, not for a parse or runtime error. Once state is `ready` and the shell is hidden, the shell's key listener returns early (`shell.js:198`), so Back and Enter do nothing. The bundle is built with `target: "browser"` and no syntax target. It contains 75 `?.`, 88 `??`, 3 `??=` and class fields, which need Chromium 85. `config.xml` declares `required_version="6.0"`; Tizen 6.0 (2021 sets) ships Chromium 76. LG webOS 6 ships Chromium 79. The 2026 R85H (M130) is fine, so on the target set this only bites when the UI throws at boot.

**Evidence (ran, `pw7.js`).** The real shell ran over HTTP with `?addr=127.0.0.1`, and port 4401 was proxied to the audit server with `/tv.js` replaced by unparseable code. Result: pageerror `Unexpected identifier 'is'`, `#shell` hidden, `document.body.innerText === ""`. Pressing Enter and Back changed nothing. The bundle syntax was counted from a `Bun.build` with the same options as `TvBundle`.

**Fix.** Keep the shell visible ("Loading…") until the UI signals readiness, for example `tuvaTv.ready()`. Add a `window.onerror` and a timeout in the shell that render an error screen with Enter to retry and Back to exit. Either raise `required_version` to 6.5 or set a matching syntax target for the bundle, and document the minimum webOS version.

### TV-5: Focus lost after the post-Player reload reorders a grid (Medium, CONFIRMED)

**Description.** `nav.back()` reloads the library after leaving the Player. The Library grid's default sort is "Most watched", and the view just counted moves the Video to row 0. The Continue watching grid sorts by last played, with the same effect. The grid is windowed (`Grid.tsx:130-133`), so the focused tile's element is unmounted and focus falls to `<body>`. `useScreen.ensure` only runs when the screen becomes active, which happened before the reload. On the next key, `ensure()` eats the key and falls back to `initial()`. That looks for the Shuffle tile, which is not rendered when scrolled down, so focus lands on the header's Search button.

**Evidence (ran, `pw1.js`).** In the Library grid, 12 Downs, then Enter on a tile, Back: focus is `BODY`, and one Down gives `h-search`. Control (`pw2.js`): the same in the Recently added grid (no reorder) kept focus on the tile. The Home rails keep focus, because their tiles are moved, not unmounted.

**Fix.** After `data` changes, re-find the last focused key with `findByKey`. If it is not rendered, scroll to its new index (`index.get(key)`) and focus it via the existing `pending` mechanism, or keep the grid's order fixed until the screen is left. Make `initial()` fall back to the first *rendered* tile.

### TV-6: Back re-reads the library before the final Resume write (Low, CONFIRMED)

**Description.** `back()` calls `setStack(next)` and then `reload()` in the same tick. Preact unmounts the Player (whose cleanup posts Resume) on the next microtask, so the GET goes out first.

**Evidence (ran, `pw5.js`).** After Back: `POST resume {"resumeS":68.71}` was sent after `GET /api/videos`, whose response carried `resumeS 65.53`. The Continue watching card showed 36.4 % (65.5 of 180 s). A Video watched to the end (stored 0) likewise stays in Continue watching until the next reload.

**Fix.** Write Resume in `back()` before reloading (as the tag path already does, `Player.tsx:428`). Alternatively, delay the reload until after the unmount, or merge the last written position into the reloaded data.

### TV-7: Search layer switch drops focus (Low, CONFIRMED)

**Description.** Keyboard keys are keyed `${kb.layer}${i}`, so changing layer replaces every key element, including the focused one.

**Evidence (ran, `pw3b.js`).** Focus on `kb-29 "АБВ"`, Enter: `BODY`. The next Left is swallowed by `ensure()` and focus lands on `kb-0 "а"`.

**Fix.** Key the layer-switch, space, backspace and clear keys by a stable id (for example `op-АБВ`), or refocus the same `data-key` after the layer changes.

### TV-8: Adoption echo can overwrite a newer browser write (Low, CONFIRMED by trace)

**Description.** The 10 s poll adopts a foreign position with `E.current.seekTo(to)`. The resulting `seeked` always schedules `writeResume()` 400 ms later (`Player.tsx:532`), which posts the adopted value back. If the browser wrote a newer value in that window (for example, the user paused there), the TV's echo replaces it. The browser, now paused, then adopts the older value from the TV (`adoptResume`, more than 1 s apart, quiet for 4 s) and jumps back with "Resume moved to … by another player".

**Fix.** Mark adoption seeks as internal and skip the seek write, since `r.known` already holds the value.

### TV-9: Typed field during a background connect (Low, PLAUSIBLE)

**Description.** `openTyped()` sets `typing = true` without cancelling the running `search`. If that search then reaches `connect()`, the `denied` emit is not suppressed (only `looking` is), so the screen flips from the typed field to "Approve". `typing` stays true, because `closeTyped` is reachable only from the typing screen. If the server then stops answering, `search` sits in `while (typing) sleep()` forever, and the screen stays on "Approve this TV" with no retries. This requires Enter during the short `access` step, so it was not reproduced.

**Fix.** Clear `typing` whenever a non-typing state is emitted, or bump `gen` in `openTyped` and restart the search on `closeTyped`.

### TV-10: `lg-install` temp directory leak (Low, CONFIRMED by trace)

`run()` calls `process.exit(1)` on failure, which skips the `finally` that removes the temp directory made by `mkdtempSync`. **Fix:** throw instead, and exit in `main`.

---

## Checked and found OK

- **Key table** (`keys.ts`, generated `keys.js` matches). Tizen codes: Back 10009, Exit 10182, MediaPlayPause 10252, Play 415, Pause 19, Rew/FF 412/417, Track 10232/10233, colours 403-406, Ch 427/428, Info 457, digits. Registered names are valid `registerKeyBatch` names, with a per-key fallback. webOS alternates: Back 461 (with `disableBackHistoryAPI`), Ch 33/34; the media and colour codes are the same. Held Enter, Back and play/pause do not repeat (`NO_REPEAT`).
- **Home focus (Playwright).** Right and Down move along and between rails. Up twice reaches the header. Left at a rail start opens the pane and Right closes it. Back on the home opens the pane. Focus on the home survives the post-Player reorder.
- **Grid (Playwright).** Windowed (31 of 43 tiles rendered), Down walks to the last row without losing focus, Ch▲/▼ page. The Recently added grid keeps focus after the Player.
- **Search (Playwright).** Typing, the 220 ms debounce with abort, Right from the keyboard edge to the results, Back from results to the last key, Back again leaves. Results are rendered through `highlightHtml`, which escapes.
- **Player zones (Playwright, VP9 webm).** Up gives the lyrics band ("This Video has no Song"), Up again the tag row, Back the video, Down the buttons, Right twice Copy, Enter the Copy list, Back the buttons, Down "No chapters". Zones close after 3 s idle and the OSD fades. Enter pauses and the pause writes Resume. A seek into the last 30 s stores 0. One view per visit.
- **Shared Resume.** Fresh `GET /api/videos/:id` on open, 5 s cadence, writes on pause, seek, switch and leave, none inside a Playlist. `text/plain` bodies avoid preflight. `adoptResume` follows the browser while paused (but see TV-8).
- **Copy choice.** `pickPlayable` prefers a TV-playable Copy over a local one that needs the remux. Live remux returns 404 "not built yet" and the Copy rows say "via remux".
- **Discovery.** Last address, then a /24 sweep of 32 in flight with 2 s deadlines enforced even when abort is ignored, then the typed field. The first answer wins. A changed Mac IP falls through to the sweep. A 403 gives "Approve", retried every 3 s. Two health misses give "turned off". It guards for a missing `AbortController`. The shell's own syntax (optional catch binding, async) needs about Chromium 66, which Tizen 6.0 meets.
- **Timers.** Player poll, timeouts and listeners cleared on unmount. Glow rAF cancelled. Keyframe poll stopped by token. The Search debounce cleared.
- **Server.** The route list matches spec §2.3. Not-on-this-machine filtering applies to the four list routes. `tvJudge` re-judges stale or NULL rows. Hard stop calls the stop hooks.
- `bun test test/tv*`: 142 pass, 0 fail.

## Not covered / blocked

- No real Samsung or LG TV: remote key arrival, auto-repeat timing on the actual remote, Web Audio on the R85H, LG Magic Remote pointer mode, and `window.close()` exit on webOS were not run. The Chromium version facts behind TV-4 come from Samsung's and LG's published version tables, not a device.
- Headless Chromium has no H.264/AAC, so Player tests used a VP9/Opus webm. The mp4 path was traced, not played.
- A network drop mid-stream (as opposed to a refused request) was not reproduced. Small test files buffer completely. TV-2 used refused requests at load time.
- Live remux is not built (spec §3.4, deferred), so it was not audited. Network-security aspects (the allowlist, the OPTIONS 204 to anyone before the route check, CORS `*`) are left to the security auditor.
- My scratch server was killed once by another auditor's `pkill`; I restarted it and redid those steps. My server was stopped by its own PID at the end.
