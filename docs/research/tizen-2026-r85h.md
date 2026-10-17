# Research: Tizen platform facts for the 2026 R85H

Resolves [#47](https://github.com/IncoherentThoughts/TuvaVideos/issues/47) (part of map #43). Question: what are the platform facts for a sideloaded web app on the Samsung **MRN85R85HAFXZA** (2026 85" Micro RGB R85H)? Covers the Tizen version, tooling, certificates and their cost, Developer Mode, what survives expiry and firmware updates, `<video>` vs AVPlay, remote keys, and cleartext HTTP to a LAN IP.

Researched 2026-10-11 from primary sources only: developer.samsung.com, Samsung's Tizen site (samsungtizenos.com, copyright Samsung), the VS Code Marketplace listings Samsung publishes, and the jellyfin-tizen and jellyfin-web source. Nothing was tried on the TV. This builds on `docs/research-samsung-tv-streaming.md` (the "prior note"); §9 confirms or corrects each of its unverified items. **[unverified]** marks claims no primary source settles. **[test on TV]** marks the ones the hello-world install (#48) should settle.

## Answer (TL;DR)

- **Platform:** the R85H is in Samsung's **26TV_PREMIUM2** model group. That means **Tizen 10.0**, web engine **Chromium M130**, and a **1920×1080 app canvas** on a 3840×2160 panel ([TV Model Groups][groups], [General Specifications][general], [Web Engine Specifications][engine]). Samsung says 2023+ sets "will support OS Upgrade", so this set may later move to Tizen 11+ ([General Specifications][general]).
- **Tooling:** Samsung's own TV install page still documents **Tizen Studio 6.1 + TV Extensions + Samsung Certificate Extension 2.0.73** ([Installing TV SDK][install]). The newer path is the **"Tizen Extension" for VS Code** (`tizen.vscode-tizen-csharp`, v10.4.3, updated 2026-10-02), which "does not require any pre-installed SDK tools", plus Samsung's **"Tizen TV Extension"** add-on (`samsungtvsdk.tv-vscode-tizen`, v1.0.0, 2026-03-06) ([Marketplace][mkt-tizen], [Marketplace][mkt-tv]). The old `tizensdk.tizentv` extension was last published in 2023 (v1.3.3). A standalone **Tizen SDK 10 CLI installer** (3 Nov 2025) exists for Windows, Ubuntu and macOS ([Tizen tools][tools]). For #48, the jellyfin-tizen CLI flow is the best-documented route.
- **Certificates cost nothing as far as any source shows.** The flow needs only a free Samsung account sign-in and a free download, and no Samsung page mentions a fee. Samsung never states "free" outright **[unverified, by absence]**. Use a **Samsung** (not Tizen) certificate profile, type TV, with the TV's **DUID** in the distributor certificate. Certificate Extension versions before **2.0.73** cannot create certificates after September 2025 ([Installing TV SDK][install], [Creating Certificates][certs]).
- **Certificate lifetime:** Samsung's TV docs give no validity period. Samsung's own Tizen site says an author certificate can be set to "up to 25 years". Forum reports put the **distributor certificate at about 1 year** **[unverified, community]**. Samsung's Watch FAQ (same certificate system, but a different platform) says expiry blocks new installs and "does not affect any apps that have already been installed" ([Watch certificate FAQ][watchfaq]). For TVs, whether an installed app keeps launching after expiry is **[unverified]** **[test on TV]**.
- **Firmware updates:** there is no Samsung statement. A Jellyfin forum report says a major Tizen update on a 2023 S95C **removed the sideloaded app**, and reinstalling needed a fresh certificate ([Jellyfin forum][jf-gone]). Plan for "reinstall after an OS upgrade" as a known chore.
- **Playback:** use **`<video src>`**, which is what Jellyfin does on Tizen. It never uses hls.js/MSE there and sets no width cap on UHD panels ([htmlMediaHelper.js][jf-hls], [tizen.js][jf-tizenjs]). Samsung says MSE stops at FHD, but this app uses plain `src`. Samsung frames AVPlay as the API for "4K UHD video" ([Multimedia Q&A][mmfaq], [AVPlay][avplay]), so 4K through `<video>` is **[test on TV]**. AVPlay remains the fallback.
- **Codec table correction:** Samsung's 2026 table lists **VP9 only on the WebM row**, with **Vorbis** as the WebM row's audio codec. **Opus** sits on the shared MKV/MP4 row. **AV1** is on both rows ([2026 video specs][v2026]). Taken literally, this table does not list **mkv+VP9 (170 Copies)** or **webm+Opus (466 Copies)**, yet Jellyfin's Tizen profile direct-plays both ([browserDeviceProfile.js][jf-bdp]). **[test on TV]**.
- **Keys:** Arrows, Enter and Back (10009) arrive without registration. Media and colour keys need `tizen.tvinputdevice.registerKey()` and the `http://tizen.org/privilege/tv.inputdevice` privilege ([Remote Control][remote]).
- **Cleartext HTTP to a LAN IP:** no Samsung source forbids it. Jellyfin ships `<access origin="*">` with a permissive CSP meta tag and talks to `http://` LAN servers ([config.xml][jf-config], [gulpfile][jf-gulp]). Add `http://tizen.org/privilege/internet` and `<access origin="http://<mac-ip>:<port>">` per Samsung's FAQ ([Networking Q&A][netfaq]).

## 1. The TV: model group, Tizen version, engine

| Fact | Value | Source |
|---|---|---|
| Model group | **26TV_PREMIUM2**. Its lineup includes R85H, R85HB, R85HD, R85HDB and R87H. R90H/R95H are in PREMIUM1 | [TV Model Groups][groups] |
| Platform / SDK | Tizen 10.0, "TV Extension 10.0 or higher" | [TV Model Groups][groups] |
| Tizen by year | 2023 = 7.0, 2024 = 8.0, 2025 = 9.0, **2026 = 10.0** | [General Specifications][general] |
| Web engine | **Chromium M130** (2025: M120) | [Web Engine Specifications][engine] |
| JS engine | V8 | [General Specifications][general] |
| App resolution | "1920x1080 (All models)". The video plane is 3840×2160 on 4K models | [General Specifications][general] |
| OS upgrades | "Samsung Smart TV from the 2023 lineup onwards will support OS Upgrade", so the "General Features are not fixed and can be changed every year" | [General Specifications][general] |
| HTTP/2 | Listed as supported for 2024–2026 | [Web Engine Specifications][engine] |
| 2026 platform changes | GCC 14.2.0 for native binaries (irrelevant to web apps); RealMedia dropped; DTS unsupported | [General Specifications][general], [2026 video specs][v2026] |

Because the app canvas is 1920×1080, CSS pixels are FHD-sized on this TV. Grid and type sizes should be designed for 1920×1080, not 3840×2160. jellyfin-tizen multiplies the reported resolution by 2 when `webapis.productinfo.isUdPanelSupported()` is true ([tizen.js][jf-tizenjs]).

## 2. Tooling in 2026

- **Samsung's TV install page** (current, © 2026) documents only **Tizen Studio** (`tizen-studio_6.1`), **TV Extensions** via Package Manager, and **Samsung Certificate Extension 2.0.73**. It notes: "Certificate creation will not be possible in Samsung Certificate Extension versions prior to 2.0.73 after September 2025" ([Installing TV SDK][install]).
- **Samsung's Tizen tools page** labels the **VS Code extension "Recommended"** and offers a **Tizen SDK 10 with CLI installer** dated Nov 3, 2025, for Windows, Ubuntu and Mac OS X ([Tizen tools][tools]).
- **VS Code extensions on the Marketplace** (queried 2026-10-11):
  - `tizen.vscode-tizen-csharp` "Tizen Extension" **10.4.3**, updated 2026-10-02. It builds Web (.wgt), .NET and Native apps, deploys, runs and debugs. "Unlike the previous Tizen VS Code Extension, this version **does not require any pre-installed SDK tools**". Requires macOS 12+ ([Marketplace][mkt-tizen]).
  - `samsungtvsdk.tv-vscode-tizen` "Tizen TV Extension" **1.0.0**, 2026-03-06. It is the TV plugin, and the "Tizen Extension (tizen.vscode-tizen-csharp) is required" for it ([Marketplace][mkt-tv]).
  - `tizensdk.tizentv` **1.3.3**, last published 2023-10-23. This is the extension Samsung's [VS Code extension page][vscode] and [GitHub repo][vscode-gh] (last commit 2023-10-31) still describe. Treat it as legacy.
- **The CLI flow** used by jellyfin-tizen, which needs "Tizen Studio 4.6+ with IDE or … with CLI" ([jellyfin-tizen README][jf-readme]):
  ```
  tizen build-web -e ".*" -e "node_modules/*" …
  tizen package -t wgt -o . -- .buildResult
  sdb connect <TV_IP>
  tizen install-permit -t <device>          # only with a Samsung certificate
  tizen install -n App.wgt -t <device>
  ```
  "If you change or create a Samsung certificate, you must rebuild the WGT before installing" ([jellyfin-tizen README][jf-readme]).
- Apple Silicon: the new VS Code Tizen Extension lists macOS 12+ with no architecture caveat. Samsung's install page doesn't mention macOS **[unverified on M1; #48 will find out]**.

## 3. Certificates and cost

**How they work** ([Creating Certificates][certs]):
- "All applications must be signed with valid certificates before they can be installed or run."
- A profile is one author certificate plus one or more distributor certificates. In Certificate Manager, choose **Samsung**, then **TV**.
- The distributor certificate needs the TV's **DUID**, found under Menu › Support › Contact Samsung › Unique Device ID. You can also add it from a connected device with "+".
- Prerequisite: a "Samsung Developers Portal account". You sign in while creating the author certificate.
- Updates must be signed with the same author certificate, so back up the certificate files.
- Samsung vs Tizen certificate: jellyfin-tizen says to try a Tizen certificate and switch to a Samsung certificate, "you will also need a Samsung account", if installation fails ([jellyfin-tizen README][jf-readme]). The prior note cites forum reports that retail TVs need the Samsung one. Go straight to Samsung.
- With a Samsung certificate there is an extra **install-permit** step, through Device Manager's "Permit to install applications" or `tizen install-permit` ([jellyfin-tizen README][jf-readme]).

**Cost.** No primary source mentions any fee:
- The documented flow is a Samsung account sign-in, a free download of Tizen Studio or the VS Code extension, and a free download of the Certificate Extension ([Installing TV SDK][install], [Creating Certificates][certs]).
- No step in Samsung's TV certificate pages, the jellyfin-tizen README, or the Marketplace listings involves payment.
- Samsung never states "free" in so many words, so this is **[unverified, by absence]**, but nothing points the other way.
- Seller Office registration and partner-level privileges are not needed. They are for store distribution, and partner privileges only matter for partner-only APIs, which this app doesn't use.
- Contrast with Apple: MusicKit needs a paid Apple Developer membership (`docs/research/apple-music-control.md`). Samsung has no equivalent paywall.

**Validity.**
- Samsung's TV certificate page gives **no validity period and no renewal procedure** ([Creating Certificates][certs]).
- Samsung's Tizen knowledge hub says the author certificate validity can be set "up to 25 years". The page is labelled AI-generated, regenerated 2026-04-22 ([Extending certificate duration][extend-hub]).
- Samsung's Watch docs (same Certificate Manager and Samsung Certificate Extension) say there is no way to extend an existing certificate. You replace an expired **distributor** certificate inside the same profile and keep the **author** certificate ([Watch: extending certificates][watchextend]).
- Distributor validity of **about 1 year** comes from developer-forum reports only **[unverified, community]**, as in the prior note.

## 4. Developer Mode on the TV

From Samsung's current guide ([Using a TV device][tvdevice]):
1. Smart Hub → **Apps** panel → scroll to **App Settings**.
2. Enter **12345** with the remote or on-screen keypad.
3. Set **Developer mode** to **On**.
4. Enter the **Mac's IP address** and press OK.
5. **Reboot** the TV. "Develop Mode" then shows at the top of the Apps panel.

Before starting: install the latest firmware, put both devices on the same network, and create the certificate profile first. "For security reasons, installing applications or widgets through USB is no longer supported." Installing a newer version uninstalls the previous one automatically. The guide doesn't say whether Developer Mode expires or survives firmware updates **[unverified]** **[test on TV]**. The guide doesn't change this flow for 2026 models. On the TV, the Apps panel's exact wording may differ **[test on TV]**.

## 5. What survives certificate expiry and firmware updates

| Event | Effect | Confidence |
|---|---|---|
| Distributor certificate expires | New installs and updates fail with "Certificate in signature was expired" (forum reports in the prior note) | Community, consistent |
| …already-installed app | Watch FAQ: "the expired certificate does not affect any apps that have already been installed on your watch" ([Watch certificate FAQ][watchfaq]). No TV statement exists | **[unverified for TV]** **[test on TV]**: not testable until expiry |
| Developer Mode switched off | No source found | **[unverified]**. Could be tested in #48: toggle it off and relaunch |
| Major Tizen update / OS upgrade | A 2023 S95C lost its sideloaded Jellyfin app after a major Tizen update. Reinstall failed with "Invalid certificate chain" until it was re-signed with a fresh self-made certificate ([Jellyfin forum][jf-gone]). A Samsung moderator said firmware updates "often" need a new distributor certificate (prior note) | Community, two independent reports |

Takeaway for the "Updating the TV app" open question on map #43: expect a re-sign and reinstall **about yearly** and **after OS upgrades**. Scripting `build → package → install` with the CLI is worthwhile.

## 6. Playback: `<video>` vs AVPlay

**What Samsung says**
- "Common media formats can be played using the HTML5 `<video>` and `<audio>` elements". AVPlay is for features HTML5 lacks: "adaptive streaming", extra subtitle formats and **"4K UHD video"** ([AVPlay][avplay]). The Multimedia Q&A lists "4K/8K UHD video" among AVPlay-only features ([Multimedia Q&A][mmfaq]).
- Samsung's `<video>` guide doesn't mention resolution at all. It documents `currentTime` seeking, `playbackRate` (negative plays in reverse), and WebVTT `<track>` only ([Video element][videoel]).
- `getVideoPlaybackQuality()` "is not supported" ([Multimedia Q&A][mmfaq]).
- MSE: "MSE supports resolutions up to FHD; it does not support UHD" ([2026 video specs][v2026]). This doesn't apply to plain `src` (ADR-0002).
- AVPlay specifics:
  - Supports "absolute local paths and remote network URIs".
  - `setDisplayRect` uses a fixed 1920×1080 space.
  - `seekTo`, `jumpForward` and `jumpBackward` work, but cannot seek to exactly 0 or the end; use about 1000 ms.
  - The `avplay` privilege "is not used in TV Web applications".
  - Network access comes from config.xml CSP and access settings.
  - ([AVPlay][avplay], [Multimedia Q&A][mmfaq])

**What Jellyfin does (project code, large install base)**
- On Tizen, `enableHlsJsPlayer()` returns false: "The native players on these devices support seeking live streams" ([htmlMediaHelper.js][jf-hls]). Direct play is `<video src>` on the native player, not MSE and not AVPlay.
- The bitrate cap applies only when `isUdPanelSupported()` is false (20 Mbps for FHD sets). jellyfin-tizen passes no `maxVideoWidth` ([browserDeviceProfile.js][jf-bdp], [tizen.js][jf-tizenjs]). So on UHD Tizen sets Jellyfin direct-plays 4K files through `<video src>`.
- This is strong practical evidence that 4K through `<video>` works on recent Tizen. It is not a Samsung guarantee **[test on TV]** with one of the 25 Copies at 2160p.

**HDR**
- Samsung's 2026 video page has no HDR section. It lists VP9 "Profile 0/2" (10-bit) and HEVC Main10 ([2026 video specs][v2026]).
- Jellyfin's profile treats Tizen as HDR10/HLG-capable and says "Tizen TV does not support Dolby Vision at all, but it can safely play the HDR fallback" ([browserDeviceProfile.js][jf-bdp]).
- The library has 5 VP9 Profile 2 files (`docs/research/chromium-playback.md`). HDR is a nice-to-have **[test on TV]**.

**Range requests**
- No Samsung page says how either player issues HTTP Range **[unverified]**.
- Indirect evidence:
  - Samsung's limitations note says "Seek (jump) function is not supported if the index table is corrupted" ([2026 video specs][v2026]). Index-based seeking in a remote progressive file implies byte-range fetches.
  - Jellyfin direct-plays progressive files to Tizen from a static stream endpoint.
- The existing `/copy/:id` (206 + `Accept-Ranges`) is the right shape. #48 should log the TV's request headers to confirm.

## 7. Codecs on the R85H (26TV_PREMIUM2), against this library

The 2026 table has two rows per tier ([2026 video specs][v2026]). The PREMIUM2 table matches PREMIUM1:
- **Shared row** for `*.mkv *.mp4 *.mov *.ts …`:
  - Video: H.264 4096×2160@60 (60 Mbps); HEVC Main/Main10 4096×2160@60 and 3840×2160@120 (80 Mbps); **AV1** 3840×2160@120 (40 Mbps).
  - Audio: AC3, AAC, HE-AAC, DD+, MP3, MPEG-H, AC-4, **OPUS**, and others.
- **WebM row** (`*.webm`): **VP9 (Profile 0/2)** @60 (80 Mbps), VP8 FHD, **AV1** 3840×2160@120. Audio: **Vorbis** only.
- Notes: "HEVC: Supported only for MKV/MP4/TS containers". DD+ 5.1 is supported. DTS "is not supported on 2026 TVs".

Library Copies (from the prior note) against Samsung's literal table and Jellyfin's Tizen direct-play profile ([browserDeviceProfile.js][jf-bdp]: mkv allows h264/hevc/vp9/av1 + aac/ac3/eac3/opus/vorbis; webm allows vp9/av1 + vorbis/opus; mp4 allows vp9/av1 but **not opus** on Tizen):

| Copies | Combo | Samsung 2026 table | Jellyfin Tizen profile | Verdict |
|---|---|---|---|---|
| 517 | mkv h264 opus | listed | direct play | ✅ |
| 352 | mp4 h264 aac | listed | direct play | ✅ |
| 49 | mkv h264 aac | listed | direct play | ✅ |
| 172 | mkv av1 opus | listed | direct play | ✅ |
| 451 | webm vp9 opus | VP9 listed, **Opus not on the WebM row** | direct play | likely ✅ **[test on TV]** |
| 15 | webm av1 opus | AV1 listed, **Opus not on the WebM row** | direct play | likely ✅ **[test on TV]** |
| 140 + 30 | mkv vp9 opus / aac | **VP9 not on the MKV row** | direct play | likely ✅ **[test on TV]** |
| 41 | mp4 vp9 aac | **VP9 not on the MP4 row** | direct play | likely ✅ **[test on TV]** |
| 1 | mkv vp9 eac3 | DD+ listed, VP9-in-MKV as above | direct play | likely ✅ **[test on TV]** |

If any "likely" row fails on the TV, the fix is the existing Fallback path: a `-c copy` remux into a container the table lists (VP9 → webm; Opus-in-webm → mkv). No video re-encode is needed. 4K AV1 at 120 fps and 4K VP9 at 60 fps are within PREMIUM2 limits.

## 8. Remote keys and network access (config.xml)

**Keys** ([Remote Control][remote], [TVInputDevice API][tvinput]):
- **No registration needed:** ArrowLeft/Up/Right/Down 37–40, Enter 13, Back 10009.
- **Register** with `tizen.tvinputdevice.registerKey('MediaPlayPause')` or `registerKeyBatch([...])`, and declare `<tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>`. Match `event.keyCode` against `tizen.tvinputdevice.getKey(name).code`.
  - Media keys: MediaPlayPause 10252, MediaPlay 415, MediaPause 19, MediaStop 413, MediaRewind 412, MediaFastForward 417, MediaTrackPrevious 10232, MediaTrackNext 10233.
  - Colour keys: ColorF0Red 403, ColorF1Green 404, ColorF2Yellow 405, ColorF3Blue 406.
  - Others: Exit 10182, Info 457, and digits 48–57.
- On the Smart Remote, a short press of Back/Exit sends **Back** and a long press sends **Exit**. The Smart Remote has limited keys, and the rest come from an on-screen "123" panel.
- jellyfin-tizen registers MediaPlay, MediaPause, MediaStop, MediaTrackPrevious, MediaTrackNext, MediaRewind and MediaFastForward at start. It registers MediaPlayPause only on video and queue screens ([tizen.js][jf-tizenjs]). It also injects `<script src="$WEBAPIS/webapis/webapis.js">` for `webapis.*` ([gulpfile][jf-gulp]).
- Hosted apps get no Tizen APIs: "For security reasons, Tizen APIs are not supported in hosted applications" ([Hosted Applications Q&A][hostedfaq]). Package the UI locally (`<content src="index.html"/>`) and fetch from the Mac. Don't point `content src` at the Mac.

**Network access**
- "According to the W3C Access Requests Policy (WARP), you cannot access network resources by default" ([Configuring Web Applications][config]).
- Samsung's FAQ: add `<tizen:privilege name="http://tizen.org/privilege/internet"/>` and an `<access origin="…" subdomains="true"/>` per server ([Networking Q&A][netfaq]).
- **CSP:** Samsung's store rejects `unsafe-inline`/`unsafe-eval` ([Hosted Applications Q&A][hostedfaq]), but that is a store-submission rule and doesn't apply to sideloading. jellyfin-tizen injects `default-src * 'self' 'unsafe-inline' 'unsafe-eval' data: … ws: wss:` as a meta tag ([gulpfile][jf-gulp]).
- **Cleartext `http://` to a LAN IP:** no Samsung page restricts it **[unverified, by absence]**.
  - jellyfin-tizen's `config.xml` uses `<access origin="*" subdomains="true">`. It declares only `tv.inputdevice` and `productinfo` privileges, not even `internet` ([config.xml][jf-config]).
  - Users connect it to plain-HTTP LAN servers.
  - Recommended minimal config:
    ```xml
    <access origin="http://192.168.x.y:PORT" subdomains="false"/>
    <tizen:privilege name="http://tizen.org/privilege/internet"/>
    <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>
    <tizen:privilege name="http://developer.samsung.com/privilege/productinfo"/>
    ```
    #48 should confirm that a fetch and a `<video src>` to the Mac's `http://` IP both succeed **[test on TV]**.
- **CORS:** the packaged app's origin is not the Mac's, so `/api/*` needs CORS headers for the TV's origin. Media `src` loads don't need CORS unless the video is drawn to a canvas. This is standard web behaviour, nothing Samsung-specific.

## 9. The prior note's unverified items: confirmed or corrected

| Prior note's claim / open item | Now |
|---|---|
| "First check the model year" | **Settled:** 2026, Tizen 10.0, M130, 26TV_PREMIUM2 ([groups]) |
| Tooling: VS Code extension "tizentv" | **Corrected:** `tizentv` is legacy (2023). The current extension is `tizen.vscode-tizen-csharp` 10.4.3 plus the TV add-on `samsungtvsdk.tv-vscode-tizen`. Samsung's install page still documents Tizen Studio 6.1 ([mkt-tizen], [mkt-tv], [install]) |
| Samsung certificate, DUID, sign-in | **Confirmed**, plus the Certificate Extension ≥ 2.0.73 requirement since Sept 2025 ([install], [certs]) |
| Cost | **Confirmed by absence:** no fee anywhere in the flow; Samsung never says "free" |
| Distributor cert ≈ 1 year | **Still community-only.** Author certificate up to 25 years per Samsung's (AI-generated) hub page ([extend-hub]) |
| App launches after cert expiry / Developer Mode off? | **Still [unverified] for TV.** Watch FAQ says installed apps are unaffected by expiry ([watchfaq]) |
| Firmware update needs new cert | **Strengthened:** a second independent report of an OS update wiping the sideloaded app ([jf-gone]). 2023+ sets get OS upgrades ([general]) |
| 4K via `<video src>` | **Likely yes:** Jellyfin direct-plays 4K via native `<video>` on UHD Tizen, with no MSE and no cap ([jf-hls], [jf-bdp]). Samsung still frames 4K as AVPlay's job. **[test on TV]** |
| HTTP Range use by the players | **Still [unverified]**. Index-based seek note is indirect evidence ([v2026]) |
| VP9 in MP4 (41) | **Widened:** Samsung's 2026 table also omits **VP9 in MKV (171)** and **Opus in WebM (466)**. Jellyfin allows all three. **[test on TV]** |
| E-AC3 (1) | DD+ listed for MKV. Only the VP9-in-MKV question remains |
| Cleartext HTTP | **No restriction found.** Jellyfin precedent is `access origin="*"` plus a permissive CSP |
| mDNS / `.local`, DLNA, AirPlay | Not re-researched (out of #47's scope). Use the IP |
| Media keys in a wrapper/iframe | Moot if the UI is packaged locally, as recommended |

## Sources

[groups]: https://developer.samsung.com/smarttv/develop/specifications/tv-model-groups.html
[general]: https://developer.samsung.com/smarttv/develop/specifications/general-specifications.html
[engine]: https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html
[v2026]: https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2026-tv-video-specifications.html
[install]: https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html
[certs]: https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html
[tvdevice]: https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html
[vscode]: https://developer.samsung.com/smarttv/develop/tools/additional-tools/vscode-extension.html
[vscode-gh]: https://github.com/Samsung/vscode-extension-tizentv
[tools]: https://samsungtizenos.com/tools-download/
[extend-hub]: https://samsungtizenos.com/knowledge-hub/extending-tizen-certificate-duration-tv-app-10100
[mkt-tizen]: https://marketplace.visualstudio.com/items?itemName=tizen.vscode-tizen-csharp
[mkt-tv]: https://marketplace.visualstudio.com/items?itemName=samsungtvsdk.tv-vscode-tizen
[watchfaq]: https://developer.samsung.com/galaxy-watch-tizen/getting-certificates/faq.html
[watchextend]: https://developer.samsung.com/galaxy-watch-tizen/getting-certificates/extend.html
[avplay]: https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html
[videoel]: https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-video-elements.html
[mmfaq]: https://developer.samsung.com/smarttv/develop/faq/multimedia.html
[remote]: https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html
[tvinput]: https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/tvinputdevice-api.html
[config]: https://developer.samsung.com/smarttv/develop/guides/fundamentals/configuring-tv-applications.html
[netfaq]: https://developer.samsung.com/smarttv/develop/faq/networking-and-connectivity.html
[hostedfaq]: https://developer.samsung.com/smarttv/develop/faq/hosted-applications.html
[jf-readme]: https://github.com/jellyfin/jellyfin-tizen
[jf-config]: https://github.com/jellyfin/jellyfin-tizen/blob/master/config.xml
[jf-gulp]: https://github.com/jellyfin/jellyfin-tizen/blob/master/gulpfile.babel.js
[jf-tizenjs]: https://github.com/jellyfin/jellyfin-tizen/blob/master/tizen.js
[jf-bdp]: https://github.com/jellyfin/jellyfin-web/blob/a510fba5a54d8d899b17f445121e6277511c2e0c/src/scripts/browserDeviceProfile.js
[jf-hls]: https://github.com/jellyfin/jellyfin-web/blob/master/src/components/htmlMediaHelper.js
[jf-gone]: https://forum.jellyfin.org/t-solved-jellyfin-app-disappeared-after-tizen-update-samsung-tv

- Samsung: [TV Model Groups][groups] · [General Specifications][general] · [Web Engine Specifications][engine] · [2026 TV Video Specifications][v2026] · [Installing TV SDK][install] · [Creating Certificates][certs] · [Using a TV device][tvdevice] · [VS Code extension][vscode] · [Remote Control][remote] · [TVInputDevice API][tvinput] · [AVPlay][avplay] · [Video element][videoel] · [Multimedia Q&A][mmfaq] · [Configuring Web Applications][config] · [Networking Q&A][netfaq] · [Hosted Applications Q&A][hostedfaq] · [Watch certificate FAQ][watchfaq] · [Watch: extending certificates][watchextend]
- Samsung Tizen site: [Tools download][tools] · [Extending certificate duration][extend-hub] (AI-generated page)
- VS Code Marketplace: [tizen.vscode-tizen-csharp][mkt-tizen] · [samsungtvsdk.tv-vscode-tizen][mkt-tv] · [Samsung/vscode-extension-tizentv][vscode-gh]
- Jellyfin: [jellyfin-tizen README][jf-readme] · [config.xml][jf-config] · [gulpfile.babel.js][jf-gulp] · [tizen.js][jf-tizenjs] · [browserDeviceProfile.js @ a510fba][jf-bdp] · [htmlMediaHelper.js][jf-hls]
- Community (not primary; flagged where used): [Jellyfin forum: app disappeared after Tizen update][jf-gone]
