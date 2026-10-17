// What the TV's lyrics column shows (docs/tv-spec.md 6.1): which Song and Version, one Script at a time, the lines
// without numbers or footnote markers, and the column's size from its longest line. Pure.
import { numberLines, parseHtmlToLines } from "../shared/lyrics/normalize"
import { SCRIPTS, effectiveScript, presentScripts } from "../shared/lyrics/scripts"
import { chapterAt, lyricsTarget, type LyricsTarget } from "../shared/lyrics/target"
import { openingVersionIndex } from "../shared/lyrics/trackVersion"
import type { ScriptKey } from "../shared/lyrics/types"
import type { ChapterDto, SongDto, VideoDto } from "../shared/types"

// ---- the column's size ----

/** Type size at 3 m: 44 px with 10 to 12 lines visible is the starting value, tuned on the TV (spec 6.1). The Player reads
 *  the CSS variable `--lyr-size` (src/tv/styles.css) as the base and `--lyr-size-min` as the floor; these are the fallbacks. */
export const LYR_SIZE = 44
export const LYR_SIZE_MIN = 34
/** The column's width bounds and where the type starts shrinking, in px. */
export const LYR_W_MIN = 720
export const LYR_W_WIDE = 900
export const LYR_W_MAX = 1060
/** Horizontal padding of the column (both sides) plus slack, so the longest line is not flush against it. */
export const LYR_PAD = 64 + 64
export const LYR_SLACK = 8

export interface LyricsFit {
  fontPx: number
  widthPx: number
}

/**
 * The column's type size and width from its longest line measured unwrapped at the base size. Up to 900 px the type stays
 * at the base and the column is only as wide as needed (never under 720); past 900 px the type shrinks first, down to
 * the floor, and only then does the column widen, to at most 1060 px; lines wrap only beyond both limits.
 */
export function fitLyrics(widestAtBase: number, base = LYR_SIZE, floor = LYR_SIZE_MIN): LyricsFit {
  const min = Math.min(floor, base)
  let w = Math.max(0, widestAtBase)
  let fontPx = base
  if (w > 0 && w + LYR_PAD > LYR_W_WIDE) {
    fontPx = Math.max(min, Math.min(base, Math.floor((base * (LYR_W_WIDE - LYR_PAD)) / w)))
    w = (w * fontPx) / base
  }
  return { fontPx, widthPx: Math.max(LYR_W_MIN, Math.min(LYR_W_MAX, Math.round(w + LYR_PAD + LYR_SLACK))) }
}

// ---- what is shown ----

/** A footnote marker is a superscript; the TV has no tooltips, so the lines carry none. */
export const stripMarkers = (html: string): string => html.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, "")

export interface LyricLineView {
  blank: boolean
  html: string
}

export interface LyricsView {
  songName: string
  englishName: string | null
  local: boolean
  versions: { id: string; label: string; local: boolean }[]
  versionIdx: number
  present: ScriptKey[]
  /** The Script shown, null when the Version has no text at all. */
  script: ScriptKey | null
  lang: string
  lines: LyricLineView[]
}

/** The Song and Version in view for a Script preference. `lines` is empty when the Song has no lyrics. */
export function lyricsView(song: SongDto, versionId: string | null, pref: ScriptKey): LyricsView {
  const versionIdx = openingVersionIndex(song.versions, versionId)
  const version = song.versions[versionIdx]
  const present = presentScripts(version ? { cyrillic: version.scripts.cyrillic.html, transliteration: version.scripts.transliteration.html, translation: version.scripts.translation.html } : null)
  const script = present.length ? effectiveScript(pref, present) : null
  const html = version && script ? version.scripts[script].html : ""
  return {
    songName: song.name,
    englishName: song.englishName,
    local: song.local,
    versions: song.versions.map((v) => ({ id: v.id, label: v.label, local: v.local })),
    versionIdx,
    present,
    script,
    lang: SCRIPTS.find((s) => s.key === script)?.lang ?? "tyv",
    lines: numberLines(parseHtmlToLines(html)).map((l) => ({ blank: l.blank, html: l.blank ? "" : stripMarkers(l.html) })),
  }
}

/** Blue: the next Script the Version has, wrapping; the same one when it has only one. */
export function nextScript(present: readonly ScriptKey[], current: ScriptKey | null): ScriptKey | null {
  if (!present.length) return null
  const i = current ? present.indexOf(current) : -1
  return present[(i + 1) % present.length]!
}

export interface PageItem {
  top: number
  height: number
  blank: boolean
}

/**
 * The scroll offset of each page: a page holds whole lines (and spacers) that fit in `viewH`, the next page starts at
 * the first line that did not, and a spacer never starts a page. A line taller than the view gets a page of its own.
 */
export function paginate(items: readonly PageItem[], viewH: number): number[] {
  const starts: number[] = []
  let i = 0
  while (i < items.length) {
    while (i < items.length && items[i]!.blank) i++
    if (i >= items.length) break
    const top = items[i]!.top
    starts.push(top)
    let j = i
    while (j < items.length && items[j]!.top + items[j]!.height - top <= viewH) j++
    i = Math.max(j, i + 1)
  }
  return starts.length ? starts : [0]
}

/** "page n of m" at the foot, or empty for a single page. */
export const pageLabel = (page: number, pages: number): string => (pages > 1 ? `page ${page + 1} of ${pages}` : "")

/** The page `n` clamped to what exists. */
export const clampPage = (n: number, pages: number): number => Math.max(0, Math.min(Math.max(1, pages) - 1, n))

// ---- the Song the playhead is in ----

/** The Chapter the playhead is in and the Song to show: that Chapter's, else the Video's (spec 6.1). */
export function songTarget(chapters: readonly ChapterDto[], t: number, video: Pick<VideoDto, "songId" | "versionId">): { chapter: ChapterDto | null; target: LyricsTarget | null } {
  const chapter = chapterAt(chapters, t)
  return { chapter, target: lyricsTarget(chapter, video) }
}

/** Why the lyrics zone has nothing to pull in (null: there are lyrics, or they are still loading). */
export function noLyricsReason(target: LyricsTarget | null, song: SongDto | null | undefined): string | null {
  if (!target) return "This Video has no Song"
  if (song === undefined) return null // loading
  if (song === null) return "The Song did not load"
  if (!song.versions.some((v) => presentScripts({ cyrillic: v.scripts.cyrillic.html, transliteration: v.scripts.transliteration.html, translation: v.scripts.translation.html }).length)) return `${song.name} has no lyrics`
  return null
}
