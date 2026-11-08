# yt-dlp progress, errors and resumability

Research for #188 (part of #186). Version tested: yt-dlp 2026.10.21 (Homebrew). Source was read from the installed `yt_dlp/` package (paths below are relative to it; same files as github.com/yt-dlp/yt-dlp master). Live checks used `--simulate`/`-J` only; no media was downloaded. Claims are marked **(source)** for the code, **(README)** for the README / `--help`, **(ran)** for a command run for this note, **(unverified)** for anything not exercised.

## Summary

- Progress: `--newline --progress-template "download:..."` prints one line per update with any field of the internal progress dict. Total size is `total_bytes` (exact) or `total_bytes_estimate` (HLS/DASH fragments only), and is often unknown.
- Errors have **no machine-readable code on the CLI**. The exit code is `0` or `1` (plus `2`, `100`, `101` for special cases). Classify a failure by the `ERROR:` line on stderr, or embed yt-dlp as a Python library to get exception classes.
- Resume works: `.part` plus `--continue` (both default). A killed process leaves `<name>.part` (single file) or `.part` + `.part.ytdl` (fragmented); the next run resumes. The download archive is written only after a fully successful download, so a killed run is simply retried.
- Cheapest exact size: `--simulate` with `-J`/`--print`. For a YouTube video `requested_formats[].filesize` are exact and `filesize_approx` is their sum **(ran)**.
- A 1080p-max selector preferring browser-playable codecs is given in section 4.

## 1. Machine-readable progress

### `--progress-template`, `--newline`
- `--newline` prints progress as new lines instead of a rewriting bar. `--progress-template [TYPES:]TEMPLATE` takes TYPES `download` (default), `download-title`, `postprocess`, `postprocess-title`. "The video's fields are accessible under the `info` key and the progress attributes are accessible under `progress` key" **(README / `--help`)**. `--progress-delta SECONDS` throttles output (default 0) **(README)**.
- Rendering: `downloader/common.py` `_report_progress_status` (~l.318) uses `progress_template.get('download')`, defaulting to `[download] %(progress._default_template)s`.
- Keys on `progress` while `status == "downloading"` **(source: progress_hooks docstring in `YoutubeDL.py` ~l.395; `downloader/http.py` ~l.300)**: `status` (`downloading` / `finished` / `error`), `downloaded_bytes`, `total_bytes` (None when unknown), `total_bytes_estimate`, `speed` (B/s, None early), `eta` (s, None if unknown), `elapsed`, `filename`, `tmpfilename`, and for fragmented downloads `fragment_index`, `fragment_count`. Pre-formatted strings such as `_percent_str` and `_speed_str` also exist.
- `status` is `finished` once per downloaded file. Video and audio streams are separate files when `bv+ba` is merged, so expect two `finished` events, then post-processing for the merge. Post-processor progress uses `--progress-template "postprocess:..."` with statuses `started`, `processing`, `finished` **(source)**.
- Suggested template **(unverified)**: `--newline --progress-template "download:TUVA %(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s %(info.id)s"`. Missing values render as `NA`, so parse `NA` as null. The `TUVA` sentinel lets the parser ignore yt-dlp's other stdout lines. A single `%(progress)j` JSON dump would be simpler to parse; confirm it on a real download before relying on it.
- Gotchas: the total is known up front only for plain HTTPS files with `Content-Length` (most YouTube streams). For HLS/DASH `total_bytes` is absent and `total_bytes_estimate` is extrapolated from fragments so far (`downloader/fragment.py` l.266), so the percentage can jump. On a resumed download `downloaded_bytes` includes bytes already on disk (`byte_counter = 0 + ctx.resume_len`, `http.py` l.229). Merged downloads report each stream separately, so a combined percentage needs the summed expected size from section 4.

