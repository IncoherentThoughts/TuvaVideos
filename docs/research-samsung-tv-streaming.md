# Streaming the archive to a Samsung TV

Research note, 2026-10-11. Question: how hard is a much-simplified TV version of TuvaVideos for a Samsung (Tizen) smart TV, Plex/Jellyfin-style? No code was changed. Claims are cited inline; **[unverified]** marks things no primary source confirmed.

## TL;DR

- **The files are not the hard part.** On a 2021-or-later Samsung TV (Tizen 6+), nearly every Copy in the library should play as-is over the Range server that already exists: H.264/VP9/AV1 in mkv/webm/mp4 with Opus/AAC. Only the one E-AC3 file and a few 4K files are open questions. No HLS or transcoding pipeline is needed.
- **The friction is Samsung's app plumbing.** Sideloading a custom app needs the Tizen CLI or the VS Code extension, a Samsung certificate tied to the TV's DUID (Samsung account required), Developer Mode on the TV, and the Mac's IP stored on the TV. Distributor certificates appear to last about a year, and TV firmware updates sometimes require new ones.
- **The server has to leave localhost.** `Bun.serve` binds `127.0.0.1` (`src/server/app.ts:47`), and the spec says "localhost only, no auth". Every TV option below means binding to the LAN, at least for a read-only subset of routes. That changes a standing constraint.
- **Recommendation, in order:**
  1. **Try Jellyfin first (half a day, no code).** Install Jellyfin Server on the Mac, point it at `~/Desktop/Khoomei/Videos`, and install the official Jellyfin app from the Samsung store (2021+ TVs) or sideload it. This tells you within an evening whether the TV plays the library and whether a lean-back UI is something you'd actually use. You lose Chapters, lyrics, Artists and Songs on the TV.
  2. **If you want TuvaVideos itself on the TV, build a small sideloaded Tizen app: about 2–4 days.** A packaged `.wgt` holds a TV-specific Preact UI (focusable grid, Player, Back handling), or an iframe of a `/tv` route served from the Mac. It plays `/copy/:id` in a plain `<video>`. The LAN URL is hardcoded or typed in once, with no discovery. This reuses the existing API, Range streaming, Fallbacks and Thumbnails as they are.
  3. **Skip:** a Jellyfin-compatible API in this server (weeks of work), DLNA (loses all metadata, Samsung-side support is poorly documented), the TV's web browser (unreliable video), and AirPlay (screen mirroring, not a TV app).
- **First thing to check:** the TV's model year. Look under Settings › Support › About This TV, or in the model code. It decides Tizen version, codec support, store availability of Jellyfin, and AirPlay.

## 0. How TuvaVideos serves video today (repo facts)

- One Bun process (not Node) on port 4400, bound to `127.0.0.1` (`src/server/app.ts:47`). The UI is Preact, not React (`package.json`, spec §9).
- `/copy/:id` serves the file with `Accept-Ranges: bytes`, 206/416 and Content-Type by extension (`src/server/stream.ts`, `src/server/range.ts`, spec §3.3).
- ffprobe runs once per Copy at scan time. `decidePlayback` (`src/server/playback.ts`) marks a Copy `transcode` when its audio is not aac/opus/vorbis/mp3/flac, and `remux` when it has no duration. ffmpeg writes a cached Fallback to `remux/` (`src/server/fallback.ts`): an audio→AAC transcode, or a `-c copy` remux with Cues/faststart. Video is never re-encoded. Scanned extensions are `mp4 mkv webm mov m4v` (`src/server/filename.ts:3`).
- The library on 2026-10-11, from `library.db`, counting Copies by container/video/audio:

| container | video | audio | Copies |
|---|---|---|---|
| mkv | h264 | opus | 517 |
| webm | vp9 | opus | 451 |
| mp4 | h264 | aac | 352 |
| mkv | av1 | opus | 172 |
| mkv | vp9 | opus | 140 |
| mkv | h264 | aac | 49 |
| mp4 | vp9 | aac | 41 |
| mkv | vp9 | aac | 30 |
| webm | av1 | opus | 15 |
| mkv | vp9 | eac3 | 1 |

  By resolution, 25 Copies are 2160p (22 VP9, 3 AV1) and 39 are 1440p. Everything else is 1080p or lower. 1,767 Copies are `native` and 1 is `transcode`.

## 1. Tizen web app development

