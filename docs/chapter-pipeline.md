# Chapter auto-generation pipeline

Decided in [issue #16](https://github.com/IncoherentThoughts/TuvaVideos/issues/16), building on the research in #5 (fetch command, timestamp parser spec, comment selection rule). Terms: Chapter, Suggested, YouTube info, Song matcher in `CONTEXT.md`.

## Two stages, one online

1. **Fetch** (`scripts/`, the only thing that touches the network): for each eligible Video, one yt-dlp call per the #5 TL;DR (`--skip-download --write-info-json --write-comments`, `max_comments=200,200,0,0`, `comment_sort=top`, `--sleep-requests 1`, 5 s between Videos) writes `<id>.info.json` (the **YouTube info**) into a cache directory outside the app. Resumable; an id already cached is skipped unless forced. A second pass with `max-replies-per-thread=5` runs only for Videos where stage 2 found no block.
2. **Suggest** (in the app, offline, re-runnable): reads the YouTube info cache plus the Mirror's Performances, parses, matches Songs and writes Suggested Chapters.

**Eligible Videos**: Type concert, plus any Video with a YouTube id longer than 20 min whatever its Type, plus an explicit id list for one-offs.

## Sources and precedence

- **Description block** (parser from #5, ≥3 ascending entries). If it yields a block, comments are ignored.
- **Best comment block**, only when the description yields nothing: among the fetched comments whose text parses to ≥3 ascending entries, pinned or uploader first, then most likes, then most entries.
- **Performance offsets**: every Mirror Performance for the Video's id that carries a `t=` becomes a Suggested Chapter with the Song attached and the Song's name as title. When a text Chapter lies within ±15 s of it, the two merge: the text supplies time and title, the Performance supplies the Song.
- yt-dlp's `chapters` field is **not used** (AI topic labels, no provenance).
- No untitled Chapter is created at 0:00 when a block starts later; the stretch before the first Chapter is just the Video's start.
- Every Chapter written is Suggested with `source` = `description` / `comment` / `performance`.

## Song matcher

Attaches a Mirror Song to a text Chapter by title. Both sides are folded first: NFKD, strip diacritics, casefold, Cyrillic → Latin through the project's transliteration table, ŋ → ng, x and kh folded together, parentheticals and punctuation dropped. Similarity is Jaro-Winkler on the folded strings, two tiers:

| Candidate set | Accept at |
|---|---|
| Songs the Video's id links to through Performances | ≥ 0.80 |
| Whole Mirror | ≥ 0.90 |

Thresholds are to be tuned on the 20-Video sample from #5. **Near-tie** (best not ahead of the runner-up by ≥ 0.05): attach no Song, and the run reports the tie so the person driving that session decides. Any attached Song is Suggested.

## Review

Suggested Chapters show in the Now-playing chapter strip with the Suggested mark. Each card: confirm, reject, attach Song. Per Video: confirm all. (Placement and naming of manual Chapters is still open in the map.)

## Re-runs

- Suggested Chapters from the same source on the same Video are replaced wholesale.
- A new suggestion within ±10 s of a confirmed or manual Chapter is dropped.
- A rejection is remembered in `chapter_rejection(video_id, source, start_s)`; a suggestion matching a tombstone (same source, within ±10 s) never returns.
