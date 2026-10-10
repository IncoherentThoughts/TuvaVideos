# Thumbnail generation pilot (poster + scrub strip)

Resolves wayfinder task #9 (map #1). Question: what poster and scrub-strip
sprite settings keep the full cache small and generation time reasonable for
about 1177 files?

## Recommendation (TL;DR)

| Item | Recommendation |
|--|--|
| Poster | 1 frame at 10% of duration, 480 px wide, WebP q75. About 14 KB (median 12, max 26). About 0.25 s per file. |
| Scrub strip | **N = min(100, floor(duration_seconds))** frames, evenly spaced at the centre of each of N equal slices, **160 px wide**, tiled **10 columns x ceil(N/10) rows**, one WebP per file, **q40** (`cwebp -q 40 -m 4`). About 190 KB per file at N=100. |
| Format | WebP via `cwebp`. About 12-15% smaller than JPEG at equal visual quality, and the same encode speed. **The local ffmpeg (8.0.1, x86_64) has no libwebp encoder**, so pipe ffmpeg PNG output into `cwebp`, or use `sharp` if the app is Node. Do not assume `-c:v libwebp` works. |
| Frame extraction | **Hybrid.** Single pass with `-skip_frame nokey` for H.264 files under 30 min. **Seek-per-frame, 4 in parallel, for everything else** (VP9/webm, anything 30 min or longer, unknown codecs). Never full-decode `fps=...` on long files. |
| Full cache | About 17 MB (posters) + about 215 MB (strips, N=100, q40) = **about 230 MB**. N=50 is about 110 MB total, but scrubbing is coarser. |
| Generation time | About 1.5 h serial wall, about 5-6 CPU-hours. With 4 files in parallel, about 25-40 min wall on this M1 (ffmpeg here runs under Rosetta, so native arm64 should be faster). |

## Method

- Environment: Apple M1, 8 cores. ffmpeg 8.0.1 at `/usr/local/bin/ffmpeg` (x86_64 under Rosetta), `cwebp` 1.6.0.
- Probe: 1137 mkv/webm/mp4 files found in `/Volumes/General/хөөмей/Хөөмей` and
  `/Users/evanwilliams/Desktop/Khoomei/Videos`. `._*` and `.DS_Store` were skipped.
  The task cites 1177 files; the remaining ~40 were not found by this probe (other extensions or locations), so the extrapolation scales the 1137 measured mix to 1177.
  Mix in the probed set: 544 webm, 444 mp4, 149 mkv.
  Duration buckets: 312 files under 3 min, 670 at 3-15 min, 106 at 15-60 min, 49 at 1 h or more.
- Sample: 30 files stratified over those buckets, mixing all three containers and H.264/VP9
  (7 under 3 min, 8 at 3-15 min, 7 at 15-60 min, 8 at 1 h or more; longest 2:03:53).
  Media files were only read, never modified. Outputs went to the scratchpad and have been deleted.
- Poster: `ffmpeg -ss 10%` then a 480 px scale, piped as PNG to `cwebp -q 75 -m 4`.
- Strip: a 160 px wide frame, 10-column grid, PNG intermediate piped to `cwebp -q 60 -m 4`.
  The measured runs used q60. q40 is estimated at 0.80x the bytes, from a q30/40/50/60/75 sweep on 3 sprites (see "Format and quality").
- Wall time is per file. CPU is user+sys of all child processes (ffmpeg + cwebp, via `getrusage`).
- **Caveat on the measurements.** The external drive `/Volumes/General` dropped off the bus part-way through
  (`Input/output error` from then on) and did not come back. The first run silently
  "failed fast" on 20 files, so I kept the 10 samples measured before the dropout (7 external, 3 local) and
  re-picked 20 from the local Desktop copies. The 7 external samples have no seek-per-frame numbers.
  Lesson for the real job: a probe or ffmpeg failure on an unreadable mount must be retried, not recorded as "no video".

## Measurements (30 files, sorted by duration)

Strip columns show wall s (CPU s) / KB. Single-pass uses `-skip_frame nokey`. The last column is seek-per-frame, 4 parallel, N=100.
Strip bytes are at q60.

