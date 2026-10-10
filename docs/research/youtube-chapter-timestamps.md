# Song timestamps for full-concert videos from YouTube

Research for issue #5 (part of map #1). Question: how can a one-off offline batch script get song-level **Chapters** for concert **Videos** from YouTube, and how often does each route give a usable result? Researched 2026-10-10 with yt-dlp 2026.08.19.

## TL;DR

- One yt-dlp call per Video covers all three routes: `yt-dlp --skip-download --write-info-json --write-comments --extractor-args "youtube:max_comments=200,200,0,0;comment_sort=top" -- <id>`. The `.info.json` holds `chapters`, `description` and `comments`. That run took about 15 s per Video with no throttling.
- **The YouTube Data API is not needed.** It has no chapters field and would only add an API key and quota. yt-dlp already returns the same description and comments.
- In a sample of 20 long concert-style Videos, **viewer comments** were by far the best source, giving song timestamps for **13/20**. **Description chapters** gave only **2/20**. The union of usable song-level routes covered **14/20 (70%)**.
- Do not trust yt-dlp's `chapters` field blindly. It mixes creator chapters, YouTube's AI-generated topic chapters ("Introduction to Alash", "Nomadic traditions") and noise. 3 of its 8 non-empty results were AI topic chapters, which are not song-level.
- Everything parsed from comments or descriptions should land as **Suggested** Chapters (see CONTEXT.md), because comment timestamps are a few seconds off and sometimes incomplete.

## 1. Chapters and description via `--write-info-json`

