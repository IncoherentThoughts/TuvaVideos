# How Language Reactor plays local video files

Research for issue #2 (part of map #1). Investigated 2026-10-10.

## Answer

Language Reactor plays a local mkv or mp4 with **the browser's own `<video>` element, fed a `blob:` URL made from the picked `File`**. There is no WASM video decoder and no MediaSource pipeline. The player lives on the website (`https://www.languagereactor.com/video-file`), not in the extension. Separately, the site uses **Mediabunny**, a pure TypeScript demuxer and muxer, to *inspect* the file: it lists tracks, extracts embedded subtitles, and pulls audio for ASR. Mediabunny is not in the playback path. Seeking means setting `video.currentTime`. Subtitles are parsed into a cue array and drawn by Language Reactor's own overlay, not attached as a `<track>`.

So the "fast and light" behaviour is simply Chromium's native demuxer and decoders reading a local file at random. A localhost server can match it, as long as it serves the file with HTTP Range support.

## Evidence

### 1. The extension contains no player

Extension source: `~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Extensions/hoombieeljmmljlkjmnheibnpciblicm/5.1.8_0/`, version 5.1.8.

- `manifest.json`: content scripts match only Netflix, YouTube, Amazon and `https://*.languagereactor.com/*`. It has no `file://` matches and declares no wasm resources. The permissions are `storage, contextMenus, activeTab, scripting`.
- `content_dioco.js` (the languagereactor.com content script) only injects `pageScript_dioco.min.js` and relays `LR_BG_*` / `LR_PS_*` RPC messages between the page and the background worker. `pageScript_dioco.min.js` is one statement: `window.__LANGUAGE_REACTOR_EXTENSION__=!0`, a flag the website reads to know the extension is installed.
- A grep of every `*.js` found no hits for `WebAssembly` (other than a node-util type check), `.wasm` (only as part of `wasMultiple`), `ffmpeg`, `demux`, `MediaSource`, `matroska` or `mkv`. The only `type="file"` input is `#lln-custom-subs-file-input` with `accept=".srt,.vtt,.ass,.ssa,.sub"`, which uploads subtitles for Netflix and YouTube.
- The `vfp_*` ("video file player") UI strings ship inside the extension bundles (`content_dictionary.js`, `pageScript_ll*.min.js`) because the string table is shared with the website. Two of them give the game away:
  - `vfp_hevcWarning`: "This video uses HEVC/H.265 encoding which may not play in your browser. Try using Safari…". That only makes sense if the browser does the decoding.
  - `videoFileIntro_GT`: "this feature only works with video formats that your browser supports."
  - `vfp_errorCouldNotAnalyzeMedia`: "Embedded subtitles, audio track selection, and ASR are unavailable. You can still play with external subtitles." Analysis can fail while playback still works, so the two paths are separate.

### 2. The website's player: a File, then a blob URL, then a native `<video>`

Source: the site's production bundles, fetched 2026-10-10 and read but not executed: `https://www.languagereactor.com/assets/index-B2o7oYbu.js` and `https://www.languagereactor.com/assets/VideoPlayer-DL7yx2bZ.js`.

- `VideoFileStore.selectVideoFile(t)` runs `r=URL.createObjectURL(t)` and stores `videoFile_loader:{state:"LOADED",data:{file:t,url:r,filename:t.name}}`. It then calls `__analyzeMedia(t)`. Later the media doc is built with `videoURL_loader:{state:"LOADED",data:{url:a.url,...}}`, so the blob URL is the video source. `__cleanupUrls()` revokes the `blob:` URLs on reset.
- `VideoPlayer` renders `jsx("video",{id:"plyr_video",src:e.src,autoPlay:!0,preload:"auto",playsInline:!0,controls:!0,...})`, or an `<audio>` for audio-only files, and wraps it in **Plyr** (a UI skin, `new ee(t.current,{...})`). Plyr only feature-detects with `canPlayType`; the decoding is native.
- **Seeking**: the player's imperative handle is `seek:g=>{t.current.currentTime=g/1e3}` and `getTime_ms:()=>t.current.currentTime*1e3`. `PlaybackManager` builds subtitle jumps, relative seeks (`doRelativeSeek`) and auto-pause on top of that handle. For a blob URL, Chromium seeks by random access into the `File`, which costs nothing.

### 3. Mediabunny handles analysis and extraction, not playback