| # | ext | duration | video | poster s / KB | strip50 s (CPU s) / KB | strip100 s (CPU s) / KB | seek-P4 N=100 s (CPU s) |
|--|--|--|--|--|--|--|--|
| 1 | mp4 | 0:30 | 640x480 h264 | 0.17 / 9.1 | 0.2 (0.3) / 69 | 0.4 (0.4) / 140 | 5.6 (24) |
| 2 | mkv | 1:36 | 640x480 vp9 | 0.24 / 20.1 | 1.4 (4.2) / 177 | 1.7 (4.4) / 354 | n/a (drive dropped) |
| 3 | mkv | 1:49 | 640x480 h264 | 0.19 / 14.8 | 0.5 (0.5) / 110 | 0.5 (0.6) / 217 | n/a (drive dropped) |
| 4 | mp4 | 1:53 | 1080x720 h264 | 0.19 / 7.2 | 0.5 (0.5) / 80 | 0.7 (0.8) / 161 | n/a (drive dropped) |
| 5 | webm | 2:43 | 1920x1080 vp9 | 0.40 / 18.1 | 11.4 (29.1) / 70 | 6.5 (27.7) / 140 | n/a (drive dropped) |
| 6 | webm | 2:53 | 636x480 vp9 | 0.19 / 9.4 | 2.4 (6.3) / 108 | 2.4 (6.2) / 217 | 6.2 (27) |
| 7 | webm | 2:57 | 1280x720 vp9 | 0.28 / 18.6 | 6.0 (25.3) / 147 | 6.4 (25.9) / 293 | n/a (drive dropped) |
| 8 | mp4 | 3:30 | 1920x1080 h264 | 0.23 / 14.4 | 1.3 (1.4) / 110 | 1.4 (1.6) / 217 | 12.3 (72) |
| 9 | mp4 | 3:32 | 1166x720 h264 | 0.16 / 10.5 | 0.5 (0.6) / 75 | 0.6 (0.7) / 150 | 8.3 (38) |
| 10 | mp4 | 3:52 | 1280x720 h264 | 0.20 / 20.6 | 0.9 (1.1) / 160 | 1.1 (1.2) / 330 | 10.1 (49) |
| 11 | webm | 4:05 | 1920x1080 vp9 | 0.42 / 7.3 | 7.6 (34.9) / 75 | 6.5 (32.6) / 150 | 11.8 (66) |
| 12 | mkv | 4:07 | 1920x1080 h264 | 0.26 / 11.1 | 1.1 (1.3) / 107 | 1.3 (1.5) / 211 | 13.9 (78) |
| 13 | webm | 4:36 | 640x480 vp9 | 0.20 / 26.0 | 3.9 (11.5) / 191 | 4.4 (12.1) / 378 | 6.9 (34) |
| 14 | mkv | 5:09 | 1920x1080 h264 | 0.30 / 20.2 | 1.9 (2.1) / 171 | 2.0 (2.3) / 339 | 16.4 (84) |
| 15 | webm | 6:41 | 600x480 vp9 | 0.21 / 13.5 | 4.7 (12.4) / 128 | 4.5 (11.8) / 259 | 6.4 (28) |
| 16 | webm | 24:25 | 640x480 vp9 | 0.18 / 12.6 | 8.1 (20.6) / 78 | 8.8 (22.4) / 155 | 4.4 (18) |
| 17 | mkv | 32:13 | 1280x720 h264 | 0.21 / 15.5 | 4.1 (4.7) / 136 | 4.3 (4.8) / 282 | 7.8 (40) |
| 18 | webm | 34:57 | 450x360 vp9 | 0.18 / 10.6 | 10.2 (28.3) / 132 | 10.2 (28.7) / 262 | 4.2 (18) |
| 19 | mkv | 44:50 | 1920x1080 h264 | 0.42 / 7.3 | 5.2 (5.9) / 68 | 5.2 (6.1) / 139 | 21.0 (117) |
| 20 | mp4 | 51:44 | 1920x1080 h264 | 0.19 / 11.8 | 9.8 (10.6) / 110 | 9.6 (10.5) / 218 | 14.0 (81) |
| 21 | mkv | 52:32 | 480x360 vp9 | 0.15 / 2.4 | 13.4 (42.7) / 47 | 13.6 (42.2) / 93 | 5.6 (19) |
| 22 | mp4 | 56:35 | 480x360 h264 | 0.18 / 13.5 | 2.9 (3.5) / 138 | 3.2 (3.8) / 276 | 4.5 (19) |
| 23 | mkv | 1:02:37 | 1920x1080 vp9 | 0.27 / 14.4 | 135.7 (508.3) / 118 | 135.5 (506.5) / 229 | 16.3 (82) |
| 24 | mp4 | 1:09:06 | 1920x1080 h264 | 0.28 / 7.3 | 21.1 (22.1) / 55 | 21.6 (22.5) / 108 | 12.3 (65) |
| 25 | mkv | 1:20:22 | 1920x1080 h264 | 0.19 / 8.1 | 21.2 (22.8) / 78 | 21.9 (23.5) / 153 | 11.9 (65) |
| 26 | mkv | 1:20:38 | 1280x720 h264 | 0.15 / 11.9 | 18.6 (26.7) / 78 | 18.6 (26.8) / 155 | 5.8 (25) |
| 27 | webm | 1:20:43 | 320x240 vp9 | 0.14 / 9.5 | 15.1 (31.3) / 109 | 15.2 (31.4) / 209 | 4.0 (13) |
| 28 | mp4 | 1:48:43 | 1280x720 h264 | 0.21 / 8.5 | 18.9 (20.5) / 71 | 20.1 (21.3) / 153 | 9.5 (44) |
| 29 | mp4 | 1:50:00 | 960x540 h264 | 0.23 / 14.6 | 17.2 (18.8) / 123 | 16.8 (18.3) / 246 | 7.4 (32) |
| 30 | mkv | 2:03:53 | 960x540 h264 | 0.24 / 10.4 | 17.2 (20.5) / 91 | 16.6 (19.8) / 179 | 8.6 (35) |

