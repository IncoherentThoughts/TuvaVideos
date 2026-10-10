# Chromium playback of the library's mkv/webm/mp4 over localhost

Resolves [#3](https://github.com/IncoherentThoughts/TuvaVideos/issues/3) (part of map #1). Researched 2026-10-10.

## Answer

**Serve every file as-is from a Range-capable localhost HTTP server and point a plain `<video src>` at it.** Every container/codec combination in the library played natively in Chromium 152, including Matroska with H.264, VP9, AAC and Opus. That covers 1,136 of the 1,137 media files. No remux is needed for playback.

- **MIME type doesn't matter.** For `src=` playback, Chromium sniffs the container with its bundled FFmpeg and ignores the `Content-Type` header. Send `video/webm` for .webm, `video/mp4` for .mp4 and `video/x-matroska` for .mkv anyway, for tidiness.
- **Range is mandatory, and it's sufficient.** With `Accept-Ranges: bytes` and 206 responses, seeking is effectively instant (16–175 ms median) in non-fragmented files, including a 735 MB, 80-minute mkv. Without Range, `seekable` is empty and seeks silently snap back near 0.
- **Keyframe interval sets scrub cost.** The cost scales with GOP length × decode cost. It is ~20 ms at a 1 s GOP and ~60 ms at a 5 s GOP for 720p H.264, and ~170 ms at a 5 s GOP for 1080p VP9. All are acceptable. No re-encode is warranted.
- **Two small categories need a fallback.** The fallback for both is ffmpeg, but neither is a pure on-the-fly `-c copy` remux:
  1. **E-AC3 audio (1 file).** Video plays but the audio is **silently** not decoded: no `error` event, and `webkitAudioDecodedByteCount` stays 0. The fix is to copy the video and transcode the audio to AAC. That runs at ~19× realtime and is streamable.
  2. **yt-dlp unmerged `.fNNN.webm` partials (8 files; 7 video-only, 1 audio-only).** Most lack Cues, so `duration` is `Infinity` and you can seek only within the buffered range. The fix is a one-time `ffmpeg -c copy -cues_to_front 1` into an app cache file, which took 0.66 s for 30 MB. The original file is left untouched. The scanner should also pair `.f303` with `.f251` siblings, or flag them.
- **mpv-over-JSON-IPC is not needed.** Native playback fails for less than 0.1% of files, so it doesn't justify the architecture (see the end of this document).

## Library census

ffprobe was run over every `.mkv/.mp4/.webm` under both roots: 1,166 paths. 29 of them are macOS AppleDouble `._*` sidecar files, which are not media; **the scanner must skip `._*`**. Structural checks came from a byte scan: the mp4 top-level atom order, and Matroska Cues (`0x1C53BB6B`) at the head or tail.

| Container | Video | Audio | Files | Structure notes |
|---|---|---|---|---|
| webm | VP9 Profile 0 | Opus | 534 | Cues at tail |
| webm | VP9 Profile 2 (10-bit) | Opus | 1 | |
| webm | VP9 (no audio) | none | 7 | yt-dlp `.f303` partials, **no Cues, no duration** |
| webm | none | Opus | 2 | yt-dlp `.f251` audio partials (1 without Cues) |
| mp4 | H.264 High/Main/Baseline | AAC | 384 | 14 are non-faststart (`moov` after `mdat`) |
| mp4 | VP9 Profile 0 / 2 | AAC | 56 / 4 | |
| mkv | H.264 High/Main | Opus | 107 | Cues at tail |
| mkv | VP9 Profile 0 | AAC | 32 | |
| mkv | H.264 | AAC | 6 | |
| mkv | VP9 Profile 0 | Opus | 3 | |
| mkv | VP9 Profile 0 | **E-AC3** | 1 | |

No mp4 is fragmented. All Matroska files that were muxed whole have Cues; yt-dlp/ffmpeg write them at the end of the file.

## Verdicts (empirical)

**Test setup:**

- **Browser:** Chromium 152.0.7977.130, the Claude desktop browser pane. UA: `Chrome/152.0.7977.130`. H.264 and AAC were present.
- **Server:** a throwaway Node 22 `http` server with single-range `Range` support, serving files from the original locations read-only.
- **Probes:**
  - Every representative file was loaded with each of `video/webm`, `video/x-matroska`, `video/mp4` and `application/octet-stream` (80 loads).
  - Each file was played for 2 s with audio on, reading `getVideoPlaybackQuality()` and `webkit{Video,Audio}DecodedByteCount`.
  - Each file was then seeked to 50/90/15/60% of its duration.
  - Then came a 15-seek scrub series per file.
  - There were no media errors in any case. The only console error came from my own harness, which set `currentTime = Infinity` on the no-duration file.

| Combo (representative file) | Plays? | Audio decoded? | Any MIME works? | Seek ms (4 seeks) | Verdict |
|---|---|---|---|---|---|
| webm VP9+Opus, 360p | yes | yes | yes | 12–66 | Native |
| webm VP9 P2 10-bit+Opus, 1080p | yes | yes | yes | 79–144 | Native |
| mp4 H.264 Baseline+AAC | yes | yes | yes | 8–10 | Native |
| mp4 H.264 Main+AAC | yes | yes | yes | 8–39 | Native |
| mp4 H.264 High+AAC (1 s GOP) | yes | yes | yes | 14–19 | Native |
| mp4 H.264+AAC **non-faststart** (720p, 10 s GOP) | yes | yes | yes | 17–122 | Native. Chromium Range-fetches the tail `moov`; metadata arrived in 30 ms |
| mp4 VP9 P0 / P2 + AAC | yes | yes | yes | 27–99 / 37–51 | Native |
| mkv H.264 Main+Opus | yes | yes | yes | 10–50 | Native |
| mkv H.264 High+Opus, 1080p | yes | yes | yes | 32–245 | Native |
| mkv VP9+AAC | yes | yes | yes | 77–117 | Native |
| mkv H.264 High+AAC, 735 MB / 80 min | yes | yes | yes | 8–32 | Native |
| mkv H.264 Main+AAC, 32 min | yes | yes | yes | 30–63 | Native |
| mkv VP9+Opus, 1080p, 415 MB | yes | yes | yes | 35–217 | Native |
| mkv **VP9+E-AC3** | video only | **no (silent, no error)** | n/a | 21–220 | **Fallback**: `-c:v copy -c:a aac` |
| webm VP9 video-only, **no Cues** (`.f303`) | yes | (no track) | yes | duration = `Infinity`, seekable only within buffer | **Fallback**: one-time `-c copy -cues_to_front 1` to cache |
| webm Opus audio-only, no Cues (`.f251`) | yes | yes | yes | 34–63 | Native. Duration is known from the header |

`canPlayType` reported `"probably"` for `video/x-matroska; codecs="avc1.640028,opus"` and for `vp09.00.40.08,mp4a.40.2`, and `""` for any `ec-3`/`ac-3`. It returned `""` for `video/x-matroska; codecs="vp9,aac"` only because the short `vp9` codec string is accepted for WebM alone (Matroska and MP4 need the full `vp09.*` form). That is a codec-string quirk, not a playback limit. **Use ffprobe on the server rather than `canPlayType` to decide on a fallback.**

## Why MIME type is irrelevant (primary sources)

- Chromium's `FFmpegGlue` sets an FFmpeg `format_whitelist` of `ogg, matroska, wav, flac, mp3, mov` (+`aac` with proprietary codecs). It then names the container from FFmpeg's own probe result (`"matroska,webm"` → `kContainerWEBM`, `"mov,mp4,…"` → `kContainerMOV`). The server's `Content-Type` plays no part in that decision. Source: [`media/filters/ffmpeg_glue.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/filters/ffmpeg_glue.cc), `GetAllowedDemuxers()` and `OpenContext()`.
- `media/base/mime_util_internal.cc` registers `video/matroska` and `video/x-matroska` with an `mkv_codecs` set. That set covers VP8, VP9, and H.264/HEVC/AV1 where built, plus PCM, FLAC, MP3, Opus, Vorbis and AAC. AC3/EAC3/DTS are added only under platform build flags. `video/webm` admits only VP8/VP9/AV1 + Opus/Vorbis. These tables drive `canPlayType`/`isTypeSupported`, not the `src=` demuxer. Source: [`media/base/mime_util_internal.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/base/mime_util_internal.cc), `AddSupportedMediaFormats()`.
- Empirically, the same file decoded identically under all four `Content-Type` values. That included mp4 served as `video/webm` and mkv served as `application/octet-stream`.
- The Chromium Audio/Video page lists Matroska, MP4 and WebM as supported containers, with H.264 and AAC under proprietary codecs (Google Chrome builds). Source: <https://www.chromium.org/audio-video/>. MDN describes WebM as a Matroska subset limited to VP8/VP9/AV1 with Vorbis/Opus: <https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers>.
- **MSE is a different story.** `MediaSource.isTypeSupported` returned `false` for every `video/x-matroska` and for `video/webm; codecs="avc1…"`. If the app ever moves to MSE (custom buffering, hls.js-style), Matroska would need remuxing. Plain `src=` doesn't.

## Range requests and seeking

- **What the request log shows.** For the 735 MB mkv the request sequence was `bytes=0-`, `bytes=735510528-` (tail Cues), `bytes=262144-`, … and then direct jumps such as `bytes=369131520-` on each seek. In other words, Chromium reads the Cues index and jumps by byte offset. This is the mechanism MDN describes for "media players that support random access": <https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests>.
- **No fragmentation needed.** With Range, non-fragmented mp4, including the tail-`moov` case, and Cues-bearing Matroska both seek instantly.
- **Without Range** (the server omits `Accept-Ranges` and always answers 200), `seekable` is `[0,0]`. Assigning `currentTime = 2000` fires `seeked` but lands near 0. **The server must implement Range properly**: 206 responses with `Content-Range`, `bytes=N-` and suffix ranges. Bun's `Bun.file()` Response and most static servers do this. A hand-rolled handler must too.

## Keyframe interval and scrub speed

Chromium's demuxer seeks to the keyframe at or before the target (`av_seek_frame(…, AVSEEK_FLAG_BACKWARD)`) and then drops non-keyframes until it reaches it. The renderer then decodes forward to the target ([`media/filters/ffmpeg_demuxer.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/filters/ffmpeg_demuxer.cc)). Seek latency therefore grows with GOP length × per-frame decode cost.