### `--print` and `-J`
- `--print [WHEN:]TEMPLATE` implies `--quiet` and `--simulate` unless `--no-simulate` or a later WHEN is used. WHEN values (same as `--use-postprocessor`) include `pre_process`, `video`, `before_dl`, `post_process` (default), `after_move` (after moving the file to its final location) **(README / `--help`)**. `--print after_move:filepath --no-simulate` yields the final filename. `--print-to-file` appends to a file instead.
- `-J` prints one JSON object per URL (a playlist as one line); `-j` one per video. Both simulate unless `--no-simulate` **(README)**.
- Present in `-J` for `jNQXAC9IVRw` **(ran)**: `id`, `duration`, `live_status` (`not_live`), `availability` (`public`), `filesize_approx`, `requested_formats`, `formats`. Top-level `filesize` was `None`; each requested format had `filesize` and `filesize_approx`.

## 2. Telling failures apart

### Exit codes (source: `__init__.py`, `YoutubeDL.py`)
| Code | Meaning |
|---|---|
| 0 | all URLs succeeded |
| 1 | a download/extraction error (`DownloadError` is raised; with `--ignore-errors`, `_download_retcode = 1`, `YoutubeDL.py` l.1103) |
| 2 | option/argument error (`optparse`, in `main()`) |
| 100 | self-update failed (`__init__.py` l.995) |
| 101 | download cancelled, e.g. `--max-downloads` reached (`DownloadCancelled`) |

`--ignore-errors`/`-i` does not change the code: the run continues past failures but still exits 1 at the end. Without it a single-URL run raises on the first error and exits 1. For many URLs use `--ignore-errors` as `scripts/download-rutube.sh` does and read stderr per URL, or run one yt-dlp process per Video (as `scripts/fetch-youtube-info.ts` does) so the exit code and stderr map to one Video.

### No error-code field; classify by message
Errors are Python exceptions rendered as `ERROR: [extractor] id: message` on stderr **(source: `YoutubeDL.report_error`)**. The classes (`utils/_utils.py`) are `ExtractorError` (with `expected=True` for normal "not a yt-dlp bug" cases, plus `video_id`, `ie`), `GeoRestrictedError(countries=...)`, `UserNotLive`, `UnsupportedError`, `DownloadError` (wraps the original in `.exc_info`), `ContentTooShortError`, `PostProcessingError`, `UnavailableVideoError`. The CLI exposes none of them except as text. Two routes:
1. Match stderr text. Fragile: messages change per release and per extractor.
2. Call yt-dlp as a Python library (`yt_dlp.YoutubeDL`), catch `DownloadError`, inspect `e.exc_info[1]` (an `ExtractorError`/`GeoRestrictedError`). Bun/TypeScript would need a small Python shim; not worth it unless text matching proves too brittle.