- `--write-info-json` writes "video metadata to a .info.json file". `--skip-download` means "Do not download the video but write all related files". Source: [yt-dlp README, options](https://github.com/yt-dlp/yt-dlp/blob/master/README.md#filesystem-options).
- The YouTube extractor fills `info['chapters']` from the first of three sources that yields results ([`yt_dlp/extractor/youtube/_video.py`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py), `_real_extract`):
  1. `_extract_chapters_from_json`, the player bar's `chapteredPlayerBarRenderer.chapters`. These are the chapters YouTube shows, including automatically generated ones.
  2. `_extract_chapters_from_engagement_panel`, the "key moments" `macroMarkersListRenderer` panel.
  3. `_extract_chapters_from_description`, yt-dlp's own regex over the description ([`common.py`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/common.py)). The regex is `^\s*((?:\d+:)?\d{1,2}:\d{2})\b\W*\s(.+?)\s*$`, with a fallback for title-then-time. It keeps entries whose start times are ascending and at most the duration, and it applies **no minimum count**. So a single line "- music begins at 3:07" becomes 2 chapters, an untitled one at 0 and one titled "- music begins at" (seen on `BwsYKdPmEl8`).
- So `chapters` cannot tell you where it came from. To get "description chapters" reliably, parse `description` yourself with the spec below.
- YouTube's own rule for description chapters: the first timestamp must be `00:00`, there must be at least three timestamps in ascending order, and each chapter must be at least 10 seconds long ([YouTube Help: video chapters](https://support.google.com/youtube/answer/9884579)). The parser below uses ≥3 ascending lines and does **not** require a 00:00 start, because concert setlists usually begin at the first song, not at 0:00.

## 2. Viewer comments via `--write-comments`

- `--write-comments` means "Retrieve video comments to be placed in the infojson" ([README](https://github.com/yt-dlp/yt-dlp/blob/master/README.md#filesystem-options)).
- Extractor args ([README, youtube extractor arguments](https://github.com/yt-dlp/yt-dlp/blob/master/README.md#youtube)):
  - `max_comments` is `max-comments,max-parents,max-replies,max-replies-per-thread,max-depth`, and every value defaults to `all`.
  - `comment_sort` is `top` or `new`, and the default is `new`. **Use `top`.** A timestamp comment with many likes rises to the top, and on `i0djHJBAP3U` it had 1,500 likes.
- Each comment has `text`, `like_count`, `author_is_uploader`, `is_pinned` and `parent` ([`_video.py` `_extract_comment`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py)).
- **Selection rule.** Among comments whose text parses to ≥3 ascending timestamp lines, prefer pinned or uploader comments first, then the highest `like_count`, then the most entries.
- **Replies.** The sample fetched no replies (`max-replies=0`). One comment (`mFuwzH7lnJY`) said "Rest are in replies", so a later pass with `max-replies-per-thread` of about 5 would pick those up. It would cost a request per thread.

## 3. Is the YouTube Data API needed? No.

- The `videos` resource has **no chapters field**. Its snippet has only `title`, `description` and similar fields, and the docs say chapters come from timestamps in the description ([videos resource](https://developers.google.com/youtube/v3/docs/videos)). The API therefore can't see YouTube's auto-generated chapters, and yt-dlp can.
- `commentThreads.list` costs 1 quota unit per call, with at most 100 results per page ([commentThreads.list](https://developers.google.com/youtube/v3/docs/commentThreads/list)). The default quota is 10,000 units per day ([Getting started](https://developers.google.com/youtube/v3/getting-started)). Quota would be enough for the library, but the API adds a Google Cloud project and an API key and returns nothing yt-dlp doesn't.
- Use it only as a fallback if yt-dlp's comment extraction breaks.

## 4. Rate limits and runtime

- The yt-dlp wiki gives the guest-session limit as roughly 300 videos per hour, and roughly 2,000 per hour with an account. It recommends a 5–10 s delay between downloads ([yt-dlp wiki, Extractors → YouTube](https://github.com/yt-dlp/yt-dlp/wiki/Extractors)). PO tokens are discussed there for downloading formats, not for metadata.
- Observed: 20 Videos with `--sleep-requests 0.75` and a 3 s gap between Videos took **295 s of yt-dlp time**, between 12.5 and 23 s per Video, with comments capped at 200. There were no errors, warnings or 429s. The output was 8.2 MB of info JSON.
- For the full library (about 1,050 files with YouTube ids, fewer than that being concerts), use these settings:
  - Run only on Videos of Type concert, or on Videos longer than about 20 min.
  - Use `--sleep-requests 1` with a 5 s gap between Videos.
  - Cache the `.info.json` files so the script can resume.
  - Expect about 20 s per Video, so 200 concerts take about 70 min.

## 5. Timestamp-line parser spec

Reference implementation and tests: below, and as run in the sample. The input is a text blob (a description or a comment) plus the Video's duration. The output is a list of `(start_seconds, title)` or nothing.

**Timestamp token.** `TS = (?:(\d{1,2}):)?(\d{1,2}):(\d{2})`
- This accepts `0:00`, `12:34`, `1:02:33` and zero-padded `00:00:19`.
- Reject the token if seconds ≥ 60, or if minutes ≥ 60 when an hour part is present.
- The token may be wrapped in `[ ]` or `( )`. A trailing `ish`, as in `7:50ish`, is tolerated.

**Line forms**, tried in this order on each line after splitting on `\n`:
1. **Leading timestamp.** `^\s*(N[.)]\s+)? [TS] ( [-–—] [TS] )? \s* SEP? \s* TITLE?$`
   - An optional list number comes before the timestamp ("3. 10:00 Song").
   - An optional range end is ignored, so `0:00 - 4:12 Song` takes the start.
   - `SEP` is any one of `- – — | : • · ~ > » /`.
2. **Trailing timestamp.** `^\s*(N[.)]\s+)? TITLE \s* SEP? \s* [TS]\s*$`, for example `Kongurei | 4:05` or `Kongurei 4:05`.

A line that matches neither form is ignored. That includes headers such as "Timestamps" and lines with a timestamp in the middle of prose, such as "Начало 6 июля в 18:00".

**Title cleanup.**
- Strip surrounding whitespace and `- – — | : • · ~ " ' « » “ ”`.
- Then strip a leading list number, so `00:00 01. Aidym tider` becomes "Aidym tider".
- The title may be empty. Keep the entry and leave the title for the user.

**In-line extra timestamps.** If a title contains `\s[+,;/&]?\s*TS\s+\S`, split there into a further entry. For example, `5:36 Mörgül + 8:20 Öske Cherde` becomes (336, Mörgül) and (500, Öske Cherde).

**Single-line lists.** If fewer than 3 lines parse, look for a line holding ≥3 timestamps, such as `0:00 A 3:10 B 7:45 C`. Split it on the timestamps.

**Block acceptance.**
- Drop entries whose start time is greater than the duration.
- Split the remaining entries into strictly ascending runs.
- Keep the longest run, and accept it only if it has **≥3 entries**.
- This discards trailing notes such as `28:17 - Rare occurrence of…` after a setlist, and stray out-of-order lines.

**Classification of the result.**
- *Description chapters*: an accepted description block whose first entry is `0`, which is YouTube's own rule.
- *Description timestamp lines*: any accepted description block.
- *Comment timestamp lines*: an accepted block in a comment, chosen by the selection rule in section 2.

**Not handled on purpose.**
- Bare seconds (`95s`) and `1h02m33s`. Neither appeared in the sample.
- Timestamps given as links. yt-dlp's `text` is plain text, so these come through as `1:02:33` anyway.

<details><summary>Reference implementation (Python, ~70 lines)</summary>

```python
import re
TS = r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})"
SEP = r"[-–—|:•·~>»/]"
LEAD = re.compile(r"^\s*(?:\d{1,2}[.)]\s+)?[\[(]?" + TS + r"(?:ish)?[\])]?"
                  r"(?:\s*[-–—]\s*[\[(]?" + TS + r"[\])]?)?\s*(?:" + SEP + r"\s*)?(?P<title>\S.*?)?\s*$")
TRAIL = re.compile(r"^\s*(?:\d{1,2}[.)]\s+)?(?P<title>\S.*?)\s*(?:" + SEP + r"\s*)?[\[(]?" + TS + r"[\])]?\s*$")
INLINE = re.compile(r"[\[(]?" + TS + r"[\])]?")
MID = re.compile(r"\s(?:[+,;/&]\s*)?" + TS + r"\s+(?=\S)")

def secs(h, m, s):
    h, m, s = int(h or 0), int(m), int(s)
    return None if s >= 60 or (h and m >= 60) else h * 3600 + m * 60 + s

def clean(t):
    t = (t or "").strip().strip("-–—|:•·~\"'«»“”").strip()
    return re.sub(r"^\d{1,2}[.)]\s+", "", t)

def expand(entry):
    t, title = entry; out, last, cur = [], 0, t
    for m in MID.finditer(title):
        mt = secs(*m.group(1, 2, 3))
        if mt is None: continue
        out.append((cur, clean(title[last:m.start()]))); cur, last = mt, m.end()
    return out + [(cur, clean(title[last:]))]

def parse_line(line):
    m = LEAD.match(line)
    if m and (t := secs(*m.group(1, 2, 3))) is not None:
        return t, clean(m.group("title"))
    m = TRAIL.match(line)
    if m and (t := secs(*m.groups()[-3:])) is not None:
        return t, clean(m.group("title"))
    return None

def parse_block(text, duration):
    lines = (text or "").replace("\r", "").split("\n")
    entries = [x for e in map(parse_line, lines) if e for x in expand(e)]
    if len(entries) < 3:
        for l in lines:
            ms = list(INLINE.finditer(l))
            if len(ms) >= 3:
                cand = [(secs(*mm.groups()), clean(l[mm.end():(ms[i+1].start() if i+1 < len(ms) else len(l))]))
                        for i, mm in enumerate(ms)]
                cand = [c for c in cand if c[0] is not None]
                if len(cand) > len(entries): entries = cand
    run, best = [], []
    for t, title in entries:
        if duration and t > duration: continue
        if run and t <= run[-1][0]: best = max(best, run, key=len); run = []
        run.append((t, title))
    best = max(best, run, key=len)
    return best if len(best) >= 3 else []
```
</details>

Test cases that passed:

| Input | Result |
|---|---|
| `0:00 Intro` | (0, "Intro") |
| `12:34 - Song Name` | (754, "Song Name") |
| `1:02:33 – Чашпы-Хем` | (3753, …) |
| `Kongurei \| 4:05` and `Kongurei 4:05` | (245, "Kongurei") |
| `[00:12] Ezir-Kara` | (12, "Ezir-Kara") |
| `3. 10:00 Song` | (600, "Song") |
| `0:00 - 4:12 Song A` | (0, "Song A") |
| `7:50ish - Ko'sh Oi` | (470, …) |
| `00:00 01. Aidym tider` | (0, "Aidym tider") |
| `00:00:19 - Prayer, Oske Cherde` | (19, …) |
| `05:61 bad` | rejected |
| A block with a stray out-of-range line | longest ascending run kept |
| A block of 2 lines | rejected |

## 6. Empirical sample (20 Videos)

**How the 20 were chosen.**
- Files in `/Volumes/General/хөөмей/Хөөмей` (Batches 1–5) were filtered on the `[id]` suffix and on concert, live, full, album, part, концерт, часть or фестиваль in the name. That left 172 files.
- Durations came from `ffprobe`. The sample is the **20 longest unique ids**, all between 45 min and 4.9 h.

**What was fetched.** `--skip-download --write-info-json --write-comments`, with `max_comments=200,200,0,0` and `comment_sort=top`. That is at most 200 top-level comments and no replies.

**Column key.**
- *yt-dlp ch.*: the length of the `chapters` field, with its kind.
- *Desc ch.*: description block starting at 0:00 (YouTube-native).
- *Desc lines*: any accepted description block.
- *Comment*: entries in the best comment block, with likes.

| Video | Duration | yt-dlp ch. | Desc ch. | Desc lines | Comments fetched | Comment block (likes) | Song-level? |
|---|---|---|---|---|---|---|---|
| DXZb7sWNl6I Muzyka Bodhi festival | 4:54:54 | 0 | – | – | 15 | – | no |
| jysOpkZuolM HHT Bremen 2021 | 1:37:06 | 0 | – | – | 110 | 13 (79) | comment |
| ZBFpZOO_Vo8 Tyva, Krasnoyarsk 2013 | 1:29:07 | 0 | – | – | 86 | 21 (3) | comment |
| 9tahGJ-qWbE HHT Kazan | 1:27:38 | 0 | – | – | 54 | 14 (1) | comment |
| q-VjE-Xg414 Alash Ensemble Concert | 1:20:43 | 10 (AI topics) | – | – | 1 | – | no |
| MEdd76AsPE0 Alash Chicago 10th anniv. | 1:20:38 | 8 (AI topics) | – | – | 67 | 17 (61, pinned) | comment |
| i0djHJBAP3U HHT Live Berkeley | 1:18:44 | 12 (song titles, not in desc) | – | – | 200 (cap) | 13 (1,500) | comment + chapters |
| udzKy_PbgiU HHT Dom 2014 | 1:16:04 | 0 | – | – | 8 | 13 (4) | comment |
| JQtXapsDAAM Alash Ufa 2018 | 1:13:31 | 0 | – | – | 11 | 15 (8) | comment |
| _ukoRafHXUg Radik Tyulyush Omsk 2023 | 1:13:26 | 0 | – | – | 15 | 12 (13) | comment |
| BwsYKdPmEl8 Alash UChicago | 1:09:07 | 2 (noise) | – | – | 5 | 13 (11) | comment |
| jNfINH603q0 Ross Daly & HHT, White Dragon | 1:09:04 | 0 | – | – | 20 | – | no |
| mFuwzH7lnJY Alash, Creative Alliance | 59:48 | 4 (AI topics) | – | – | 8 | 9 (8), rest in replies | comment (partial) |
| pOAuR_UdA-U Oidupaa, Divine Music | 58:18 | 18 (desc) | 18 | 18 | 175 | 18 (10) | desc + comment |
| sv8476-unos Ulger, Aidym | 57:29 | 0 | – | – | 4 | 17 (2) | comment |
| EIyKvHqk9Jg Tyva, Karavan | 53:33 | 0 | – | – | 6 | – | no |
| mhlkFozL44w Alash, part 1 | 52:33 | 0 | – | – | 1 | 9 (1) | comment |
| 7yHpkp0QtmY Tyva, Shag Chaagai | 49:21 | 0 | – | – | 11 | – | no |
| KY-6x6ygwK8 HHT, 60 Horses | 47:38 | 12 (desc) | 12 | 12 | 50 | – | desc |
| wVUMSazQL9U Zappa Salad Party w/ HHT | 45:44 | 7 (desc, starts 00:06) | – | 6 (scene notes) | 16 | – | no (not songs) |

**Share by route (n=20).**

| Route | Any result | Song-level |
|---|---|---|
| yt-dlp `chapters` non-empty | 8/20 (40%) | 3/20 (15%) |
| Description chapters (≥3, start 0:00) | 2/20 (10%) | 2/20 (10%) |
| Description timestamp lines (≥3, any start) | 3/20 (15%) | 2/20 (10%) |
| Comment timestamp lines (≥3) | 13/20 (65%) | 13/20 (65%) |
| **Union, song-level** | | **14/20 (70%)** |

**Observations.**
- Uploaders of these concert recordings almost never post setlists. The fans do. Every comment block came from a non-uploader, and only 1 of the 13 was pinned.
- yt-dlp `chapters` without description timestamps are YouTube's generated chapters. On 3 Videos they are AI topic labels and useless for songs. On `i0djHJBAP3U` the 12 song titles match the top comment, but the start times differ by 2–5 s, so YouTube seems to derive some of these from comments. **Treat `chapters` as song-level only when they agree with a description or comment block.**
- Comment timestamps are hand-typed. Expect ±5 s error and titles in mixed scripts (Cyrillic and Latin) and spellings. The titles still need matching to Mirror Songs, which is a separate matcher.
- Duplicate comment blocks are common: `i0djHJBAP3U` has two near-identical ones. The selection rule picks the most-liked.
- In 6/20 nothing usable was found. The yield on shorter or less-watched concerts is probably lower than this long, popular-skewed sample suggests.

## Recommendation for the batch script

1. For each concert-like Video with a YouTube id, run the one yt-dlp command from the TL;DR. Use `--sleep-requests 1` and a 5 s gap, and cache `<id>.info.json` in a scratch directory outside the app.
2. Priority:
   1. Parse the description. If it yields a block, use it.
   2. Otherwise use the best comment block.
   3. Otherwise use `chapters` only if they are not obviously generic. Store them low-confidence or skip them.
3. Emit every result as **Suggested** Chapters with their source (`description` / `comment:<id>` / `youtube-chapters`) so the user can confirm or reject them.
4. No Data API, no API key. The app itself stays offline. Only this one-off script touches the network.
