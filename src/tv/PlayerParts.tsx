// The Player's pieces (docs/tv-spec.md 6.1, 6.2, 6.5): the standalone lyrics column with its living backdrop, and the
// vertical list the Chapters and the Copies share. Presentation only; the Player owns the state.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"
import { SCRIPTS } from "../shared/lyrics/scripts"
import type { StripDto } from "../shared/types"
import { url } from "./data"
import { Glow } from "./glow"
import { LYR_SIZE, LYR_SIZE_MIN, clampPage, fitLyrics, pageLabel, paginate, type LyricsView } from "./lyrics"
import { listOffset } from "./osd"

export interface LyricsCtl {
  page(dir: 1 | -1): void
}

const cssPx = (el: HTMLElement, name: string, fallback: number): number => {
  const v = parseFloat(getComputedStyle(el).getPropertyValue(name))
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * The poster blurred and drifting, four blobs in its sampled hues, vignette, tint and grain (spec 6.2); with a scrub
 * strip the frame underneath and the blobs follow the playhead, crossfading slowly (glow.ts).
 */
function Backdrop({ poster, strip, durationS, at }: { poster: string | null; strip: StripDto | null; durationS: number | null; at: number }) {
  const root = useRef<HTMLDivElement>(null)
  const glow = useRef<Glow | null>(null)
  const time = useRef(at)
  time.current = at
  useEffect(() => {
    const g = (glow.current = new Glow(root.current!, () => time.current))
    g.follow(strip, strip ? url(strip.url) : null, durationS)
    return () => g.stop()
  }, [strip?.url, durationS])
  return (
    <div class="glow" ref={root} aria-hidden="true">
      <div class="drift">
        {poster && <img src={poster} crossOrigin="anonymous" alt="" onLoad={(e) => glow.current?.poster(e.currentTarget as HTMLImageElement)} />}
        <canvas />
        <canvas />
      </div>
      {[1, 2, 3, 4].map((n) => (
        <i key={n} class={`blob b${n}`}>
          <b class="on" />
          <b />
        </i>
      ))}
      <div class="vig" />
      <div class="tint" />
      <div class="grain" />
    </div>
  )
}

/**
 * The lyrics column: Song title (a "local" pill beside it, the English name under it), Version pills, one Script, the lines without numbers, "page n of m".
 * Sized to its longest line measured unwrapped: 720 to 1060 px, the type 44 px (`--lyr-size`) shrinking to 34 px first.
 */
export function LyricsColumn({
  view,
  poster,
  strip,
  durationS,
  at,
  ctl,
}: {
  view: LyricsView
  poster: string | null
  strip: StripDto | null
  durationS: number | null
  /** The playhead, which the backdrop's colours follow. */
  at: number
  ctl: { current: LyricsCtl | null }
}) {
  const root = useRef<HTMLElement>(null)
  const lines = useRef<HTMLDivElement>(null)
  const starts = useRef<number[]>([0])
  const [pg, setPg] = useState({ page: 0, pages: 1 })

  const showPage = (n: number) => {
    const l = lines.current
    const page = clampPage(n, starts.current.length)
    if (l) l.scrollTop = starts.current[page] ?? 0
    setPg({ page, pages: starts.current.length })
  }

  const layout = () => {
    const r = root.current
    const l = lines.current
    if (!r || !l) return
    const base = cssPx(r, "--lyr-size", LYR_SIZE)
    const floor = cssPx(r, "--lyr-size-min", LYR_SIZE_MIN)
    l.style.whiteSpace = "nowrap"
    l.style.fontSize = `${base}px`
    let widest = 0
    l.querySelectorAll<HTMLElement>(".tx").forEach((x) => (widest = Math.max(widest, x.offsetWidth)))
    const fit = fitLyrics(widest, base, floor)
    l.style.fontSize = `${fit.fontPx}px`
    r.style.width = `${fit.widthPx}px`
    l.style.whiteSpace = ""
    const items = [...l.children].map((c) => ({ top: (c as HTMLElement).offsetTop, height: (c as HTMLElement).offsetHeight, blank: c.classList.contains("sp") }))
    starts.current = paginate(items, l.clientHeight)
    showPage(0)
  }

  useLayoutEffect(layout, [view.songName, view.versionIdx, view.script, view.lines])
  useEffect(() => {
    void (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready.then(layout)
  }, [])

  ctl.current = { page: (dir) => showPage(pg.page + dir) }
  useEffect(() => () => void (ctl.current = null), [])

  const tryHint = pageLabel(pg.page, pg.pages)
  return (
    <aside class="pl-lyr" ref={root} lang={view.lang} aria-label="Lyrics">
      <Backdrop poster={poster} strip={strip} durationS={durationS} at={at} />
      <div class="hd">
        <h2>
          <span class="nm">{view.songName}</span>
          {view.local && <span class="loc">local</span>}
        </h2>
        {view.englishName && <div class="en">{view.englishName}</div>}
        {view.versions.length > 1 && (
          <div class="pills">
            {view.versions.map((v, i) => (
              <span key={v.id} class={`pill${i === view.versionIdx ? " on" : ""}`}>
                {v.label}
              </span>
            ))}
          </div>
        )}
        <div class="scripts">
          {SCRIPTS.map((s) => (
            <span key={s.key} class={s.key === view.script ? "on" : view.present.includes(s.key) ? "" : "off"}>
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <div class="lines" ref={lines}>
        {view.lines.length === 0 && <p class="none">This Version has no text</p>}
        {view.lines.map((l, i) =>
          l.blank ? (
            <div class="sp" key={i} />
          ) : (
            <p class="ln" key={i}>
              <span class="tx" dangerouslySetInnerHTML={{ __html: l.html }} />
            </p>
          ),
        )}
      </div>
      <div class="pager">{tryHint}</div>
    </aside>
  )
}

export interface ListRow {
  key: string | number
  /** Left column (time, or the Root). */
  lead: string
  title: string
  /** After the title: a note, or the dashed "suggested" mark, or "via remux". */
  marks: { text: string; cls: string }[]
  current: boolean
  focused: boolean
  dim: boolean
}

export const LIST_ROW_H = 64
export const LIST_VIEW_H = 704

/** The vertical list over the video's left edge: the Chapters and the Copies (spec 6.5). */
export function PlList({ title, rows, focus }: { title: string; rows: ListRow[]; focus: number }) {
  const off = listOffset(focus, LIST_ROW_H, LIST_VIEW_H, rows.length)
  return (
    <div class="pl-list">
      <h3>{title}</h3>
      <div class="rows" style={{ height: `${LIST_VIEW_H}px` }}>
        <div class="rows-in" style={{ transform: `translateY(${-off}px)` }}>
          {rows.map((r) => (
            <div key={r.key} class={`cr${r.current ? " cur" : ""}${r.focused ? " f" : ""}${r.dim ? " dim" : ""}`}>
              <span class="mono">{r.lead}</span>
              <span class="ct">{r.title}</span>
              {r.marks.map((m) => (
                <span key={m.text} class={m.cls}>
                  {m.text}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