GOPs were measured with ffprobe packet flags. Scrub times are medians and p90 over 15 random seeks:

| File | GOP | Scrub median / p90 |
|---|---|---|
| mkv H.264 720p | 1.0 s | 19 / 31 ms |
| mp4 H.264 720×1280 | 1.0 s | 25 / 27 ms |
| mkv H.264 720p (80 min) | 1.8 s | 16 / 31 ms |
| webm VP9 360p | 5.3 s | 30 / 59 ms |
| mkv H.264 720p | 5.2 s | 62 / 118 ms |
| mp4 H.264 720p non-faststart | 9.4 s (max 10) | 107 / 171 ms |
| mkv VP9 1080p | 5.3 s | 165 / 294 ms |
| webm VP9 P2 1080p | 4.9 s | 173 / 269 ms |

Most YouTube-sourced files have ~5 s GOPs. The worst case is 1080p VP9 at roughly 0.3 s per seek, which is fine for click-to-seek. Continuous drag-scrubbing over 1080p VP9 will feel slightly sticky. If v1 needs that, throttle `currentTime` writes to one in flight at a time, waiting for `seeked` before issuing the next. Don't re-encode. Chrome has no `fastSeek()`. Hardware decode (VideoToolbox) wasn't isolated here.

## ffmpeg fallback: when and what it costs

