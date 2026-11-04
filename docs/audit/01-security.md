# Audit 01: Security

Auditor area: the TV listener and its approval model, localhost CSRF / DNS-rebinding protection, path traversal, process argument injection, sessions and credentials, committed secrets, SQL injection. Audited at the working tree of 2026-11-04.

## Summary

The TV listener works as ADR 0004 describes. A LAN stranger reaches `/api/health` and gets a 403 on the listed routes. Anything unlisted is a 404, and the listener has no approve endpoint. The weak point is the localhost app. Its Host/Origin guard (`localOnly.ts`) is applied only to the sharing-spec routes. The older v1 routes, including the ones that turn the TV Server on, approve an IP, trash files and quit, take requests from any website. A plain cross-site `fetch` (a CORS "simple" request with `text/plain` and no preflight) can approve `127.0.0.1` as a TV. The TV listener then answers `Access-Control-Allow-Origin: *`, so that same website can read the whole library and stream every file. With DNS rebinding, every unguarded route is open, including trashing a Video's files. No secrets are committed, I found no SQL injection, and file paths reach ffmpeg, trash and `open` safely.

| ID | Severity | Status | Location | Title |
|---|---|---|---|---|
| SEC-1 | High | CONFIRMED | src/server/api.ts:544-558, src/server/tv.ts:191-214 | Any website can turn the TV Server on, approve 127.0.0.1 (or its own LAN IP) and then read the library and stream files cross-origin |
| SEC-2 | High | CONFIRMED | src/server/api.ts:429-924 (guard used only at 669-866, 894, 910) | No Host check on most localhost routes: DNS rebinding reaches delete-with-media, reads, edits and quit |
| SEC-3 | Medium | CONFIRMED | src/server/api.ts:588, 595, 642, 748, 780, 878, 915, 919 | Cross-site simple POSTs (no preflight) to quit, rescan, create Songs and Artists, drive Music.app, open file dialogs |
| SEC-4 | Medium | CONFIRMED | src/server/tv.ts:192-213 | TV listener answers `Access-Control-Allow-Origin: *` to every request, so any page in any browser at an Approved IP can read the library |
| SEC-5 | Low | PLAUSIBLE | src/server/api.ts:541 | The localhost UI sets no `frame-ancestors` / `X-Frame-Options`, so it can be framed for clickjacking (Allow TV, Delete) |
| SEC-6 | Low | CONFIRMED | src/server/api.ts:171; docs/spec.md:30, scripts/download-*.sh:4-5, docs/research/*.md | Absolute file paths (with the macOS username) go to TV clients; the owner's home paths are committed to the public repo |

---

## SEC-1: A cross-site page approves itself as a TV and reads the library (High, CONFIRMED)

**Description.** `POST /api/tv/on` (api.ts:544), `POST /api/tv/approve` and `/deny` (api.ts:552-558) run no `localRequestError` check. `readJson` calls `req.json()`, which ignores the Content-Type (api.ts:382-389). So a page on any origin can send these as CORS simple requests (`fetch(url, {method:"POST", mode:"no-cors", body:'{"ip":"127.0.0.1"}'})`, which sends `text/plain`, no preflight). The browser does not let the page read the reply, but the server runs the action. Once 127.0.0.1 is in `approved_tv`, the TV listener on `0.0.0.0:4401` serves that source IP. It also adds `Access-Control-Allow-Origin: *` to every reply (tv.ts:205), so the same page can then *read* the results with a normal CORS `fetch`.

**Attack scenario.**
1. The user has TuvaVideos running and visits `https://evil.example`.
2. The page sends `POST http://127.0.0.1:4400/api/tv/on`, then `POST http://127.0.0.1:4400/api/tv/approve` with the body `{"ip":"127.0.0.1"}`. Both are no-cors, so no preflight is sent.
3. The page runs `fetch("http://127.0.0.1:4401/api/videos")` and reads the whole library: titles, Artists, viewing history, resume points and absolute file paths. `/api/favorites` and `/api/search` work the same way. `fetch("http://127.0.0.1:4401/copy/1")`, `/copy/2` and so on stream every file. Copy ids are small sequential integers.
4. The same steps work for an attacker on the same network, such as café Wi-Fi with a laptop. The page approves the attacker's own IP instead, e.g. `{"ip":"192.168.1.66"}`. The attacker then reads and streams the library over the LAN, with no prompt ever shown to the user.

Browser caveat: Chrome's Local Network Access permission (rolling out from Chrome 142) may ask before a public site can reach loopback. Safari and Firefox do not block these requests. Do not rely on the browser for this protection.

**Evidence** (app run with `TUVA_DATA_DIR`/`TUVA_PORT=46400`/`TUVA_TV_PORT=46401` in scratch; script saved as `/tmp/claude-0/-home-user-TuvaVideos/81dd5c87-daef-5003-ad39-65f9bcc41023/scratchpad/audit-01/repro.sh`):
```
$ curl -XPOST :46400/api/tv/on -H 'Origin: https://evil.example' -H 'Content-Type: text/plain;charset=UTF-8' --data ''
{"available":true,"on":true,"port":46401,...,"approved":[]}
$ curl -XPOST :46400/api/tv/approve -H 'Origin: https://evil.example' -H 'Content-Type: text/plain;charset=UTF-8' --data '{"ip":"127.0.0.1"}'
{...,"approved":[{"ip":"127.0.0.1",...}]}
$ curl -i :46401/api/videos -H 'Origin: https://evil.example'
HTTP/1.1 200 OK
Access-Control-Allow-Origin: *
[{"id":"22ee325d-...","title":"-Leading dash",...,"copies":[{...,"path":"/tmp/.../root/-Leading dash [abcdefghijk].mp4"}]}...
$ curl -o /dev/null -w '%{http_code} %{size_download}' :46401/copy/1
200 46172
```

**Suggested fix.** Put `localRequestError` (Host and Origin) on every non-GET localhost route, `/api/tv/*` included. A simple way is one check at the top of the handler for `method !== "GET" && method !== "HEAD"`, plus `hostError` on every request (SEC-2). Also refuse `127.0.0.1`, `::1` and the Mac's own `lanAddresses()` in `TvServer.approve`, or keep the TV listener from serving loopback at all. Narrow the TV CORS policy too (SEC-4).

---

## SEC-2: DNS rebinding reaches almost every localhost route (High, CONFIRMED)

**Description.** The localhost server binds 127.0.0.1 (app.ts:515), and the `Host` check exists in `localOnly.ts:9-19`. But the handler calls it only for the sharing-spec routes: shelved (669, 678), `DELETE …/copies` (685), cache/apply (792), share (808, 815), session (825, 832), sync (841), reconcile (854, 861), roots (894) and dismiss-bar (910). Every other route answers whatever the `Host` header says. In a DNS-rebinding attack, `rebind.evil.example` first resolves to the attacker's server and then to 127.0.0.1. The attacker's page is then same-origin with the companion, so it gets no preflight and can read every reply. It can:
- read `/api/videos`, `/api/favorites`, `/api/roots`, `/api/edits`, `/api/shelved` and `/api/health`, and stream `/copy/:id` and `/copy/:id/pcm`;
- `DELETE /api/videos/:id` with `{"media":true}` to move each Copy's file to the Trash, for every Video that is not Shared (api.ts:690-696, no guard). The guarded `DELETE /api/videos/:id/copies` next to it (685) shows the check was meant for this kind of route;
- `PATCH` Videos and Chapters, merge Artists (642), delete Songs, Versions, Chapters and audio presets, `POST /api/videos/:id/relocate` with `merge` (868), write screenshots to `~/Desktop` (630), and turn on and approve the TV Server (SEC-1).

**Evidence:**
```
$ H='-H Host:rebind.evil.example:46400 -H Origin:http://rebind.evil.example:46400'
$ curl -s -o /dev/null -w '%{http_code}' :46400/api/videos $H            -> 200
$ curl -s :46400/api/session $H                                         -> {"error":"Host is not this machine"}
$ curl -s -XDELETE :46400/api/videos/22ee325d-... $H --data '{"media":true}'
{"deleted":true,"trashed":["/tmp/.../root/-Leading dash [abcdefghijk].mp4"],"kept":[],"tombstoned":false}
$ cat trash.log  ->  TRASH /tmp/.../root/-Leading dash [abcdefghijk].mp4
$ curl -s -XDELETE :46400/api/videos/123b.../copies $H                  -> {"error":"Host is not this machine"}
```

**Suggested fix.** Run `hostError(req)` once at the top of the localhost handler, for every request. The browser always sends `Host: localhost:4400` or `127.0.0.1:4400`, so no legitimate request is lost. Do not apply it to the TV listener's calls into the same handler: the TV's Host is the Mac's LAN IP. One option is a flag set by `TvServer.respond`, or a wrapper so that only the listener bound to 127.0.0.1 enforces the check. Add a test that walks the route list with a foreign Host and expects 403 everywhere.

---

## SEC-3: Cross-site simple POSTs with side effects (Medium, CONFIRMED)

**Description.** These routes need no id that a page outside the app could not know, and they have no Origin check, so any web page can trigger them blind:
- `POST /api/quit` (919): stops the app. This is a denial of service whenever the user browses.
- `POST /api/rescan` (915): starts a full scan and the ffmpeg thumbnail passes.
- `POST /api/songs` (748) and `POST /api/artists` (780): plant attacker-named Local Songs and Artists in the library, with the request body as data. Any gap in the lyrics or search HTML rendering (`dangerouslySetInnerHTML` in `src/web/Lyrics.tsx:349-375`, `SearchBox.tsx`) would turn this into stored XSS on `http://localhost:4400`. That origin holds the Supabase refresh token in localStorage (sharing-spec §5.2). The frontend auditor should check those sanitizers knowing that this input can come from a third party.
- `/api/studio/play|pause|stop|seek` (595) drive Music.app. `POST /api/copies/<n>/reveal` (588) opens Finder windows; Copy ids are sequential. `POST /api/choose-file` (878) puts up a modal osascript dialog that waits up to 10 minutes.
- With guessable or leaked ids (Shared Video ids are the same on every Member's machine): `merge-into` (642), favorite, chapter add/confirm (559-587) and `relocate` (868).

DELETE, PUT and PATCH are safe from this cross-site path: they need a preflight, and the companion answers `OPTIONS` with a 404 that has no CORS headers (verified). They stay exposed to SEC-2.

**Evidence:**
```
POST /api/rescan     (Origin evil, text/plain) -> {"queued":[1]}
POST /api/songs      -> {"id":"3b10bd5b-...","name":"CSRF artist","local":true,"created":true}
POST /api/artists    -> {"id":"bc7d958c-...","name":"CSRF artist","local":true,"created":true}
POST /api/studio/stop -> {"active":false,...}
POST /api/quit       -> {"quitting":true}; next /api/health: connection refused; log "shutting down ... bye"
(for comparison) POST /api/roots, /api/share/auto -> {"error":"Origin is not this companion"}
```

**Suggested fix.** The same fix as SEC-1: `localRequestError` on every state-changing method. Optionally also require `Content-Type: application/json` on JSON routes, which forces a preflight. `sendBeacon` for resume sends a Blob, so check whether it can set that type before relying on it.

---

## SEC-4: Wildcard CORS on the TV listener (Medium, CONFIRMED)

**Description.** `TvServer.fetch` answers every `OPTIONS` with `access-control-allow-origin: *`, reflects any requested headers, and allows `DELETE`, `PUT` and `PATCH` (tv.ts:192-201). It also puts `ACAO: *` on every reply (205, 210). Access is decided by source IP only. So any web page in any browser that shares an Approved IP can read `/api/videos` and the other listed reads, and stream `/copy/:id`. That browser could be the TV's own web browser, or a phone or laptop behind the same NAT or guest-network router, or the Mac itself once 127.0.0.1 is approved (the spec suggests opening `http://127.0.0.1:4401/` in a desktop browser, tv.ts:251). The TV app needs CORS only for the LG shell's `file://` origin (comment at tv.ts:189).

**Evidence:** the `curl -i :46401/api/videos -H 'Origin: https://evil.example'` reply in SEC-1 carries `Access-Control-Allow-Origin: *` and the full body.

**Suggested fix.** Send `ACAO` only when the `Origin` is `null` or `file://` (the webOS shell), or absent. Never reflect an http(s) origin. Keep ACAO on `/thumbs` only if the poster-colour canvas needs it, and limit it to that same origin set. Optionally refuse loopback approvals (SEC-1).

---

## SEC-5: The localhost UI can be framed (Low, PLAUSIBLE)

**Description.** The shell `index.html` is served with only `content-type` and `cache-control` (api.ts:541). There is no `Content-Security-Policy: frame-ancestors 'none'` and no `X-Frame-Options`. A hostile page can therefore load `http://localhost:4400/` in an invisible iframe and steer the user's clicks onto "Allow" in the TV prompt or onto the Delete confirmation. Traced, not reproduced in a browser.

**Suggested fix.** Add `content-security-policy: frame-ancestors 'none'` (and `x-frame-options: DENY`) to the shell response and to the TV `/` page.

---

## SEC-6: Absolute paths leave the machine and are committed to the repo (Low, CONFIRMED)

**Description.** `copyJson` puts `path` (the Root's path joined with the Copy's path) in every Copy (api.ts:171). The TV listener passes it on in `/api/videos`, `/api/videos/:id` and `/api/copies/:id`, which hands the Mac's username and folder layout to every Approved TV and, through SEC-1 and SEC-4, to web pages. Separately, the public repository commits the owner's home paths, e.g. `/Users/evanwilliams/Desktop/Khoomei/Videos` (docs/spec.md:30), `DEST="/Users/evanwilliams/Desktop/Batch 8"` (scripts/download-instagram.sh:4 and the other download scripts), and `/Users/evanwilliams/Desktop/Lyrics` (8 docs/research files, test/archive.test.ts:18). The test accounts `test1@test.com`, `test2@test.com` and `test3@test.com` are named as live Video Editor and Member accounts on the archive (docs/sharing-test-plan.md:256). No password is committed, but those accounts are worth checking for strong passwords.

**Suggested fix.** Strip `path` from replies on the TV listener: the TV never needs it. Replace committed home paths with `~/…` or an env var in the scripts.

---

## Checked and found OK

- **TV route boundary.** `matchTvRoute` checks the method and the full pathname against anchored regexes. The listener and the handler parse `req.url` the same way, so dot-segments and `%2F` cannot slip through. As an unapproved LAN host (curl bound to 192.0.2.2) I got: `/api/health` returns 200 with the name only; `/api/videos` returns 403 `approve`; `/api/session`, `/api/tv`, `/copy/2/pcm`, `/api/roots`, `/api/videos/<id>/../../tv` (with `--path-as-is`) and `POST /api/tv/approve` all return 404. The listener has no approve endpoint. The `X-Tuva-TV` model is capped at 120 chars and is only stored or displayed. The rendering of the pending prompt is the frontend auditor's area.
- **Path traversal.** `/copy/:id` and `/api/copies/:id` take integer ids and read `root.path` + `rel_path` from the database. `/thumbs` takes a 36-char hex-and-dash id plus `poster|strip`. The `/themes` regex excludes `/` and `%` and leading dots. Poster downloads validate `poster_path` against `PATH_RE` (shared/posters.ts:16) before building a file name. `relocate` requires an absolute path that resolves inside a Root and passes the video-extension filter. `rootSetup` normalizes the path and requires it to be absolute. Screenshot names are sanitized (`sanitizeTitle` strips `/\:*?"<>|`, control and bidi chars, leading dots). `deleteVideo` builds its cache paths from the uuid in the route. `serveFile` stats the file and rejects anything that is not a regular file. `parseRange` is strict and single-range.
- **Process argument injection.** Every spawn uses an argv array with no shell (proc.ts, thumbs.ts:294-323, fallback.ts:190, api.ts:337, launch.ts:20). Inputs are always absolute paths, so a file named `-Leading dash [abcdefghijk].mp4` cannot be read as an option: it scanned, thumbnailed and trashed correctly in the run above, and trash got the absolute path. cwebp gets `--` before `-`. `fetch-youtube-info.ts` passes `--` before the id. The PowerShell recycle command takes the path as `$args[0]`, not as code. The osascript `choose file` default location is `JSON.stringify` of a path that must be an existing directory. JSON escapes (`\"`, `\\`) are valid AppleScript escapes, and other control characters would only cause a syntax error.
- **SQL.** Every value is bound. Interpolated identifiers come from fixed lists: `applyShared` filters row keys against `PRAGMA table_info`, and its table names come from constants. FTS `MATCH` tokens are limited to `[\p{L}\p{N}]+` and quoted (search.ts:263-264). The `listEdits` LIMIT is clamped to an integer between 1 and 500. Type prefixes must match `^[a-z_]+\.?$`.
- **Tokens and credentials.** The access token rides only in the `/api/sync` and `/api/reconcile` bodies, or in an Authorization header for the preview. Those routes check Origin and Host. The body may hold no other key, so a refresh token is refused. Nothing logs the token (checked the `log(` calls in sync.ts, reconcile.ts and posters.ts). The server's Session record is token-free. The only stored session is supabase-js's `localStorage` on the localhost origin. The committed `ARCHIVE_KEY` is the public `sb_publishable_` key. No JWTs, service-role keys, `sb_secret_`, AWS or GitHub tokens are in tracked files. `git log -S service_role` shows no key ever committed. `scripts/grant-video-access.ts` reads `SUPABASE_SERVICE_ROLE_KEY` from the environment only, sends it only to `SUPABASE_URL`, and never prints it.
- **Cross-site preflighted methods.** The localhost server never answers `OPTIONS` with CORS headers (verified: 404, no ACAO), so a cross-site DELETE, PUT or PATCH, or any request with custom headers, is blocked by the browser. Only the SEC-2 rebinding path reaches those.

## Not covered / blocked

- I did not exercise the browser-level controls (Chrome Local Network Access / Private Network Access, SameSite) in a real browser. The findings are confirmed at the HTTP level with curl, which sends what a browser simple request or a rebound same-origin request would send.
- macOS-only paths (`open -R`, osascript, `/usr/bin/trash`, the Music.app bridge in `src/server/studio/`) were reviewed by reading only. `choose-file` failed here with "osascript not found", which shows the route is reachable but not the dialog.
- I did not review the Supabase RLS, RPCs and archive-side checks on `youtube_id` and `id` formats: they live in the archive repo, and contacting the archive was off-limits. If the archive allowed a non-uuid `videos.id`, the poster file names in posters.ts:24 and thumbs.ts:202 would need their own check. The archive types `id` as a uuid, per ADR 0006.
- ffmpeg reads untrusted downloaded files with automatic format detection. I did not test hostile-media cases, such as playlist-in-container tricks that read other local files into a thumbnail that is later uploaded as a Shared poster. Possible hardening: `-protocol_whitelist file` on inputs.
- Frontend XSS (lyrics and footnote HTML, `highlightHtml`) belongs to another auditor. SEC-3 shows that any web page can supply that content through Local Songs.