Size distribution (q60): poster min/median/max 2 / 12 / 26 KB. Strip50 47 / 108 / 191 KB. Strip100 93 / 214 / 378 KB.
Strip bytes depend on image content (noisy or busy footage compresses worse) and barely on duration or resolution.
Poster and strip generation never failed on any of the 30 files.

### Single-pass versus seek-per-frame on long files (N=100)

Run on 5 long files. "full" is `fps=100/dur,scale,tile` with full decode.
"nokey" is the same with `-skip_frame nokey`. "seek1" and "seek4" are one `ffmpeg -ss` per frame, run serially and 4 in parallel.
All columns show wall s (CPU s).

| file | duration | video | full decode | single-pass nokey | seek serial | seek 4 parallel |
|--|--|--|--|--|--|--|
| #24 | 1:09:06 | 1080p h264 | 87.2 (467) | 21.6 (22.5) | 21.5 (59) | 11.3 (66) |
| #19 | 44:50 | 1080p h264 | 70.1 (434) | 5.2 (6.1) | 26.4 (109) | 19.3 (117) |
| #23 | 1:02:37 | 1080p vp9 | 144.7 (539) | 135.5 (507) | 24.8 (55) | 12.6 (76) |
| #27 | 1:20:43 | 320x240 vp9 | 16.2 (33) | 15.2 (31) | 10.3 (11) | 4.0 (13) |
| #30 | 2:03:53 | 540p h264 | 129.1 (640) | 16.6 (19.8) | 14.6 (32) | 7.4 (37) |

Findings:

- Full decode is the worst everywhere, with 70-145 s and 430-640 CPU-seconds per long file. Do not use it.
- `-skip_frame nokey` works well for **H.264**: 5-22 s and only 6-23 CPU-seconds, because only keyframes are decoded.
  Its wall time still grows with duration (#24, 21 s) because the whole file is demuxed and read.
- `-skip_frame nokey` does **not** help **VP9**: it still decodes everything. The 1080p VP9 hour-long file took 135 s and 507 CPU-seconds.
  Seek-per-frame was 5-10x faster there (12-25 s).
- Seek-per-frame has a flat cost of about 4-25 s regardless of duration. It is dominated by 100 process launches and one GOP decode each,
  so it uses more CPU on H.264 (60-117 CPU-s on 1080p) but it reads only about 100 spots of the file. It should be the clear winner when the media sits on a slow external disk.
  4-way parallelism roughly halves its wall time (more CPU, same bytes).
- Seek accuracy: `-ss` before `-i` lands on the nearest preceding keyframe for fast seeks and then decodes forward to the exact time (ffmpeg default), so frames are exact.
  Single-pass `nokey` snaps each sample to the nearest keyframe, so files with a sparse GOP may repeat frames in the strip.
  For a scrub preview this is acceptable.

### Format and quality (3 sprites, N=100, 160 px wide)

| setting | #14 (1080p, 2.0 MB PNG) | #17 (720p, 2.9 MB PNG) | #9 (720p, 0.9 MB PNG) |
|--|--|--|--|
| WebP q30 | 240 KB | 198 KB | 105 KB |
| WebP q40 | 279 KB | 231 KB | 122 KB |
| WebP q50 | 312 KB | 261 KB | 138 KB |
| WebP q60 | 347 KB | 289 KB | 154 KB |
| WebP q75 | 405 KB | 337 KB | 180 KB |
| WebP q50 `-m 1 / -m 4 / -m 6` | 357 / 312 / 292 KB | 304 / 261 / 250 KB | 160 / 138 / 131 KB |
| JPEG `-q:v 6 / 9 / 12` | 482 / 356 / 284 KB | 401 / 302 / 242 KB | 222 / 169 / 138 KB |
| WebP q50 at 120 px / 200 px wide | 202 / 429 KB | 165 / 367 KB | 89 / 193 KB |

(Three local files that were still readable after the drive dropout.)

- WebP is about 12-15% smaller than JPEG at similar sharpness (WebP q50 about JPEG qv9-10, about 312 KB vs 356 KB).
  Encode time for either is 0.1-0.3 s, so encode is not the bottleneck. WebP `-m 4` is a good speed/size middle.
- q30 is still legible at 160 px (checked visually). q40 is the chosen compromise. The measured set was encoded at q60, so q40 totals are ~0.80x of the q60 numbers below.
- Width: 120 px is 35% smaller but too small to see a face. 200 px is +37%. 160 px stays the default.
- Max WebP dimension is 16383 px. A 160 px by 90 px frame at 10 columns x 10 rows is 1600 x 900, nowhere near the limit.

## Extrapolation to 1177 files

Per-bucket sample means were weighted by the real duration mix (312/670/106/49 of 1137) and multiplied by 1177.
The strips are measured at q60. The q40 column scales bytes by 0.80 and leaves time unchanged.
Wall is serial, single-process. CPU is total CPU-hours over all child processes.

| variant | mean wall s/file | mean CPU s/file | KB/file (q60) | total at q60 | total at q40 | total wall (h, serial) | total CPU (h) |
|--|--|--|--|--|--|--|--|
| poster (q75, 480w) | 0.24 | 0.52 | 14 | 17 MB | 17 MB | 0.08 | 0.17 |
| strip50 single-pass nokey for everything | 4.64 | 12.55 | 118 | 136 MB | 109 MB | 1.52 | 4.10 |
| strip100 single-pass nokey for everything | 4.48 | 12.48 | 236 | 272 MB | 218 MB | 1.47 | 4.08 |
| strip50 seek-per-frame (P4) for everything | 4.79 | 23.21 | 116 | 133 MB | 106 MB | 1.57 | 7.59 |
| strip100 seek-per-frame (P4) for everything | 9.19 | 46.23 | 232 | 266 MB | 213 MB | 3.01 | 15.12 |
| strip50 hybrid (h264 nokey, else seek) | 3.36 | 9.79 | 118 | 135 MB | 108 MB | 1.10 | 3.20 |
| **strip100 hybrid (h264 nokey, else seek)** | 4.41 | 15.65 | 236 | 271 MB | 217 MB | 1.44 | 5.12 |
| strip100 hybrid2 (h264 and <30 min: nokey; else seek) | 4.42 | 19.45 | 236 | 271 MB | 217 MB | 1.45 | 6.36 |

Notes on the table:

- Seek-per-frame is priced for N=100 and 4 parallel seeks per file. It is slower serial than nokey on short H.264 files (about 8-16 s versus 1-2 s),
  which is why the hybrid takes nokey for short H.264.
- The single-pass "nokey for everything" rows are held back by VP9: the 544 webm files are mostly VP9 and the one 1 h VP9 file alone cost 135 s.
  Their total hides that tail. The hybrid removes that tail (worst file about 25 s).
- Total estimate for the recommended setting: posters 17 MB + strips about 217 MB = **about 235 MB** for all 1177 files.
  Cache stays well under 0.5 GB even at N=100. The N=50 option totals about 125 MB.
- Time estimate: about 1.4-1.5 h serial wall. Running 4 files in parallel (the CPU is mostly not the limit, ffmpeg threads are) lands near 25-40 minutes.
  All of this is one-off or incremental (only new files).
- Timings include the Rosetta penalty (x86_64 ffmpeg on M1) and local SSD reads. Reads from an external or network disk will make single-pass slower
  (it reads the whole file) and make seek-per-frame comparatively better.

## Recommended commands

Probe first (one `ffprobe`, JSON):

```sh
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,duration:stream_disposition=attached_pic:format=duration \
  -of json "$IN"
```

Poster (10% of duration, 480 px, WebP q75):

```sh
ffmpeg -v error -y -ss "$(awk -v d="$DUR" 'BEGIN{print d*0.10}')" -i "$IN" -an -sn -dn \
  -frames:v 1 -vf scale=480:-2 -f image2pipe -c:v png - \
  | cwebp -quiet -q 75 -m 4 -o "$OUT/poster.webp" -- -
```

Strip, single pass (H.264 under 30 min). `N=$(( DUR < 100 ? DUR : 100 ))`, `COLS=$(( N < 10 ? N : 10 ))`, `ROWS=$(( (N + COLS - 1) / COLS ))`:

```sh
ffmpeg -v error -y -skip_frame nokey -i "$IN" -an -sn -dn \
  -vf "fps=$N/$DUR,scale=160:-2,tile=${COLS}x${ROWS}" -frames:v 1 \
  -f image2pipe -c:v png -compression_level 1 - \
  | cwebp -quiet -q 40 -m 4 -o "$OUT/strip.webp" -- -
```

Strip, seek per frame (VP9, 30 min or longer, unknown codecs). Run the per-frame jobs 4 at a time:

```sh
for i in $(seq 0 $((N-1))); do
  t=$(awk -v d="$DUR" -v i="$i" -v n="$N" 'BEGIN{printf "%.3f", d*(i+0.5)/n}')
  ffmpeg -v error -y -ss "$t" -i "$IN" -an -sn -dn -frames:v 1 \
    -vf scale=160:-2 -c:v png -compression_level 1 "$TMP/$(printf %04d $i).png" &
  (( $(jobs -r | wc -l) >= 4 )) && wait -n
done; wait
ffmpeg -v error -y -framerate 1 -i "$TMP/%04d.png" -vf "tile=${COLS}x${ROWS}" -frames:v 1 \
  -f image2pipe -c:v png -compression_level 1 - \
  | cwebp -quiet -q 40 -m 4 -o "$OUT/strip.webp" -- -
```

Also write a manifest next to the sprite with `{frames: N, cols, rows, frameW: 160, frameH, interval: DUR/N}`.
`frameH` varies with the aspect ratio (scale `-2` keeps it even), so the UI must read it, not assume 90.

## Edge cases

- **Duration shorter than N seconds.** `fps=N/DUR` with `DUR < N` just oversamples. A 3 s clip with N=100 gave 100 near-identical frames in a 926 KB PNG.
  Cap N at `floor(DUR)` (one frame per second minimum) so tiny clips get 3 frames, not 100.
  Under 1 s, or for N=1, skip the strip and use the poster alone. A 0.5 s clip tiled 2x1 worked fine in the test.
- **Fewer frames than grid cells.** When the filter emits fewer frames than `COLS x ROWS` (variable frame rate, truncated file, rounding),
  `tile` pads the rest with black but still emits the image. 30 frames on a 10x10 grid produced a full 1600x1200 image, 70% black.
  Compute `ROWS = ceil(N/COLS)`, and if the real frame count is lower, store the real count in the manifest and cut it on the client.
- **Poster seek beyond EOF.** `-ss` past the real end of the media makes ffmpeg exit 0 with **no output file** (tested). When the container's duration is overstated, a
  poster at 10% still usually works, but always check that the file exists and has bytes, then retry at `-ss 0`.
  Also consider a black first frame: at 10% this is rare but possible, so optionally retry at 25% if the poster's mean luma is under a threshold.
- **No duration in the container.** 7 of 1137 probed files report `format=duration = N/A`. They are the video-only DASH leftovers (names ending `.f303.webm`).
  Fall back to `stream=duration`, then to `ffprobe -count_packets` / the last packet pts. If none works, make a poster at `-ss 5` and skip the strip.
  Don't let N/A turn into `fps=100/` or a division by zero.
- **No video stream (audio only).** `ffprobe -select_streams v` prints nothing with exit code 0, and `ffmpeg` fails with
  `Output file does not contain any stream` (exit 234). Probe first and do not run ffmpeg on such files. Record `thumbnail: none` (status "no-video") and let the UI show a generic
  audio placeholder. If a stream is tagged `attached_pic` (cover art), treat it as a single-frame poster (`-map 0:v:0 -frames:v 1`) and skip the strip.
- **Unreadable files and mount drops.** A probe or ffmpeg error from `Input/output error` (see the drive dropout in this pilot) is transient,
  so it needs a retry and "failed, retry later" state. It must never be stored as "no video".
- **Rotation and odd sizes.** ffmpeg autorotates by default. `scale=160:-2` keeps even heights. Anamorphic sources (SAR != 1) are not corrected by the `scale` alone,
  so add `setsar=1` after scaling if the grid looks squashed.

## Reproduce

Scripts live in the pilot's scratchpad, not the repo. The key one-liners are the commands above. Samples were deleted after the run.