| Case | What yt-dlp prints / does | Evidence |
|---|---|---|
| Unavailable / removed / private | `ERROR: [youtube] <id>: Video unavailable. This video is not available` (exit 1). Private: `Private video`. The same text covers deleted and some region/age cases. | **(ran)** on `Sf9lj8T6TGQ`; `docs/research/failed-youtube-downloads.md` lists `Video unavailable`, `This video is unavailable`, `Private video` |
| Geo-blocked | Raised as `GeoRestrictedError` (`expected=True`); message is extractor-specific, typically "not available from your location due to geo restriction" | **(source)** `utils/_utils.py` l.1035. Message text not reproduced live |
| Login required | `raise_login_required` (`extractor/common.py` l.1245): "...Use --cookies-from-browser or --cookies for the authentication...". YouTube bot-check prints "Please sign in" (see failed-youtube-downloads.md, `UrCE3tq_prs`). Instagram without cookies printed `Instagram sent an empty media response. Check if this post is accessible ... use --cookies-from-browser or --cookies` | **(ran)** Instagram probe with a bogus shortcode; **(source)** `extractor/instagram.py` l.496-745, `extractor/youtube/_base.py` l.704-721 |
| Network drop mid-file | The HTTP downloader retries `TransportError`, 5xx and short bodies (`ContentTooShortError`) via `RetryDownload`, up to `--retries` (default 10), printing `[download] Got error: ... Retrying (n/10)...`; after the last attempt it errors and exits 1 | **(source)** `downloader/http.py` l.145-190, 340, 360; **(README)** default 10 |
| Rate limit (HTTP 429) | During **media download** any HTTP status below 500 other than 416 is re-raised with no retry, so 429/403 fail at once (`unable to download video data: HTTP Error 429: Too Many Requests`, exit 1). During **extraction** YouTube warns the account/IP "has been rate-limited by YouTube for up to an hour" and recommends `-t sleep`. Mitigate with `--sleep-interval/--max-sleep-interval/--sleep-requests` or `-t sleep`; `--extractor-retries` defaults to 3 | **(source)** `downloader/http.py` l.148-190 and `extractor/youtube/_video.py` l.4079; **(README)** |
| Disk full | An `OSError` from `ctx.stream.write` is caught: `ERROR: unable to write data: [Errno 28] No space left on device`; the download returns False, exit 1, no retry; the `.part` stays. A failing ffmpeg merge surfaces as `PostProcessingError` | **(source)** `downloader/http.py` l.269-275. Message not reproduced live |
| Fragment unavailable (HLS/DASH) | By default fragments that fail are skipped (`skip_unavailable_fragments` defaults True, `fragment.py` l.436), which can leave gaps; `--abort-on-unavailable-fragments` turns that into an error | **(source)**, **(README)** |

Recommendation: store the last `ERROR:` line verbatim per Video plus a coarse class from regexes (`Private video`, `unavailable`, `sign in|cookies|log in` -> login, `HTTP Error 429` -> rate limit, `No space left` -> disk, `geo|location|country` -> geo, else network/unknown). Retry only rate-limit, network and disk (after the cause is fixed); unavailable, private, geo and login are not fixed by retrying.

## 3. Resumability

- `-c/--continue` (default) resumes partial files; `--part` (default) writes `<file>.part`, renamed to the final name only on success. `--no-part` writes straight into the final file, so a killed download would look complete: avoid it. **(README)**
- Single-file HTTPS: on restart the size of `<file>.part` becomes `resume_len`, a `Range: bytes=N-` request is sent and the response's `Content-Range` is checked. If the server ignores Range the `.part` is wiped and restarted (`Unable to resume`). A 416 whose reported length is within 100 bytes of the `.part` is treated as already complete and renamed. **(source: `downloader/http.py` l.59-185)**
- Fragmented (HLS/DASH): yt-dlp writes `<file>.part` and `<file>.part.ytdl`, a JSON file holding `downloader.current_fragment.index`. On restart it resumes at that fragment; the `.ytdl` is deleted on success; a corrupt one restarts from fragment 0. **(source: `downloader/fragment.py` l.79-110, 183-212, 287)**
- Separate video+audio streams (`bv+ba`) are two downloads named `<name>.f<format_id>.<ext>`, each with its own `.part`, merged by ffmpeg into `<name>.<ext>`. `src/server/filename.ts` `PARTIAL_SEGMENT` already treats `.fNNN`, `.part`, `.part-FragN`, `.temp` and `.ytdl` segments as partial, so a Library scan during a download will not import them.
- `--download-archive FILE` skips listed Videos and appends `<extractor> <id>` (e.g. `youtube jNQXAC9IVRw`) **after** a successful download and post-processing (`YoutubeDL.py` l.3143-3146; `record_download_archive` l.3883 appends under a file lock). A process killed mid-download leaves no archive line, so the Video is retried and resumes from the `.part`. With `--simulate` nothing is recorded unless `--force-write-archive`. **(source)**
- A kill between the final rename and the archive write leaves a complete file with no archive entry; `--no-overwrites` (`-w`) prevents a re-download over it. `scripts/download-rutube.sh` already combines `--download-archive --no-overwrites --continue --retries 5`.
- Ctrl-C: `KeyboardInterrupt` exits with `ERROR: Interrupted by user` (`__init__.py` `main`), leaving `.part`/`.ytdl` for resume. SIGKILL leaves the same; the Range resume continues from the actual file size.
- Retry knobs: `--retries` (default 10, or `infinite`), `--fragment-retries` (10), `--retry-sleep` (no default; e.g. `exp=1:30`), `--file-access-retries` (3), `--extractor-retries` (3). **(README)**

