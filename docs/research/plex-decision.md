# Research: how Plex picks direct play, remux or transcode for Samsung TVs

Research note, 2026-10-13, for #45 (map #43). Question: how does Plex Media Server decide, per file, whether a Samsung Tizen client gets the file as-is, a remux, or a transcode? And what should the TV Server copy? Every claim cites a source URL, a file in the Plex bundle, or a command run against the local Plex Media Server 1.41.5 (`http://127.0.0.1:32400`, sample library section 3 "Tuva Sample", 40 items; see `docs/research/plex-sample.md` on branch `task/plex-sample`). Tokens are shown as `<redacted>`. No Plex settings, libraries or library files were changed.

## Answer (TL;DR)

- **Mechanism.** Plex decides **per request**. The client sends headers that name a **client profile**: an XML capability list bundled with the server. The client can also send `X-Plex-Client-Profile-Extra` directives that amend that profile. The decision endpoint then matches the file's scan-time stream metadata against the profile, rule by rule. It returns one decision per stream (`directplay`, `copy` or `transcode`) and a reason string naming the first rule that failed (§1, §2).
- **Plex's bundled "Samsung Tizen" profile is stale and very conservative.** Direct play covers H.264 (and MPEG-4 Part 2) only. mkv audio has no Opus and no E-AC3. There is no VP9, AV1 or HEVC, and no resolution, bitrate, level or bit-depth limits (§1).
- **Impersonation worked** with `X-Plex-Client-Profile-Name: Samsung Tizen`. Platform headers alone (`X-Plex-Platform=Tizen`, `X-Plex-Device=Samsung TV`) matched no profile (§2).
- **With the bundled profile**, 8 of 40 sample items direct-play. 5 are remuxed with video `copy` and Opus→AAC. **27 get a full video transcode**: every VP9 and AV1 file (§3).
- **Adding Samsung's literal 2026 table** with Profile-Extra brings direct play to 18/40. **Adding Jellyfin's Tizen rules** brings it to 40/40. The bundled profile is therefore not evidence about what the R85H can decode. It disagrees with both Samsung's table and Jellyfin on VP9, AV1, Opus and E-AC3 (§4).
- **What to copy:** Plex's *shape*, not its Samsung data. That means a declarative capability profile (container → video codecs × audio codecs, plus upper-bound limitations), a pure per-file decision that returns per-stream `directplay | copy | transcode` with a reason, and the decision made **at scan time** for TuvaVideos's single TV, behind a function that could run per request later (§5).

## 1. Plex's bundled Samsung/Tizen profiles

Profiles live in `~/Applications/Plex Media Server.app/Contents/Resources/Profiles/*.xml` (78 files). Three are Samsung profiles; command: `find "…/Contents/Resources" -path '*Profiles*' -name '*.xml'`.

**`Profiles/Samsung Tizen.xml`** ("Author: Plex Inc."):
- **Direct play** (`DirectPlayProfiles`):
  - `mp4`: video h264, mpeg4; audio aac, ac3, mp3, pcm.
  - `mkv`: video h264, mpeg4, mjpeg, mpeg2video, vc1; audio mp2, mp3, ac3, dca, aac, pcm, vorbis. **No opus, no eac3, no hevc, vp9 or av1.**
  - `mpegts`: video h264, mpeg2video, vc1; audio mp2, mp3, ac3, dca, pcm.
  - Also asf (wmv3, vc1), avi, mpeg, flv and 3gpp, all H.264 or older.
  - Subtitles: srt, smi.
- **Transcode target**: `protocol="hls" container="mpegts" codec="h264" audioCodec="aac,mp2,mp3,ac3,eac3" context="streaming"`, with settings `BreakNonKeyframes` and `IncludeMapInEmptyVTT`.
- **Limits** (`CodecProfiles`): only `audio.channels ≤ 6` for ac3/wmav2/dca/aac/mp3, and ≤ 2 for music AAC. **No width, height, frame rate, bitrate, level or bit-depth bound.**

