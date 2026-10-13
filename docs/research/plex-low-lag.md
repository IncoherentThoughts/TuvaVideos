# Research: how Plex keeps start and seek instant

Resolves [#46](https://github.com/IncoherentThoughts/TuvaVideos/issues/46) (part of map #43). Question: what makes Plex's start and seek feel instant, including while it transcodes, and what would a TV Server need to copy to match it?

Measured 2026-10-13 against Plex Media Server **1.41.5.9522** on this M1 (8 cores, macOS 15.7.9), using the "Tuva Sample" library (section 3, `docs/research/plex-sample.md` on branch `task/plex-sample`). Each run used its own session id and was stopped with `/video/:/transcode/universal/stop`; none was left running (`/transcode/sessions` was empty afterwards). Another agent was calling the decision endpoint on the same server at the same time, so the speeds below carry some CPU noise. The token was read from `defaults` into a variable and never printed; it doesn't appear in the quoted process arguments.

## Answer (TL;DR)

- **Start is fast because the playlist is instant and the first segment is tiny.** `decision` + `start.m3u8` + `index.m3u8` took **24–111 ms**. Plex writes a playlist for the **whole duration** up front, then encodes **1-second segments**. The first segment was downloaded **0.33–0.71 s** after the first request for 1080p and 4K30 sources, and 0.17 s when the video is copied.
- **Seek is a restart, not a wait.** If the client asks for a segment outside what has been encoded, Plex logs "We're in a seek", kills the transcoder and starts a new one with `-ss <t> -segment_start_number <n>`. Plex Web's other path (a new `start.m3u8?offset=`) does the same. Both landed the first segment **0.24–1.0 s** after a seek to 50% or 90%. The worst case was 4K60 VP9 at **1.9–2.8 s**.
- **It transcodes about 60 s ahead, then sleeps.** `TranscoderThrottleBuffer` defaults to 60 s. The session ran at full speed (4–12× realtime) until it was about 60–65 s past the last segment the client fetched, then logged "Throttle - Going into sloth mode". After that it added about 1 s of output every 4–8 s. Fetching a later segment woke it up again.
- **There is no hardware acceleration on this server.** Hardware transcoding needs Plex Pass, and this account's `subscriptionActive` is `false`. Every session reported `transcodeHwRequested: false`, and the process arguments show software decoders (`libdav1d`, `vp9`, `h264`) and `libx264 -preset veryfast`. Audio uses Apple's `aac_at` encoder.
- **Software speed on the M1 (Plex's arm64 transcoder):**
  - AV1 1080p → H.264 1080p: **6.3–7.8×** realtime.
  - AV1 4K → 1080p: **≈4.3×**.
  - VP9 4K30 → 1080p: **≈4.0×**.
  - VP9 4K60 → 1080p60: **≈1.9×**.
  - H.264 1080p re-encode: **≈11×**.
  - Copying H.264 and transcoding only the audio: **≈100×**.
- **For a TV Server:**
  - Don't transcode what the TV can play. A direct-play Range request had its first byte in **0.6–2.3 ms**, a few hundred times faster than any transcode start.
  - When a transcode is unavoidable, copy Plex's shape:
    - 1–2 s segments with keyframes forced at each boundary.
    - A full-length playlist written up front.
    - Encode about 60 s ahead, then pause the encoder.
    - On a seek, kill the encoder and restart it at that point.
  - Use an **arm64** ffmpeg. The app's `/usr/local/bin/ffmpeg` is an x86_64 build running under Rosetta, and it encoded at only about half Plex's speed.

## 1. Start: playlist, then first segment

Method: `python3 run.py <ratingKey> <label> <directStream> <watch_s>` (scratch script). The script issues `GET /video/:/transcode/universal/decision`, then `start.m3u8`, then `session/<sid>/base/index.m3u8`, then the first segment, with the parameters Plex Web sends: `protocol=hls`, `fastSeek=1`, `directPlay=0`, `videoResolution=1920x1080`, `maxVideoBitrate=20000` and `X-Plex-Product: Plex Web`. Times are cumulative from the decision request.

`start.m3u8` without a prior `decision` call for the same session returns **400**. The server log says "Denying access due to session lacking decision for transcode" (`~/Library/Logs/Plex Media Server/Plex Media Server.log`). So the client sequence is decision first, then start.

| File (ratingKey) | Source | Plex's choice | Playlist ready | First segment | Segment length |
|---|---|---|---|---|---|
| h264-aac-mp4 (707) | H.264 1080p30 + AAC, 4m40s | `directStream=1` → video **copy**, audio copy | 0.061 s | **0.167 s** (2.2 MB) | 10 s |
| same, forced (`directStream=0`) | | video transcode, audio → MP3 | 0.057 s | **0.372 s** | 1 s |
| av1-webm (700) | AV1 1080p30 + Opus, 4m01s | transcode → H.264 + AAC | 0.066 s | **0.483 s** | 1 s |
| av1-webm 4K (701) | AV1 2160p25 + Opus, 6m35s | transcode → H.264 1080p | 0.057 s | **0.690 s** | 1 s |
| 4k (698) | VP9 2160p30 + Opus, 4m46s | transcode → H.264 1080p | 0.082 s | **0.710 s** | 1 s |
| 4k (697) | VP9 2160p60 + Opus, 8m | transcode → H.264 1080p60 | 0.057 s | **0.588 s** | 1 s |
| long-concert (716) | H.264 1080p24 + Opus, 136m39s | `directStream=1` → video **copy**, Opus → AAC | 0.080 s | **0.292 s** | 10 s |
| same, forced (`directStream=0`) | | video transcode | 0.111 s | **0.327 s** | 1 s |

**Direct-play baseline:** the script sent `GET /library/parts/<id>/<ts>/file.<ext>` with `Range: bytes=<start>-<start+65535>`, 5 runs each at 0%, 50% and 90% of the file (`python3 range.py`). Every request returned **206**. The median time to first byte was **0.6–2.3 ms** for every file and position, including the 3.1 GB concert at 90%, and the maximum was 9.6 ms. In practice, direct play starts as fast as the TV's demuxer can open the file.

**Playlist shape** (`index.m3u8`, 1-s case):
```
#EXTM3U
#EXT-X-TARGETDURATION:1
#EXT-X-ALLOW-CACHE:NO
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:1, nodesc
00000.ts
…
```
- The playlist lists every segment for the full duration (242 for a 4-min file, **8200** for the 136-min concert) before any of them exist. The player therefore sees a normal VOD stream with a seekable timeline from the first request.
- After an `offset=` start, the same full list comes back with `#EXT-X-START:TIME-OFFSET=<t>` added. Segment `00000.ts` is then a 188-byte stub (one TS packet), and the real data starts at segment `<t>`.

## 2. How far ahead it transcodes (throttling)

Settings (`GET /:/prefs`, all at their defaults here):

| Pref | Value | Plex's description |
|---|---|---|
| `TranscoderThrottleBuffer` | **60** | "Amount in seconds to buffer before throttling the transcoder" ([Plex: Transcoder settings][transcoder]) |
| `TranscoderPruneBuffer` | 300 | "Amount in past seconds to retain before pruning segments from a transcode" |
| `SegmentedTranscoderTimeout` | 20 | "Timeout in seconds segmented transcodes wait for the transcoder to begin writing data" |
| `TranscoderQuality` | 0 (Automatic) | Selects the `x264opts` set ([transcoder]) |
| `TranscoderH264Preset` | `veryfast` | |
| `TranscodeCountLimit` | 0 (unlimited) | |

What happened: the script polled `GET /transcode/sessions` every 2 s while fetching only `00000.ts`. It then fetched a segment about 5 s below the ceiling and kept polling. `maxOffsetAvailable` is the encoded ceiling in seconds.

| Session | Climb at full speed | Throttled at | After fetching segment *k* |
|---|---|---|---|
| av1-webm 1080p | 8 → 59 s in 8 s | **64 s** at t=10 s (`throttled: true`, speed 0) | — |
| long-concert (transcode) | 14 → 52 s in 4 s | **65–68 s**, then about +1 s every 4–8 s | fetched `00063.ts` → climbed to **126 s** and throttled again (63 + 63) |
| h264 forced transcode | 14 → 55 s in 4 s | **61–62 s** | fetched `00057.ts` → **120 s** |
| VP9 4K30 | 5 → 60 s in 14 s | **62–63 s** | fetched `00058.ts` → still climbing at 109 s when the watch ended |
| long-concert (copy) | burst at ~100× | **90.8 s** (whole 10-s segments) | fetched `00004.ts` (40 s) → **133.5 s** |

- The log line at the throttle point reads "Session … is throttling" followed by "Throttle - Going into sloth mode", and "is unthrottling" when the client moves on.
- The buffer is measured from the **last segment the client requested**. No `/:/timeline` reports were sent, so segment requests alone drive it.
- In copy mode the ceiling overshoots to about 90 s because each step is a 10-s segment produced at about 100×.
- Segments older than 300 s are pruned.

## 3. What a seek does

Two paths were measured (`run.py`):

1. **Continuing the session** (what an HLS player does on its own when the user scrubs): request segment *n* from the running session.
   - The log says `We're in a seek: asked for 121, min/max available was 0/64`, then `Killing job`, `Starting a transcode session … at offset 121.0`, then "Resetting play progress due to seek".
   - The new transcoder starts with `-ss 121 … -segment_start_number 121`.
   - Plex doesn't wait for the old encoder to reach the target. It always restarts.
2. **`offset=` restart** (Plex Web's explicit seek): `stop`, then `decision` + `start.m3u8?offset=<t>` with a new session, then the segment at *t*.

Time from the request to the first segment after the seek:

| File | Continue → 50% | Continue → 90% | `offset=` 50% | `offset=` 90% |
|---|---|---|---|---|
| h264 mp4, copy | 0.005 s¹ | 0.005 s¹ | 0.181 s | 0.168 s |
| h264 mp4, transcode | 0.324 s | 0.323 s | 0.244 s | 0.242 s |
| AV1 1080p | 0.535 s | 0.533 s | 0.341 s² | 0.442 s² |
| AV1 4K | 0.729 s | 0.737 s | 0.968 s | 0.863 s |
| VP9 4K30 | 1.357 s | 0.943 s | 0.681 s | 0.987 s |
| VP9 4K60 | 1.888 s | 1.980 s | 2.838 s | 2.022 s |
| long-concert, copy | 0.329 s | 0.325 s | 0.273 s | 0.309 s |
| long-concert, transcode | 0.425 s | 0.319 s | 0.383 s | 0.383 s |

¹ The copy of the short file had already finished (complete at ~1000× speed), so the segment was already on disk.
² This first run fetched the 188-byte stub `00000.ts` rather than the segment at the offset, so it understates the time. Later runs fetched the segment at the offset.

Seek flags (from `ps` during the seeks):
- When the video is **transcoded**, `-ss <t>` goes before `-i` (input seek), and keyframes are forced every second with `-force_key_frames expr:gte(t,n_forced*1)`. Any 1-s boundary is therefore a clean cut.
- When the video is **copied**, Plex adds `-noaccurate_seek` and uses `-segment_time 10`, so the stream starts at the source keyframe at or before the target. Copied segments can only be cut at source keyframes, which is why they are 10 s rather than 1 s.

## 4. The `Plex Transcoder` command line

Captured with `ps -axo pid=,args=` 1 s after the first segment. No token appears in the arguments: the callbacks go to `127.0.0.1:32400/video/:/transcode/session/<sid>/<uuid>/{manifest,progress}`. Transcode case, AV1 webm (700), with line breaks added and the file path shortened:

```
Plex Transcoder -codec:0 libdav1d -codec:1 opus
  -analyzeduration 20000000 -probesize 20000000 -i …/av1-webm__Mongolian Winter….webm
  -filter_complex [0:0]scale=w=1920:h=1080:force_divisible_by=4[0];[0]format=pix_fmts=yuv420p|nv12[1]
  -map [1] -codec:0 libx264 -crf:0 17 -maxrate:0 18683k -bufsize:0 37366k -r:0 30 -preset:0 veryfast
  -x264opts:0 subme=0:me_range=4:rc_lookahead=10:me=hex:8x8dct=0:partitions=none
  -force_key_frames:0 expr:gte(t,n_forced*1)
  -filter_complex [0:1] aresample=async=1:ochl='stereo':rematrix_maxval=0.000000dB:osr=48000[2]
  -map [2] -codec:1 aac_at -b:1 233k
  -segment_format mpegts -f ssegment -individual_header_trailer 0 -segment_time 1
  -segment_start_number 0 -segment_copyts 1 -segment_time_delta 0.0625
  -segment_list http://127.0.0.1:32400/video/:/transcode/session/<sid>/<uuid>/manifest?X-Plex-Http-Pipeline=infinite
  -segment_list_type csv -segment_list_size 5 -segment_list_separate_stream_times 1 -segment_list_unfinished 1
  -max_delay 5000000 -avoid_negative_ts disabled -map_metadata -1 -map_chapters -1 media-%05d.ts
  -start_at_zero -copyts -vsync cfr -y -nostats -loglevel quiet -loglevel_plex error
  -progressurl http://127.0.0.1:32400/video/:/transcode/session/<sid>/<uuid>/progress
```

| Aspect | Value | Notes |
|---|---|---|
| Video encoder | `libx264`, `-preset veryfast`, `-crf 17` capped by `-maxrate 18683k -bufsize 2×` | `x264opts` is the "Prefer higher quality encoding" set from [transcoder] (Automatic resolved to it) |
| Decoders | `libdav1d` (AV1), `vp9`, `h264`: all software | Same for every run |
| Frame rate | `-r` = source rate (30, 23.976, 29.97, **60** for the 4K60 file) | No frame-rate drop for 1080p60 output |
| Scaling | `scale=w=1920:h=1080:force_divisible_by=4` then `format=yuv420p\|nv12` | 4K → 1080p |
| Segmenting | `-f ssegment -segment_time 1` (transcode) / **10** (copy), `-segment_time_delta 0.0625`, `-force_key_frames` every 1 s | The segment list streams to PMS as CSV over HTTP |
| Audio | `aac_at` (AudioToolbox) 233k stereo, or `libmp3lame` when `directStream=0` on an AAC source | |
| Threads | **No `-threads` flag**, so ffmpeg's default (all cores) | |
| Hardware | **No** `-hwaccel`, `videotoolbox` or `h264_videotoolbox` | See §5 |
| Copy case (716, `directStream=1`) | `-codec:0 h264 -codec:1 opus -noaccurate_seek … -map 0:0 -codec:0 copy … -codec:1 aac_at -b:1 258k … -segment_time 10` | |

## 5. Hardware acceleration on the M1

- **Plex Pass is required.** "Hardware-accelerated streaming is a premium feature and requires an active Plex Pass subscription" ([Plex: Using Hardware-Accelerated Streaming][hwaccel]). The settings page marks both "Use hardware acceleration when available" and "Use hardware-accelerated video encoding" as "(Requires an active Plex Pass subscription for the server owner account" ([transcoder]).
- **On macOS it means VideoToolbox.** The tech-specs section lists "macOS native (VideoToolbox)" for both decoding and encoding, with libavformat and x264 as the software fallbacks. Hardware encoding applies to H.264; HEVC encoding is labelled experimental and needs 1.41.3+. The page doesn't name Apple Silicon or give a per-codec Mac list ([hwaccel]). M1 VideoToolbox has no AV1 decoder (map #43 notes), so AV1 sources would still decode in software even with Plex Pass.
- **This server doesn't have it:**
  - `GET /myplex/account` → `subscriptionActive: false`, `subscriptionState: "Inactive"`.
  - `GET /` → `myPlexSubscription: false`.
  - `GET /:/prefs` has 152 settings and none of them is `HardwareAcceleratedCodecs` or `HardwareAcceleratedEncoders`, so the hardware toggles are hidden without Plex Pass. Only `TranscoderHEVCEncoding=false` appears.
  - Every `/transcode/sessions` entry reported `transcodeHwRequested: false`, and the process arguments carry no VideoToolbox flags (§4).
- So every number in §1–3 is **pure software** on Plex's arm64 transcoder (`file "…/Plex Transcoder"` shows a universal x86_64 + arm64 binary).

## 6. Transcode speed on this M1

Plex's own speed comes from the `speed` field and the rise of `maxOffsetAvailable` per second before throttling (`/transcode/sessions`, §2):

| Conversion | Plex (software, arm64) |
|---|---|
| AV1 1080p30 → H.264 1080p | **6.3–7.8×** (8 → 59 s in 8 s) |
| AV1 2160p25 → H.264 1080p | **2.5–5.4×, ≈4.0× average** (5 → 61 s in 14 s) |
| VP9 2160p30 → H.264 1080p | **3.6–4.3×, ≈3.9× average** (5 → 60 s in 14 s) |
| VP9 2160p60 → H.264 1080p60 | **1.7–2.1×** |
| H.264 1080p24 → H.264 1080p (concert) | 8.2–10.4× |
| H.264 1080p30 → H.264 1080p | 10.7–11.9× |
| H.264 copy + Opus → AAC (concert) | ≈100× |

My own 30-s ffmpeg encode of the same files (`python3 -u ffbench.py`, HLS output with 1-s segments and forced 1-s keyframes, Plex's x264 flags, `SS=0` to start at 0 like Plex and the default `-ss 120` for mid-file). The binary is `/usr/local/bin/ffmpeg` 8.0.1, which is **x86_64 under Rosetta** (`file $(readlink -f /usr/local/bin/ffmpeg)`):

| Source | x264 veryfast (Plex flags) | `h264_videotoolbox` (`-b:v 12M -realtime 1 -prio_speed 1`) | `-hwaccel videotoolbox` + `h264_videotoolbox` |
|---|---|---|---|
| AV1 1080p | 2.94–3.34×, first segment 1.0–1.2 s | **5.35–5.62×**, first segment 0.69–0.92 s | — (no AV1 hardware decode; the run hung at 0% CPU and was killed) |
| VP9 4K30 | 2.62–2.78×, first segment 1.4–1.9 s | 3.01–3.62×, first segment 1.0–1.7 s | 2.65–2.94×, first segment 1.2–2.2 s |
| AV1 4K | 2.62×, first segment 1.5 s | 2.93×, first segment 1.4 s | — |
| VP9 4K60 | 1.05×, first segment 4.1 s | 1.05×, first segment **12.4 s** | 1.29×, first segment 4.8 s |

What the benchmark shows:
- The Rosetta x86_64 ffmpeg runs x264 at **about half** Plex's arm64 speed on the same files (2.9× vs 6.4× for AV1 1080p). For the TV Server, an arm64 ffmpeg matters more than any flag. The app picks `/usr/local/bin/ffmpeg` first (`src/server/config.ts` `findBin`).
- `h264_videotoolbox` encodes on the media engine, so Rosetta doesn't slow it. It nearly doubles throughput when decoding is cheap (AV1 1080p). For 4K sources the bottleneck is the **software decode** (dav1d or VP9), so it gains only 10–35%.
- VideoToolbox VP9 decode (`-hwaccel videotoolbox`) didn't help at 4K30 and helped only a little at 4K60.
- For 4K60 VP9, every option on this Mac stays close to realtime (1.05–1.3× here, 1.9× in Plex). That leaves no headroom for a 60-s lead, and a seek costs 2–5 s. Even when transcoding is needed, these files are better served by direct play or a pre-made Fallback.

## 7. What a TV Server would need to match the feel

1. **Don't transcode what the R85H can play.**
   - A Range request costs about 1 ms to first byte (§1), and seeking is the TV's own demuxer reading an index.
   - Per #47, every combination in the library is listed or likely on the R85H, and the only expected fix is a `-c copy` remux. So the TV Server's normal path should be the existing `/copy/:id` Range endpoint, plus the existing cached Fallback for anything the TV rejects (`docs/playback-architecture.md`).
   - Transcoding is for the exception, not the design.
2. **If a remux is needed on the fly, copy Plex's copy mode.**
   - Flags: `-c:v copy`, `-noaccurate_seek`, `-ss <t>` before `-i`, about 10-s segments cut at source keyframes, audio to AAC.
   - It runs at about 100× realtime, so the first segment arrives in about 0.3 s and a seek costs about 0.3 s (§1, §3).
   - A one-time cached Fallback, the current design, is simpler and just as fast once made.
3. **If a real transcode is needed:**
   - **Segment length 1–2 s.** Plex uses 1 s (`-segment_time 1`) with `-force_key_frames "expr:gte(t,n_forced*1)"`. Start and seek cost one segment's encode, plus decoder warm-up, not a 6–10-s chunk. The TV player's own startup buffer will dominate, so 2 s is a reasonable compromise if 1-s segments cause player overhead.
   - **Full-length VOD playlist up front.** List `ceil(duration/segment)` entries immediately so the timeline and scrub bar are complete, and serve each segment by blocking until it exists. This is how Plex's `index.m3u8` works.
   - **Lead of about 60 s.** Encode at full speed until about 60 s past the highest segment requested, then pause the encoder (`SIGSTOP`/`SIGCONT`, or stop reading its pipe) and resume when the player requests further. Prune segments more than about 300 s behind.
   - **Seek = restart.** When a requested segment is outside `[min, max]` encoded, kill ffmpeg and start a new one with `-ss <n·seg> … -start_number <n>` (Plex: `-ss 121 … -segment_start_number 121`). Never wait for the old encoder to catch up.
   - **ffmpeg flags.** Plex's shape, swapping `libx264` for `h264_videotoolbox` on an arm64 build:
     ```
     ffmpeg -ss <t> -i <file> -map 0:v:0 -map 0:a:0
       -vf scale=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=4,format=yuv420p
       -c:v h264_videotoolbox -b:v 12M -maxrate 18M -bufsize 36M -realtime 1 -prio_speed 1
       -force_key_frames "expr:gte(t,n_forced*1)"
       -c:a aac -b:a 192k -ac 2
       -f hls -hls_time 1 -hls_playlist_type event -start_number <n> -hls_segment_filename seg%05d.ts index.m3u8
     ```
     The software alternative is `-c:v libx264 -preset veryfast -crf 17 -maxrate 18683k -bufsize 37366k -x264opts subme=0:me_range=4:rc_lookahead=10:me=hex:8x8dct=0:partitions=none`. Add `-hwaccel videotoolbox` only for H.264, HEVC or VP9 sources; it must not be used for AV1 on the M1.
   - **Expect** the first segment in about 0.5–1 s for 1080p and 4K30 sources, and 2–5 s for 4K60 VP9.
4. **The Player can't use Plex's HLS path for 4K.** #47 found MSE capped at FHD on Tizen, so an HLS transcode would play through native `<video src=…m3u8>` or AVPlay and be 1080p. That is fine for a transcode fallback, but it's another reason to keep 4K Copies on direct play.

## Sources

[transcoder]: https://support.plex.tv/articles/200250347-transcoder/
[hwaccel]: https://support.plex.tv/articles/115002178853-using-hardware-accelerated-streaming/

- Plex support: [Transcoder settings][transcoder] (redirects to `/articles/transcoder/`) · [Using Hardware-Accelerated Streaming][hwaccel]
- Local server, 2026-10-13: `GET /`, `/:/prefs`, `/myplex/account`, `/transcode/sessions`, `/video/:/transcode/universal/{decision,start.m3u8,session/<sid>/base/*,stop}`, `/library/parts/…` (with `Range`). `~/Library/Logs/Plex Media Server/Plex Media Server.log` for the "We're in a seek", "Killing job", "Going into sloth mode" and "session lacking decision" lines. `ps -axo pid=,args=` for the transcoder command lines.
- Repo: `docs/playback-architecture.md` (Fallback design), `src/server/config.ts` (`findBin`), `docs/research/plex-sample.md` (branch `task/plex-sample`), `docs/research/tizen-2026-r85h.md` (branch `research/tizen-2026`).
- Scratch scripts (not committed): `run.py` (start, throttle and seek timing), `range.py` (direct-play TTFB), `ffbench.py` (30-s ffmpeg encodes).