The tests ran on this Mac. The largest test file was cached in the page cache; the files on `/Volumes/General` were cold.

| Command | File | Wall / CPU | RSS | Result |
|---|---|---|---|---|
| `-c copy -movflags frag_keyframe+empty_moov+default_base_moof -f mp4` | mkv H.264+AAC, 735 MB / 80 min | 1.5 s / 2.1 s | 25 MB | OK |
| same | mkv VP9+Opus, 415 MB | 0.55 s / 0.75 s | 35 MB | OK |
| `-c copy -f webm -live 1` | mkv H.264 + anything | — | — | **Fails**: WebM can't hold H.264 or AAC |
| `-c copy` → mp4 or webm | mkv VP9+E-AC3 | — | — | **Fails** at header write |
| `-c:v copy -c:a aac -b:a 192k` → fMP4 | mkv VP9+E-AC3, 674 s | 35 s / 35 s (1 core) | 33 MB | OK, ~19× realtime |
| `-c copy -cues_to_front 1` → file | webm `.f303` without Cues, 30 MB | 0.66 s | — | Duration restored (93.1 s), Cues at front |
| Time to first 1 MB of piped fMP4, with or without `-ss` | any | 73–87 ms | — | — |

Behaviour of a **piped** (on-the-fly) remux in `<video>`:

- **Fragmented MP4 over a non-Range pipe:** `duration` reported only the first fragment (~5 s), and seeks failed (`seekable` empty). Using it would mean the app owns the timeline: a restart with `-ss` on every seek (~100 ms to first byte), plus a UI offset.
- **`-f webm -live 1` over a pipe:** `duration = Infinity`, and seeking worked only inside what had downloaded. The VP9 remux ran far faster than realtime, so a seek to 500 s succeeded after 2 s.
- **Conclusion:** a piped remux is a poor default. Where a fallback is needed, **write a cached file once (`-c copy`, or `-c:a aac` for E-AC3) and serve that with Range**. Both cases are rare enough (9 files) that this can happen during the library scan or lazily on first play.

ffmpeg option semantics are from [ffmpeg-formats](https://ffmpeg.org/ffmpeg-formats.html):

- `frag_keyframe` starts a new fragment at each video keyframe.
- `faststart` moves `moov` to the front in a second pass and isn't compatible with fragmented output.
- The Matroska `cues_to_front` option writes the index at the beginning and is ignored on unseekable output, which is why a pipe can't carry Cues.
- `live` writes the file assuming a live stream.

## Fallback decision rule for the server

Probe each file once with ffprobe at scan time and store the result:

1. Skip `._*` files.
2. If the audio codec is not one of {aac, opus, vorbis, mp3, flac}, the file **needs an audio transcode**: `-c:v copy -c:a aac` into a cached fMP4 or mp4. This applies to the 1 E-AC3 file. AC3 and DTS would fall here too.
3. If the format duration is missing, or the Matroska file has no Cues, the file **needs a one-time `-c copy` remux to a cache**. Pair `.fNNN` video and audio siblings where both exist.
4. Otherwise, **serve the original bytes** with Range and any reasonable `Content-Type`.

## mpv JSON IPC as the fallback architecture: not recommended

According to the mpv manual, `--input-ipc-server` exposes JSON commands over a Unix socket, and mpv renders in its own window. Embedding it requires libmpv in a native host, not a browser page (<https://mpv.io/manual/stable/#json-ipc>). That would split playback between two UIs and add a native dependency. All of that would serve under 0.1% of files, which ffmpeg already handles. Reconsider it only if a future source brings codecs Chromium can't decode at all, such as HEVC without hardware support, or DTS.

## Caveats

- The tests ran in the Chromium 152 browser pane, not Brave itself. Brave desktop uses Chromium's media stack, including proprietary H.264/AAC. Expect identical results, but spot-check one mkv H.264+Opus and the E-AC3 file in Brave. A Chromium build *without* proprietary codecs would lose H.264 and AAC, which affects 589 files.
- E-AC3 support in Chromium is platform-flag gated (`mime_util_internal.cc`). It was absent here and should not be assumed in Brave on macOS.
- Seek timings were measured on a local disk and an external volume, with warm and cold page cache mixed. They are indicative, not benchmarks.