**Model years and Tizen versions.** 2020 = Tizen 5.5, 2021 = 6.0, 2022 = 6.5, 2023 = 7.0, 2024 = 8.0, 2025 = 9.0, 2026 = 10.0. All of them use V8 and HTML5 ([General Specifications](https://developer.samsung.com/smarttv/develop/specifications/general-specifications.html)). The web engines are Chromium M76 (2021), M85 (2022), M94 (2023), M108 (2024), M120 (2025) and M130 (2026) ([Web Engine Specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html)). Samsung says TVs "from the 2023 lineup onwards will support OS Upgrade" ([General Specifications](https://developer.samsung.com/smarttv/develop/specifications/general-specifications.html)). The consumer site promises Tizen OS upgrades for seven years ([samsung.com Smart TV](https://www.samsung.com/africa_en/tvs/smart-tv/smart-hub-and-apps/)).

**Tizen changes.** The only platform changes I found are in Samsung's own spec pages:
- 2026 native binaries must be rebuilt with GCC 14.2.0. This doesn't matter for web apps.
- PlayReady and Verimatrix are deprecated ([General Specifications](https://developer.samsung.com/smarttv/develop/specifications/general-specifications.html)).
- WMV, VC-1 and WMA are dropped on 2025+ models, and RealMedia on 2026+ ([2026 TV Video Specifications](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2026-tv-video-specifications.html)).

I found no Samsung announcement that ends or replaces Tizen web apps for TV **[unverified beyond absence of evidence]**. Samsung discontinued distribution of Tizen *watch* apps ([Galaxy Watch notice](https://developer.samsung.com/galaxy-watch-tizen/getting-certificates/extend.html)), but that notice is about watches, not TVs.

**Tooling (2025–2026).**
- Samsung's Tizen OS site lists the **VS Code extension** as "Recommended", and a **Tizen SDK 10 with CLI installer** dated 3 Nov 2025 for Windows, Ubuntu and macOS ([samsungtizenos.com tools](https://samsungtizenos.com/tools-download/)). The page is copyright Samsung.
- The VS Code "tizentv" extension creates projects, signs with a certificate profile, launches on a TV, debugs with Chrome Web Inspector, and live-reloads on 2017+ TVs ([Samsung VS Code extension](https://developer.samsung.com/smarttv/develop/tools/additional-tools/vscode-extension.html), [GitHub](https://github.com/Samsung/vscode-extension-tizentv)).
- Tizen Studio is still what most guides assume. jellyfin-tizen requires "Tizen Studio 4.6+ with IDE or … with CLI" ([jellyfin-tizen README](https://github.com/jellyfin/jellyfin-tizen)).
- The CLI flow is `tizen build-web` → `tizen package -t wgt` → `sdb connect <TV_IP>` → `tizen install -n App.wgt -t <target>` ([jellyfin-tizen README](https://github.com/jellyfin/jellyfin-tizen)).

**Developer Mode on the TV.** Open Apps, then App Settings. Type `12345` on the remote. Switch Developer mode to On, enter the Mac's IP address, and reboot. "Develop Mode" then shows at the top of Apps. Installing over USB is no longer supported ([Samsung: Using a TV device](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html)).

**Certificates.** "All applications must be signed with valid certificates before they can be installed." A profile is one author certificate plus one or more distributor certificates. You choose the **Samsung** profile type, set to TV, and put the TV's **DUID** in the distributor certificate. The DUID is under Menu › Support › Contact Samsung. Keep the author certificate, because updates must be signed with the same one ([Samsung: Creating certificates](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html)).
- Community reports say a plain *Tizen* certificate fails on retail TVs and that you need the *Samsung* one from the Samsung Certificate Extension ([Samsung forum](https://forum.developer.samsung.com/t/first-tv-app-problems-installing-uploading-to-tv-in-developer-mode/7600), [SiliconDust forum](https://forum.silicondust.com/forum/viewtopic.php?p=382109)).
- Samsung certificates need a Samsung account sign-in. TizenBrew's docs note the sign-in prompt on Tizen 7+ ([TizenBrew docs](https://github.com/reisxd/TizenBrew/blob/main/docs/README.md)). jellyfin-tizen adds an "install permit" step for Samsung certificates (`tizen install-permit`) ([jellyfin-tizen README](https://github.com/jellyfin/jellyfin-tizen)).

**Do sideloaded apps expire?**
- Samsung's TV docs say nothing about this.
- Community sources report that **distributor certificates are valid for about one year** and must be replaced rather than extended ([Samsung forum](https://forum.developer.samsung.com/t/how-to-extend-the-validity-of-the-certificate-for-smart-tv/15415)).
- Install fails with "Certificate in signature was expired" once one lapses ([SiliconDust forum](https://forum.silicondust.com/forum/viewtopic.php?p=397979)). A Samsung moderator says a TV firmware update "often" needs a new certificate ([same thread family](https://forum.silicondust.com/forum/viewtopic.php?p=383187)).
- Whether an installed app keeps launching after its certificate expires, or after Developer Mode is switched off, is **[unverified]**. Plan on reinstalling about once a year and after some firmware updates.

**Seller Office (store).** You don't need it for personal use. Store publishing goes through QA certification ([Distributing application](https://developer.samsung.com/tv-seller-office/guides/applications/distributing-application.html), [Registration Q&A](https://developer.samsung.com/tv-seller-office/faq/application-registration.html)). Hosted apps are generally refused ([Hosted Applications Q&A](https://developer.samsung.com/smarttv/develop/faq/hosted-applications.html)). An app that talks to a private server on your own LAN couldn't pass review anyway.

## 2. Codecs and containers

The Samsung 2024 and 2026 video spec tables list ([2024](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2024-tv-video-specifications.html), [2026](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2026-tv-video-specifications.html)):
- **Containers:** MKV, MP4, MOV and TS among others, with WebM listed separately for VP8, VP9, AV1 and Vorbis.
- **Video:** H.264 up to 4K60, HEVC "only for MKV/MP4/TS", VP9 up to 4K60 (8K on 8K tiers), and **AV1** up to 4K60/120 on every 2024 and 2026 tier, including FHD BASIC4.
- **Audio:** AC3, AAC, HE-AAC, DD+ (E-AC3), MP3, AC-4, **Opus** and Vorbis.
- **Not supported:** DTS ("not supported on 2024 TVs" / "2026 TVs"). FLAC isn't on the video pages.

Samsung publishes one page per year back to 2015, for example [2021](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2021-tv-video-specifications.html) and [2023](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2023-tv-video-specifications.html). Both show VP9 and AV1. Check the page for your TV's year and tier.

**What Jellyfin actually direct-plays on Tizen.** The jellyfin-web device profile is the best evidence of what really plays, from a large user base, but it is project code, not Samsung ([browserDeviceProfile.js](https://github.com/jellyfin/jellyfin-web/blob/master/src/scripts/browserDeviceProfile.js)):
- MKV is always direct-playable on Tizen.
- AV1 is treated as supported from Tizen 5.5 (2020).
- In MKV it allows the mp4 video codecs (h264, hevc, vp9, av1) with audio aac, ac3, eac3, opus and vorbis.
- A code comment says: "On Tizen 3/4/5, OPUS is supported only in MKV/WebM".
- FLAC is excluded on Tizen because it "plays with a delay". DTS is excluded on Tizen 4+.

**What that means for this library** (applies to a 2021+ TV; table in §0):
- mkv or webm with h264, vp9 or av1 and opus or aac: **direct play**. That is 1,374 of 1,768 Copies.
- mp4 with h264 and aac: **direct play** (352).
- mp4 with vp9 and aac (41): probably fine. Samsung's tables list VP9 only on the WebM row, but Jellyfin allows VP9 in MP4 on Tizen **[verify on the TV]**. If not, remux to mkv with `-c copy`, the existing Fallback path.
- mkv with vp9 and eac3 (1): DD+ is supported, so it is likely fine.
- 2160p VP9/AV1 (25): fine with AVPlay. Through a plain `<video src>`, 4K is **[unverified]** (see §3).
- No video re-encoding is needed. The existing `decidePlayback` rule is a reasonable TV rule too. The TV needs no new Fallback kind unless VP9-in-MP4 fails.
- **Older TVs:** a 2018–2019 TV (Tizen 4–5) might lack AV1 (187 Copies) and would need a real transcode. The Mac is an M1, and per [Jellyfin's Apple HW acceleration doc](https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/apple/) AV1 hardware decode starts at M3. Transcoding AV1 to H.264 on an M1 would be software decode, so slow.

## 3. HTML5 `<video>` vs AVPlay

- Samsung: "common media formats can be played using the HTML5 `<video>` and `<audio>` elements". AVPlay is for adaptive streaming, extra subtitle formats, **4K UHD video** and DRM ([Playback using AVPlay](https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html)). `<video>` supports `currentTime` seeking, `playbackRate` (negative plays in reverse) and WebVTT `<track>` only ([Playback using video elements](https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-video-elements.html)). `getVideoPlaybackQuality()` is not supported ([Multimedia Q&A](https://developer.samsung.com/smarttv/develop/faq/multimedia.html)). The State panel's dropped-frames readout would be blank.
- **MSE** "supports resolutions up to FHD; it does not support UHD" ([2026 spec](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2026-tv-video-specifications.html)). That doesn't matter here, because the app uses plain `src`, not MSE (ADR-0002).
- **AVPlay** accepts "remote network URIs". It renders on a hardware plane positioned with `setDisplayRect` in a fixed 1920×1080 space ([AVPlay guide](https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html)), so HTML overlays sit around the video, not on it. It plays DASH, Smooth Streaming and HLS ([Adaptive Streaming](https://developer.samsung.com/SmartTV/develop/guides/multimedia/adaptive-streaming.html)). 4K needs `SET_MODE_4K`. Its default buffer is 10 s or 15 MB, and Samsung TVs "do not support UDP" ([Multimedia Streaming Q&A](https://developer.samsung.com/smarttv/develop/faq/multimedia-streaming.html)).
- **Range-request progressive playback:** Samsung's docs don't say how either player uses HTTP Range **[unverified]**. Jellyfin direct-plays progressive MKV/MP4 to Tizen through `/Videos/{id}/stream`, which in practice means Range-served files work. The existing `/copy/:id` (206 + `Accept-Ranges`) is the same shape.
- **Choice:** start with `<video src="http://mac:4400/copy/:id">` because it keeps the existing Player model. Switch to AVPlay only if 4K or seeking behaves badly.

## 4. Remote control and D-pad navigation

- ArrowLeft/Up/Right/Down (37–40), Enter (13) and Back (10009) arrive as DOM key events with no registration ([Remote Control guide](https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html)).
- Media keys must be registered with `tizen.tvinputdevice.registerKey()` / `registerKeyBatch()`. That needs privilege `http://tizen.org/privilege/tv.inputdevice` in config.xml. Examples: MediaPlayPause 10252, Play 415, Pause 19, Rewind 412, FastForward 417, TrackPrevious/Next 10232/10233, colour keys 403–406, digits 48–57 ([Remote Control guide](https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html), [TVInputDevice API](https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/tvinputdevice-api.html)).
- A registered key loses its default behaviour. A React app hitting "tizen is not defined" also needs `$WEBAPIS/webapis/webapis.js` in index.html ([Samsung forum](https://forum.developer.samsung.com/t/remote-key-registration-not-working/22670)).
- The Smart Remote has only essential keys. Digits and colour keys come up as on-screen virtual keys ([Remote Control guide](https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html)). So the mpv-style key table (spec §4.5) doesn't carry over: map arrows to ±5 s or seek, Enter to play/pause, Back to leave the Player, and media keys if present.
- **Focus management:** [Norigin Spatial Navigation](https://github.com/NoriginMedia/norigin-spatial-navigation) is tested on Tizen. It works out focus from on-screen positions and is a React hooks library. Using it from Preact would need `preact/compat` **[untested]**. A hand-rolled focus model is also realistic for a screen with one grid plus a Player, since it is just a row/column index.

## 5. Discovery and network access

- **Discovery:** Samsung TVs "do not support UDP" for streaming ([Multimedia Streaming Q&A](https://developer.samsung.com/smarttv/develop/faq/multimedia-streaming.html)). Tizen has DNS-SD/SSDP APIs on the *native* and .NET side ([Tizen Network Service Discovery](https://docs.stg.tizen.org/application/native/guides/connectivity/nsd/), [SsdpBrowser](https://docs.tizen.org/application/dotnet/api/TizenFX/API8/api/Tizen.Network.Nsd.SsdpBrowser.html)). I found no web-app API for mDNS or SSDP on Samsung TV **[unverified]**.
- For one Mac, **hardcode the LAN URL or ask for it once** and store it in `localStorage`. Give the Mac a DHCP reservation or use its `.local` name. Whether the TV resolves `.local` names is **[unverified]**, so prefer the IP.
- **Network access in config.xml:** add `http://tizen.org/privilege/internet` and `<access origin="http://192.168.x.y:4400" subdomains="true"/>`. Network resources are blocked by default under WARP ([Networking Q&A](https://developer.samsung.com/smarttv/develop/faq/networking-and-connectivity.html), [Configuring Web Applications](https://developer.samsung.com/SmartTV/develop/guides/fundamentals/configuring-tv-applications.html)).
- I found no Samsung statement that blocks cleartext `http://` from a packaged web app **[unverified]**. Jellyfin users commonly connect to `http://` LAN servers, which suggests it works.
- **Hosted apps:** Samsung says "Tizen APIs are not supported in hosted applications" ([Hosted Applications Q&A](https://developer.samsung.com/smarttv/develop/faq/hosted-applications.html)). If the `<content src>` is the Mac's URL, `tizen.tvinputdevice` is unavailable, so there are no media keys, though arrows, Enter and Back still work. The workaround is a packaged local `index.html` that registers keys and iframes the LAN page, forwarding keys with `postMessage` **[pattern not verified on device]**.
- **On the server:** CORS headers if the packaged app fetches `/api/*` from `file://`/`app://`. Binding to `0.0.0.0`, or better the LAN interface plus an allowlist of the TV's IP, given there is no auth. Possibly a read-only route set for the TV.

## 6. Alternatives that avoid a custom TV app

**(a) Mac as a DLNA server plus the TV's media player.**
- Samsung's support pages describe DLNA/"Samsung Link" playback from a PC, but the article is for 2014 H-series ([Samsung support](https://www.samsung.com/in/support/tv-audio-video/what-are-the-requirements-to-stream-media-from-your-home-computer-in-samsung-h-series-tv/)). I found no current Samsung page confirming DLNA on 2022+ models **[unverified]**.
- Universal Media Server users report Samsung renderer profiles that fall back to HLS transcoding and treat VP9 as WebM-only ([UMS forum](https://universalmediaserver.com/forum/viewtopic.php?p=47679)).
- You would lose Chapters, lyrics, Artists and Songs, and resume only works within the DLNA app. Low value.

**(b) The TV's web browser pointed at `http://mac:4400`.**
- No official statement exists. Community threads report video failing or buffering in the Samsung TV browser ([Samsung EU community](https://eu.community.samsung.com/t5/tv/cant-play-videos-from-web-browser/td-p/3256421)).
- It has no media-key access, and pointer-style navigation is awkward. It costs nothing to *try* once the server binds to the LAN, but don't plan on it.

**(c) AirPlay 2 from the Mac.**
- Samsung lists AirPlay 2 on selected 2018–2021 TVs and says to check Settings › General › Apple AirPlay Settings ([Samsung UK, updated Jan 2025](https://www.samsung.com/uk/support/tv-audio-video/streaming-through-airplay/)). Newer models aren't on that page **[verify on the TV]**. On the Mac it is Control Center › Screen Mirroring ([Apple](https://support.apple.com/guide/imac/apdf1417128d/2022/mac/13)).
- That is screen mirroring, or a video handed off from Safari, not a TV UI. The Mac stays awake and is the remote. Zero effort, fine for a one-off concert, not a "TV version".

**(d) Jellyfin.**
- **Client:** an official Jellyfin app reached the Samsung store in Dec 2025 – Feb 2026, for 2021+ / Tizen 6+ models, with patchy regional rollout ([SamMobile](https://www.sammobile.com/news/jellyfin-app-samsung-tv-launched-plex-alternative/), [Linuxiac](https://linuxiac.com/after-years-of-waiting-jellyfin-finally-lands-on-samsung-tizen-tvs/)). Both are secondary press. The Jellyfin repo is the primary source for sideloading ([jellyfin-tizen](https://github.com/jellyfin/jellyfin-tizen), last push 2026-10-05). Community one-command installers exist, such as `docker run ghcr.io/georift/install-jellyfin-tizen <tv-ip>` and Apps2Samsung ([jellyfin-tizen-builds](https://github.com/jeppevinkel/jellyfin-tizen-builds)). These are third-party.
- **Real Jellyfin server:** a DMG for macOS; Apple Silicon needs macOS 14+ or the x86 build ([Jellyfin macOS install](https://jellyfin.org/docs/general/installation/macos/)). This Mac runs macOS 15.7 on an M1. Point a "Home videos" or "Movies" library at the folder. You get thumbnails, resume and a TV-native UI, but none of the Mirror metadata. Duplicates show as separate items, and Chapters are not exported. Running a second scanner over 222 GB is cheap.
- **A Jellyfin-compatible API in this server:** the stable OpenAPI spec (v12.2.0) has **294 paths / 346 operations** ([api.jellyfin.org](https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json)). The client needs at least system info, auth, users, views, items queries, images, PlaybackInfo, streams, sessions and progress reporting. Their DTOs are large, and the client is tightly coupled to server versions **[estimate, not prototyped]**. That is weeks of work to keep compatible. Not worth it.

**(e) HLS from the Node server via ffmpeg.** AVPlay and the video element would play it ([Adaptive Streaming](https://developer.samsung.com/SmartTV/develop/guides/multimedia/adaptive-streaming.html)), but the library already direct-plays (§2), so HLS adds live ffmpeg jobs and a segment cache for no gain. It only becomes useful for an old TV without AV1, or for bandwidth limits over Wi-Fi. It also contradicts the "never a live pipe" decision in spec §3.4.

**(f) A thin wrapper app that loads the existing React (Preact) app from the LAN.**
- This is a sideloaded `.wgt` whose `content src` or iframe is `http://mac:4400/`. Samsung's store refuses hosted apps, but sideloading isn't the store.
- Tizen APIs aren't available in the hosted page, so media keys need the iframe-and-`postMessage` pattern in §5.
- The current UI was built for keyboard and mouse at desktop width. Without a focus layer it is barely usable with a D-pad, so a `/tv` route is the real work, not the wrapper.

## 7. Effort estimates

All estimates assume a 2021+ TV and someone fluent in this repo. **[estimates]**

| Approach | Effort | Pros | Cons |
|---|---|---|---|
| AirPlay mirroring (c) | 0 h | Instant | Mirroring only, Mac is the remote, model-dependent |
| TV browser (b) | 1–2 h (LAN bind + try) | No app | Video in the TV browser is unreliable; no media keys |
| Jellyfin server + official client (d) | 2–4 h | Polished TV UI, resume, no certificates if the store app is available | No Chapters, lyrics or Mirror metadata; second library to keep in sync; duplicates |
| DLNA server (a) | 2–4 h | Built-in TV player | Metadata lost; Samsung DLNA on new models undocumented; renderer quirks |
| **Custom sideloaded Tizen app (packaged Preact `/tv` UI or iframe wrapper (f) + D-pad layer)** | **2–4 days** | Your library, Chapters and Favorites on the TV; reuses `/api`, `/copy/:id`, Thumbnails, Fallbacks | Certificates, Developer Mode, reinstall about yearly; LAN exposure without auth |
| – of which: toolchain, certificate, first "hello" on TV | 0.5–1 day | | Samsung-account certificate setup is the usual stumbling block |
| – LAN bind + TV-IP allowlist + CORS | 2–4 h | | Changes the "localhost only" constraint |
| – TV UI: Library grid, Video page, Player, Back, resume, Chapters list | 1.5–2.5 days | | |
| HLS via ffmpeg (e) | 2–4 days extra | Bandwidth and old-TV fallback | Live transcode against spec §3.4; not needed for 2021+ |
| Jellyfin-compatible API in this server (d) | 2–4+ weeks | Free TV UI | Large, version-coupled surface |

**Recommendation.**
1. Find the model year.
2. Spend an evening on Jellyfin, from the store if possible, against the archive folder to confirm direct play of the mkv/Opus, VP9-in-MP4, AV1 and 4K files on *this* TV.
3. If you still want Chapters, lyrics and Favorites on the couch, build the small sideloaded Tizen app:
   - packaged `.wgt`, hardcoded or typed-in LAN URL;
   - plain `<video src="/copy/:id">`, AVPlay only if 4K needs it;
   - a hand-rolled or Norigin focus grid;
   - the server bound to the LAN with an allowlist of the TV's IP.

   Write it up as an ADR, since it changes "localhost only".

## Unverified / open

- How Samsung's video element and AVPlay use HTTP Range; whether `<video src>` plays 4K VP9/AV1 without AVPlay.
- VP9 in MP4 on Samsung (41 Copies). Jellyfin allows it; Samsung's tables list VP9 only on the WebM row.
- Whether sideloaded apps stop *launching* after certificate expiry or Developer Mode off, versus only failing to reinstall.
- DLNA and AirPlay availability on 2022+ Samsung models (Samsung pages found are older).
- mDNS (`.local`) resolution and any cleartext-HTTP restriction in packaged Tizen web apps.
- Media-key registration surviving navigation to a remote page in a wrapper app.
- Jellyfin store app: exact regions and models (only press coverage found).