## 4. Format selector and exact size

### Selector
yt-dlp's default sort prefers `av01 > vp9.2 > vp9 > h265 > h264 > vp8` **(README)**, so a plain `bv*+ba/b` picked AV1 + Opus WebM on the probe video (`395+251`) **(ran)**. AV1 does not play everywhere, so limit the codecs:

```
-f "bv*[height<=1080][vcodec~='^(avc1|vp0?9)']+ba[acodec~='^(mp4a|opus)']/b[height<=1080]"
```

Run against `jNQXAC9IVRw` this chose `242+251` (vp9 + opus, webm, 240p, the video's maximum) **(ran)**. `~=` is the regex operator **(README)**; `avc1` is the H.264 tag YouTube reports, `mp4a` AAC, `vp9`/`vp09` VP9.

To prefer mp4 (H.264 + AAC) first and fall back to webm (VP9 + Opus), sort instead of filtering: `-S "res:1080,vcodec:h264,acodec:aac,ext"` with `-f "bv*+ba/b"` (**unverified**: not run; fields are documented under README "Sorting Formats"). The filter form with a trailing `/b[height<=1080]` is the safer default: sites whose formats lack these codec names (Instagram, Rutube) would otherwise match nothing, and the fallback keeps them downloading. Merge H.264+AAC into mp4 without re-encoding; VP9+Opus belongs in webm or mkv (`--merge-output-format mkv` as `scripts/download-rutube.sh` does).

### Cheap exact size before downloading
- `yt-dlp --simulate -f <selector> --print "%(filesize_approx)s" URL` performs extraction only (no media bytes) and reports the sum for the chosen formats **(ran)**: `475961` for `395+251`, which equals `223779 + 252182`, the `filesize` values of `requested_formats`. `-J` gives each format's `filesize` (exact, from the site's metadata) and `filesize_approx` (`223778`, `252180`, off by a byte or two).
- Prefer `filesize`, fall back to `filesize_approx`. README: `filesize` is "the number of bytes, if known in advance", and yt-dlp stopped estimating `filesize_approx` for fragmented/manifest formats because the estimates were too inaccurate, so HLS/DASH sizes are missing: show "size unknown" or estimate from `duration` and `tbr`. **(README)**
- Cost: one extraction (a second or two on YouTube), repeated by the real run. To avoid repeating it, save `--write-info-json` and download with `--load-info-json`, only if the format URLs have not expired (YouTube URLs expire within hours). **(source: `__init__.py` `load_info_filename`)**

## 5. Local prior art
- `scripts/download-rutube.sh`: batch mode with `--ignore-errors --no-overwrites --continue --retries 5 --download-archive --newline`, output teed to a log; failures are grep'd from the log. It sets `pipefail`, so the exit status reflects yt-dlp's non-zero status through the `tee`.
- `scripts/fetch-youtube-info.ts`: one yt-dlp process per Video, so exit code and stderr map one-to-one to a Video. The same shape suits a download worker.
- `src/server/filename.ts`: ignores yt-dlp partial files and parses `[instagram-<shortcode>]` and `[rutube-<id>]` suffixes as provenance; YouTube names end in `[<11-char id>]`.
- `docs/research/failed-youtube-downloads.md`: real messages to seed the classifier's regexes.

## 6. Open items
- `--progress-template` (including a `%(progress)j` dump) and the `-S` selector were not run against a real download, since no media was downloaded for this note.
- The wording of geo-block, 429 and disk-full messages comes from source and README, not from live reproduction.
