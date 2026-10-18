// What the OSD says (docs/tv-spec.md 6.6): the current Chapter and its span, "Next:" in the last 20 s, the Resume marker,
// the scrub bar's ticks. Pure.
import { fmtClock } from "../shared/playerMath"
import { chapterAt } from "../shared/lyrics/target"

export const OSD_FADE_MS = 3000
/** "Next:" shows in the last 20 s of the Chapter or Playlist Entry. */
export const NEXT_WITHIN_S = 20

export interface OsdChapter {
  id: string
  startS: number
  title: string
}

/** The current Chapter's line: "title · 12:03–18:40". Empty before the first Chapter or without Chapters. */
export function chapterLine(chapters: readonly OsdChapter[], t: number, durationS: number | null): string {
  const c = chapterAt(chapters, t)
  if (!c) return ""
  let end = durationS
  for (const x of chapters) if (x.startS > c.startS && (end == null || x.startS < end)) end = x.startS
  return `${c.title || "untitled"} · ${fmtClock(c.startS)}–${end == null ? "?" : fmtClock(end)}`
}

export interface NextCtx {
  t: number
  durationS: number | null
  chapters: readonly OsdChapter[]
  /** The active Playlist's Entry end (a Chapter Entry's end, else the Video's) and the title of the next Entry; null without one. */
  entry?: { end: number | null; nextTitle: () => string | null } | null
}

/**
 * The "Next: ‹title›" text: in the last 20 s of the current Playlist Entry the next Entry; otherwise, in the last 20 s
 * of a Chapter that has a next one, that Chapter. Null when nothing is due.
 */
export function nextUp(x: NextCtx): string | null {
  if (x.entry) {
    const end = x.entry.end ?? x.durationS
    if (end == null || end - x.t > NEXT_WITHIN_S || end - x.t < 0) return null
    const title = x.entry.nextTitle()
    return title ? `Next: ${title}` : null
  }
  const c = chapterAt(x.chapters, x.t)
  if (!c) return null
  const next = [...x.chapters].filter((y) => y.startS > c.startS).sort((a, b) => a.startS - b.startS)[0]
  if (!next) return null
  return next.startS - x.t <= NEXT_WITHIN_S ? `Next: ${next.title || "untitled"}` : null
}

/** A position as a percentage of the duration, clamped 0..100 (the scrub bar's fill and its ticks). */
export const pct = (t: number, durationS: number | null): number => (durationS && durationS > 0 ? Math.max(0, Math.min(100, (t / durationS) * 100)) : 0)

/** How far a vertical list scrolls so that `row` sits in the middle of the view (0 while the list is shorter or the row is near the top). */
export function listOffset(row: number, rowH: number, viewH: number, count: number): number {
  const max = Math.max(0, count * rowH - viewH)
  return Math.max(0, Math.min(max, (row + 0.5) * rowH - viewH / 2))
}

/** Is the OSD up? Awake within 3 s of the last key, paused, or a zone open. */
export function osdVisible(o: { now: number; wokeAt: number; paused: boolean; zonePinned: boolean }): boolean {
  return o.paused || o.zonePinned || o.now - o.wokeAt < OSD_FADE_MS
}