- The main bundle includes Mediabunny. It contains the strings "Mediabunny Codec Registry", `Ur.encode("Mediabunny")`, and a Matroska input class with `_canReadInput(e){return this.isSupportedEBMLOfDocType(e,"matroska")}`. Its subtitle codec list is `["webvtt","srt","ass","ssa","tx3g","vobsub","pgs"]`.
- The `MediaExtractor` class (`Ys`) uses it for `analyzeMedia` (tracks, codecs, `hasAC3Audio`, `isHEVC`), `extractSubtitle`, `extractAudioTrack`/`extractTrack` (packet copy or conversion, with a 2 GB cap for ASR), `extractVideoFrame` and `extractThumbnails`. It reads the File through a stream source (`createStreamSource`), not by loading it into memory.
- The extracted audio goes to `extractedAudioUrl`, which is used for ASR and "save to library". It is never handed to the `<video>`. The VideoPlayer chunk does support a `VIDEO_MUTED` mode, a muted video presumably paired with separate audio, but the current main bundle never selects it.
- An Aug 17, 2025 team post says AC3/EAC3 "audio is transcoded" and that non-default audio tracks can be selected ([forum: Video File Player Upgrades](https://forum.languagelearningwithnetflix.com/t/video-file-player-upgrades/33150)). In the current bundle, AC3 detection and the `vfp_ac3Warning` string exist, but I could not trace a transcoded track being fed back to the player. Treat that path as unverified.
- The only WASM on the site is onnxruntime-web for Silero VAD, loaded from jsDelivr (`@ricky0123/vad-web`, `silero_vad_legacy.onnx`). It does voice-activity detection for ASR and subtitle sync, not video.

### 4. Subtitles go to an overlay, not a `<track>`

- Four sources feed `__setSubs()`: an external file (`.srt,.vtt,.ass,.ssa`) parsed in JS, an embedded track (Mediabunny `extractSubtitle`), OpenSubtitles search, or server ASR.
- The result is a cue array (`{begin,end,...}` in ms). The NLP and translation pipeline consumes it, and Language Reactor's own subtitle UI renders it, driven by `PlaybackManager.onProgress`. The site never calls `addTextTrack` and never creates a `<track>`. Plyr's `<track>` code is library code that goes unused.
- Timing offsets are applied by rewriting cue times (`begin*t+n`). `__autoSyncSubtitles()` estimates the offset from the selected audio track, using VAD.
- The team post confirms embedded SRT and ASS support ([forum](https://forum.languagelearningwithnetflix.com/t/video-file-player-upgrades/33150)). Only one external subtitle file can be loaded at a time ([forum, 2023-09-26](https://forum.languagelearningwithnetflix.com/t/add-subtitles-to-video/9019)). The video itself is read locally through the blob URL. Subtitle cues are sent to Language Reactor's servers for NLP and translation (`a2({type:"SUBS",subs:t},n)`), and so is extracted audio when ASR is used.

## What this means for TuvaVideos

1. **Use the native `<video>` element; no decoder is needed.** The speed comes from Chromium's own Matroska/MP4 demuxer and its hardware decoders, which Language Reactor uses unchanged. The Player can be a plain `<video src="http://localhost:…/copies/<id>">`.
2. **The server must support HTTP Range.** A blob URL gives Chromium free random access. Over HTTP, the server has to answer `Range: bytes=` with `206 Partial Content`, `Accept-Ranges: bytes` and the correct `Content-Length` and `Content-Type` (for example `video/x-matroska`, `video/mp4`). Without that, seeking and resume positions break or force a full download. No transcoding or remuxing is needed for files Chromium can decode.
3. **The codec limits are the same as Language Reactor's.** HEVC, AC3/EAC3, DTS and AVI will play badly or not at all in Chromium. Language Reactor only warns about these. If the library contains such Copies, the server would need to remux or transcode them (for example with ffmpeg), but the default can be direct serving. The library scan could flag such codecs with ffprobe, the server-side counterpart of Mediabunny's `analyzeMedia`.
4. **Seeking**: set `video.currentTime`. Chapter jumps and Resume position are both just `currentTime` writes; the mpv-style key bindings map onto `currentTime` and `playbackRate`.
5. **Subtitles and lyrics**: either draw our own overlay from a cue array, as Language Reactor does (best for lyric styling and clicks), or serve WebVTT and use a native `<track>`. Native video does not expose embedded mkv subtitle tracks, so they would have to be extracted server-side (ffmpeg) or client-side (Mediabunny).
6. **Thumbnails**: Language Reactor grabs frames client-side (`extractVideoFrame`). We already plan cached Thumbnails, generated server-side, which works even when a Copy is unavailable.

## Sources

- Extension 5.1.8 files: `manifest.json`, `content_dioco.js`, `pageScript_dioco.min.js`, `pageScript_lly.min.js`, `pageScript_lln.min.js`, `pageScript_lla.min.js`, `content_dictionary.js`, `side_panel.js` (local Brave profile path above).
- `https://www.languagereactor.com/video-file`: the SPA shell, which loads `/assets/index-B2o7oYbu.js`.
- `https://www.languagereactor.com/assets/index-B2o7oYbu.js`: `VideoFileStore`, `MediaExtractor` (Mediabunny), `PlaybackManager`.
- `https://www.languagereactor.com/assets/VideoPlayer-DL7yx2bZ.js`: the `<video id="plyr_video">` element, the Plyr wrapper and the seek handle.
- Forum, team post, 2025-08-17: https://forum.languagelearningwithnetflix.com/t/video-file-player-upgrades/33150
- Forum, "add subtitles to video" (one subtitle file at a time): https://forum.languagelearningwithnetflix.com/t/add-subtitles-to-video/9019

Bundle hashes change on each deploy, so the asset filenames above are a snapshot from 2026-10-10.