**`Profiles/Samsung.xml`** ("Author: Plex Inc."; an older generic Samsung profile):
- Like Tizen, but `mkv` adds **hevc** video and **eac3** audio. mp4, avi, mpeg, flv and mpegts also take eac3.
- Transcode target: HLS mpegts h264 + **ac3**, with x264 opts `ref=4:bframes=2:cabac=1`.
- Same 6-channel audio cap.

**`Profiles/Samsung SmartTV.xml`** ("Author: holzi"; legacy, identified by DLNA `ModelUrl` substring `samsung.com`):
- Direct play h264/mpeg4/mjpeg in mkv/mp4/avi/asf, with mkv audio mp3, ac3, dca, aac.
- Hard limits for h264: `video.width ≤ 1920` and `video.height ≤ 1080` (both `isRequired`), `frameRate ≤ 30`, `bitrate ≤ 37500` kbps and `level ≤ 41`. mpeg2video is capped at 30720 kbps, mpeg4 at 8192 and VC-1 at 25600.
- Transcode target: mpegts h264 + aac/mp3/ac3.

**For comparison** (same folder):
- `HTML TV App.xml` caps every video codec at 1920×1080 (`isRequired`) and `video.bitDepth ≤ 8`. Its targets are HLS mpegts, DASH mp4 and HTTP mkv, all h264+aac.
- `Universal TV.xml` direct-plays only mp4 h264 + aac/ac3. It requires `part.optimizedForStreaming=1` and limits h264 to 8-bit, ≤ 30 fps, level ≤ 40 and ≤ 5 ref frames.

**Profile-Extra grammar**, from the server binary. Command: `strings -n 5 "…/Contents/MacOS/Plex Media Server" | grep -i ClientProfileExtra`.
- Directives include `add-direct-play-profile`, `add-transcode-target`, `add-transcode-target-codec`, `append-transcode-target-codec`, `add-transcode-target-audio-codec`, `add-transcode-target-settings` and `add-limitation`. They are joined with `+`.
- Parameters are query strings, for example `type=videoProfile&container=…&videoCodec=…&audioCodec=…`, or `scope=videoCodec&scopeName=…&type=upperBound&name=video.height&value=…`.
- The binary embeds one Plex-built example: `add-transcode-target-audio-codec(type=videoProfile&context=streaming&protocol=hls&audioCodec=%s)+add-limitation(scope=videoAudioCodec&scopeName=%s&type=upperBound&name=audio.channels&value=6&onlyTranscodes=true&replace=true)`.
- Log strings `TranscodeUniversalRequest: using profile %s` / `using augmented profile %s` and `Unable to find client profile for device; platform=%s, platformVersion=%s, device=%s, model=%s` show that the profile is resolved on every request.

Plex's own definitions:
- **Direct Play** sends the file unchanged.
- **Direct Stream** repackages the video and audio into a compatible container on the fly, without re-encoding the video.
- A **"Partially-Transcoded Direct Stream"** transcodes only the audio.
- Source: [Plex support: Direct Play and Direct Stream](https://support.plex.tv/articles/200250387-streaming-media-direct-play-and-direct-stream/).

## 2. Impersonating the Samsung Tizen client

**Probe.** Each probe is a GET with `Accept: application/json`:

```
GET http://127.0.0.1:32400/video/:/transcode/universal/decision
    ?path=/library/metadata/<ratingKey>&protocol=hls&directPlay=1&directStream=1
    &mediaIndex=0&partIndex=0&session=tuva45-<ratingKey>&X-Plex-Token=<redacted>
    [&X-Plex-Client-Profile-Extra=<directives>]
headers: X-Plex-Client-Identifier: tuva-research-45, X-Plex-Product: Plex for Samsung,
         X-Plex-Platform: Tizen, X-Plex-Platform-Version: 10.0, X-Plex-Device: Samsung TV,
         X-Plex-Model: MRN85R85HAFXZA, X-Plex-Version: 5.0
         [X-Plex-Client-Profile-Name: Samsung Tizen]
```

**Results.** Each was checked with `grep -a 'using (augmented )?profile|Unable to find client profile' ~/Library/Logs/Plex Media Server/Plex Media Server.log`:
1. **Headers only:** HTTP 400. The log shows `Unable to find client profile for device; platform=Tizen, platformVersion=10.0, device=Samsung TV, model=MRN85R85HAFXZA` and `TranscodeUniversalRequest: unable to find a matching profile`. The platform headers do not select the Tizen XML.
2. **`X-Plex-Client-Profile-Name: Samsung Tizen`:** HTTP 200. The log shows `TranscodeUniversalRequest: using profile Samsung Tizen`. **Impersonation took.**
3. **Name plus `X-Plex-Client-Profile-Extra`:** the log shows `using augmented profile Samsung Tizen`. The extras are applied.

**Unverified:** which name or extras the real *Plex for Samsung* app sends. It probably augments the bundled profile with Profile-Extra, given that the mechanism exists. Capturing the app's headers would need the app on the TV. **[unverified]**

## 3. Per-file decisions (40 sample items)

**Four passes** were run with the same probe:
- **A** is the bundled `Samsung Tizen` profile.
- **S** is A plus a Profile-Extra modelling Samsung's literal 2026 shared row:
  `add-direct-play-profile(type=videoProfile&container=mkv&videoCodec=h264,hevc,av1&audioCodec=aac,ac3,eac3,opus,mp3)+add-direct-play-profile(type=videoProfile&container=mp4&videoCodec=h264,hevc,av1&audioCodec=aac,ac3,eac3,opus,mp3)`.
  The WebM row (VP9+Vorbis) cannot be expressed, because Plex reports webm as `mkv` (plex-sample.md).
- **J** is A plus Jellyfin's Tizen rules: mkv h264/hevc/vp9/av1 + aac/ac3/eac3/opus/vorbis/mp3; mp4 h264/hevc/vp9/av1 + aac/ac3/eac3/mp3 (no opus).
- **C** is J plus `add-limitation(scope=videoCodec&scopeName=*&type=upperBound&name=video.height&value=1080&isRequired=true)+add-limitation(scope=videoCodec&scopeName=*&type=upperBound&name=video.bitDepth&value=8)`. It shows how the limit rules report.

**Reading the codes:**
- `DP` means `partDecision=directplay` (general code 1000, "Direct play OK.").
- Otherwise the cell shows the per-stream decisions. `partDecision=transcode`, general code 1001 "Direct play not available; Conversion OK.", direct-play code 3000. The output is HLS `mpegts`.
- A **remux shows as video `copy`**. Plex never returned a separate "directstream" part decision.

**The reasons Plex gave** (the `directPlayDecisionText`):
- **R1:** "App cannot direct play this item. No direct play video profile exists for protocol http, with container mkv, and video codec vp9." The av1 and mp4 variants are worded the same way.
- **R2:** "… with container mkv, video codec h264, and audio codec opus."
- **R3:** "This app cannot play this item. The reason is: video.height limitation applies: 2160 > 1080." Or "video.bitDepth limitation applies: 10 > 8."

| ratingKey | tag (file) | source: Plex container / video / audio / res | A: bundled Tizen | S: + Samsung table | J: + Jellyfin rules | C: J + ≤1080 h, 8-bit |
|---|---|---|---|---|---|---|
| 694 | 4k mp4 | mp4 vp9 aac 3840×2026 | v transcode, a copy (R1) | same (R1) | DP | v transcode, a copy (R3 height) |
| 695 | 4k mkv | mkv vp9 opus 2160p60 | v+a transcode (R1) | same | DP | v+a transcode (R3) |
| 696 | 4k mkv | mkv av1 opus 2160 | v+a transcode (R1 av1) | DP | DP | v+a transcode (R3) |
| 697 | 4k webm | mkv vp9 opus 2160p60 | v+a transcode (R1) | same | DP | v+a transcode (R3) |
| 698 | 4k mkv | mkv vp9 opus 2160 | v+a transcode (R1) | same | DP | v+a transcode (R3) |
| 699 | 60fps-h264-mkv | mkv h264 aac 540p60 | DP | DP | DP | DP |
| 700 | av1-webm | mkv av1 opus 1080p | v+a transcode (R1 av1) | DP | DP | DP |
| 701 | av1-webm | mkv av1 opus 2160 | v+a transcode (R1 av1) | DP | DP | v+a transcode (R3) |
| 702, 703 | av1-webm (portrait) | mkv av1 opus 1080×1920 | v+a transcode (R1 av1) | DP | DP | v+a transcode (R3 "1920 > 1080") |
| 704 | fullrange-h264-mkv (portrait) | mkv h264 aac 720×1280 | DP | DP | DP | v transcode, a copy (R3 "1280 > 1080") |
| 705–708 | h264-aac-mp4 | mp4 h264 aac ≤1080 | DP | DP | DP | DP |
| 709, 710 | h264-opus-mkv | mkv h264 opus 1080 | **v copy**, a transcode (R2) | DP | DP | DP |
| 711 | hdr10bit-mkv | mkv vp9 p2 opus 1080 | v+a transcode (R1) | same | DP | v+a transcode (R3 "bitDepth 10 > 8") |
| 712 | hdr10bit-mp4 | mp4 vp9 p2 aac 1080 | v transcode, a copy (R1) | same | DP | v transcode, a copy (R3 bitDepth) |
| 713 | hdr10bit-webm | mkv vp9 p2 opus 1080 | v+a transcode (R1) | same | DP | v+a transcode (R3 bitDepth) |
| 714–716 | long-concert | mkv h264 opus ≤1080 | **v copy**, a transcode (R2) | DP | DP | DP |
| 717 | oddres-h264-mp4 | mp4 h264 aac 1166×720 | DP | DP | DP | DP |
| 718–720 | partial `.f303.webm` (video only) | mkv vp9 — 1080p60 | v transcode (R1) | same | DP | DP |
| 721 | partial `.f251.webm` (audio only) | mkv — opus | DP | DP | DP | DP |
| 722 | vfr-vp9-mkv | mkv vp9 opus 1080 | v+a transcode (R1) | same | DP | DP |
| 723 | vp9-eac3-mkv | mkv vp9 eac3 1080 | v transcode, **a copy** (R1) | same | DP | DP |
| 724, 725 | vp9-mkv | mkv vp9 opus ≤1080 | v+a transcode (R1) | same | DP | DP |
| 726 | vp9-mkv | mkv vp9 aac 480×360 | v transcode, a copy (R1) | same | DP | DP |
| 727–729 | vp9-mp4 | mp4 vp9 aac ≤1080 wide | v transcode, a copy (R1 mp4) | same | DP | DP |
| 730 | vp9-mp4 (portrait) | mp4 vp9 aac 720×1280 | v transcode, a copy (R1 mp4) | same | DP | v transcode, a copy (R3 "1280 > 1080") |
| 731, 732 | webm-opus 4K | mkv vp9 opus 2160 | v+a transcode (R1) | same | DP | v+a transcode (R3) |
| 733 | webm-opus 1080 | mkv vp9 opus 1080p60 | v+a transcode (R1) | same | DP | DP |

**Totals:**

| Pass | Direct play | v copy + a transcode | Video transcode |
|---|---|---|---|
| A | 8 | 5 | 27 |
| S | 18 | 0 | 22 (all VP9) |
| J | 40 | 0 | 0 |
| C | 25 | 0 | 15 |

**What the transcode output looks like.** These details come from the same probe on 695, 711, 709 and 723, reading `Media` and the video `Stream`:
- **Resolution is kept.** 4K VP9 becomes 3840×2160 h264 8-bit (`videoResolution=4K`). The profile has no resolution cap.
- **HDR is dropped.** The VP9 Profile 2 file 711 becomes h264 `bitDepth=8` with no `colorTrc`.
- **Remuxes keep the source bitrate.** On a remux (709) the video keeps its source bitrate (2525 kbps, `profile=high`). Video-transcode streams report `bitrate=2147483647`, which means no bitrate cap was requested.
- **E-AC3 is copied** into the HLS target (723), because the transcode target lists `eac3`, although the mkv direct-play rule does not.
- **No codec check on the transcode side.** Every request reported "Conversion OK". Plex did not check transcoder speed. Decoding AV1 or 4K VP9 in software on the M1 (no AV1 hardware decode; `docs/research-samsung-tv-streaming.md` §2) would be the real cost **[not measured]**.

**Oddities:**
- **721 (audio-only Opus) direct-plays even under A**, although no mkv rule lists opus. Plex appears to skip the video-profile match when there is no video stream **[observed, mechanism unverified]**.
- **The height limit is literal.** Portrait 1080×1920 and 720×1280 files fail a `video.height ≤ 1080` cap (R3 "1920 > 1080") even though they have fewer pixels than 1080p.

## 4. Plex vs Samsung's 2026 table vs Jellyfin's Tizen profile

Samsung's 2026 table and Jellyfin's Tizen profile are as summarized in `docs/research/tizen-2026-r85h.md` §7 (branch `research/tizen-2026`):
- **Samsung's 2026 table** ([2026 TV Video Specifications](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2026-tv-video-specifications.html)):
  - The shared mkv/mp4/ts row lists H.264, HEVC Main10 and AV1, with AAC, AC3, DD+ and Opus audio.
  - The WebM row lists VP9 Profile 0/2 and AV1, with Vorbis audio only.
  - MSE is FHD-only.
- **Jellyfin's Tizen profile** ([browserDeviceProfile.js @ a510fba](https://github.com/jellyfin/jellyfin-web/blob/a510fba5a54d8d899b17f445121e6277511c2e0c/src/scripts/browserDeviceProfile.js)):
  - mkv allows h264, hevc, vp9 and av1, with aac, ac3, eac3, opus and vorbis.
  - webm allows vp9 and av1, with vorbis and opus.
  - mp4 allows vp9 and av1 but not opus.
  - It has no width cap on UHD sets.

| Case | Plex bundled Tizen (pass A) | Samsung 2026 table | Jellyfin Tizen | Disagreement |
|---|---|---|---|---|
| **mkv + VP9** (695, 698, 722, 724–726) | video transcode (R1) | not on the MKV row | direct play | Plex and Samsung's literal table agree on "no"; Jellyfin says yes. Only a TV test settles it (#48). |
| **webm + Opus** (697, 713, 731–733) | video transcode (VP9) and Opus→AAC | VP9 yes, Opus not on the WebM row | direct play | Plex can't tell webm from mkv, so it judges these as mkv. Under the mkv rules Samsung lists Opus but not VP9. |
| **mp4 + VP9** (694, 712, 727–730) | video transcode, AAC copy | not on the MP4 row | direct play | Same split as mkv+VP9. |
| **AV1** (696, 700–703) | video transcode | listed (mkv/mp4/webm, 4K120, 40 Mbps) | direct play | **Plex's profile is out of date.** Samsung and Jellyfin agree. Transcoding AV1 on an M1 is software decode. |
| **Opus in mkv** (709, 710, 714–716) | v copy, Opus→AAC | listed | direct play | Plex is stale. These 5 are the only remuxes Plex picks. |
| **E-AC3** (723) | not in mkv direct play, but copied in HLS | DD+ listed | direct play | Plex is internally inconsistent: E-AC3 is safe for its own HLS output but not for direct play. `Samsung.xml` (older) does list eac3 in mkv. |
| **HDR / 10-bit** (711–713) | transcode because of VP9; output is 8-bit h264, HDR dropped | VP9 Profile 2 and HEVC Main10 listed | treated as HDR10/HLG-capable | Plex's Tizen profile has no bitDepth rule. HDR is lost only as a side effect of transcoding VP9. `HTML TV App.xml` and `Universal TV.xml` cap at 8-bit. |
| **4K** (694–698, 701, 731, 732) | no resolution cap; transcode keeps 2160p | 4K for H.264, HEVC, VP9 and AV1; MSE FHD only | no width cap on UHD | Plex Tizen adds no cap. The legacy `Samsung SmartTV.xml` caps at 1080p30. A 4K HLS transcode played through MSE (hls.js) would be capped at FHD by Samsung; how Plex's own app plays HLS is **[unverified]**. |
| **Partials** (718–721) | video-only VP9 transcodes; audio-only Opus direct-plays | n/a | n/a | They are not Copies in library.db (plex-sample.md), so the TV Server never serves them. Plex indexing them is a Plex quirk. |
| **60 fps h264 / odd res** (699, 705–708, 717) | direct play | listed (H.264 4K60) | direct play | All agree. The legacy SmartTV 30 fps cap no longer applies. |

**Net result:**
- Plex's bundled profile is the least capable of the three sources. It is not evidence about what the R85H can decode.
- The real disagreement between Samsung and Jellyfin is VP9 outside WebM (mkv, mp4) and Opus inside WebM. Plex can't express the WebM half anyway.

## 5. What a TV Server should copy

**1. A capability profile as data, separate from the decision logic** (`Profiles/*.xml`; Profile-Extra grammar in §1). It has three parts:
- **Direct-play rules:** container → allowed video codecs × allowed audio codecs.
- **Limitations:** per codec, upper bounds on width, height, bitDepth, frameRate, level, bitrate and audio channels. Each is either `isRequired` or advisory.
- **Transcode targets** (the protocol, container and codecs to convert *to*).

For TuvaVideos, adapt it in three ways:
- **Key containers by file extension**, not by probe container name, because Plex/ffmpeg report webm as mkv (plex-sample.md). Otherwise Samsung's WebM row can't be expressed.
- **Start from Jellyfin's Tizen rules** (pass J), with mkv+VP9, mp4+VP9 and webm+Opus marked "verify on TV" until #48 confirms them. Don't use Plex's Samsung data.
- **Bound pixels or the long edge, not literal height**, so portrait Copies aren't mis-flagged (§3 oddities).

**2. A per-file decision shaped like Plex's output** (§3):
- Return one decision per stream: video `directplay | copy | transcode`, audio `directplay | copy | transcode`.
- Return a reason naming the first failing rule, for example "no direct-play rule for mkv + vp9" or "video.bitDepth 10 > 8".
- This maps directly onto the existing Fallback (`CONTEXT.md`: "cached remux or audio transcode"):
  - all direct play → `/copy/:id`
  - video `copy` → `-c copy` remux Fallback
  - audio `transcode` → audio Fallback
  - video `transcode` → not supported (no Copy needs it under pass J)

**3. When to decide: scan time for TuvaVideos.** Plex decides per request, because it serves many client types whose profiles arrive as request headers (§2 log lines). Its stream facts (codec, profile, bitDepth, resolution) are already gathered at scan time (`/library/metadata/<ratingKey>`, plex-sample.md). The TV Server has one known TV, so scan time fits better:
- **Compute at scan time.** Store the TV decision per Copy next to the browser one. Build any Fallback then, as the browser path already does.
- **Keep it pure.** Write the decision as a function `(streamFacts, profile) → decision`, so it can also run per request if a second device or a bandwidth cap appears.
- **Version the profile.** Re-run the decision when the profile changes, for example after #48 flips a "verify" rule.

## Sources

- Plex bundle (Plex Media Server 1.41.5): `~/Applications/Plex Media Server.app/Contents/Resources/Profiles/Samsung Tizen.xml`, `Samsung.xml`, `Samsung SmartTV.xml`, `HTML TV App.xml`, `Universal TV.xml`, `sugar.cmake` (profile list); `Contents/MacOS/Plex Media Server` (strings).
- Plex log: `~/Library/Logs/Plex Media Server/Plex Media Server.log` (profile-resolution lines, 2026-10-13).
- Commands: the decision probe in §2 (token redacted), run for all 40 ratingKeys in section 3 under passes A, S, J and C.
- [Plex support: Direct Play and Direct Stream](https://support.plex.tv/articles/200250387-streaming-media-direct-play-and-direct-stream/)
- [Samsung: 2026 TV Video Specifications](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2026-tv-video-specifications.html)
- [jellyfin-web browserDeviceProfile.js @ a510fba](https://github.com/jellyfin/jellyfin-web/blob/a510fba5a54d8d899b17f445121e6277511c2e0c/src/scripts/browserDeviceProfile.js)
- Repo: `docs/research/tizen-2026-r85h.md` (branch `research/tizen-2026`), `docs/research/plex-sample.md` (branch `task/plex-sample`), `docs/research-samsung-tv-streaming.md` (untracked, main checkout), `CONTEXT.md`.
