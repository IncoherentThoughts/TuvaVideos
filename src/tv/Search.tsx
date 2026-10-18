// Search (docs/tv-spec.md 7): the D-pad keyboard on the left, results on the right from /api/search grouped
// Songs / Videos / Artists. A physical keyboard types too. Right at the keyboard's edge reaches the results; Back
// from the results returns to the keyboard, Back again leaves Search.
import { useEffect, useMemo, useRef, useState } from "preact/hooks"
import { highlightHtml } from "../shared/fold"
import type { SearchResponse, SearchRow } from "../shared/types"
import { fmtDuration } from "../web/ui"
import { api } from "./data"
import { findByKey, focusEl, itemsIn, moveFocus, nearestByY, keyOf, zoneOf } from "./focus"
import { useKeyHandler } from "./input"
import { LAYERS, layerKeys, pressKey, typeChar, KEY_COLUMNS, type KbKey, type KbState } from "./keyboard"
import { playingFromRows, resultRows, startPlaylistOf, type ResultRow } from "./searchRows"
import { useScreen, type Nav } from "./screen"

const DEBOUNCE_MS = 220

interface Mem {
  kb?: KbState
  res?: SearchResponse | null
}

export function Search({ nav, active, mem }: { nav: Nav; active: boolean; mem: Record<string, unknown> }) {
  const m = mem as Mem
  const [kb, setKb] = useState<KbState>(m.kb ?? { text: "", layer: "latin" })
  const [res, setRes] = useState<SearchResponse | null>(m.res ?? null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const ac = useRef<AbortController | undefined>(undefined)
  m.kb = kb
  m.res = res

  const { root, onFocusIn, ensure } = useScreen(active, true, (r) => findByKey(r, "kb-0"))

  // The query changed: ask the server after a pause; a newer keystroke abandons the older request.
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      if (res) return // coming back from the Player: the results are still here
    }
    clearTimeout(timer.current)
    ac.current?.abort()
    const q = kb.text.trim()
    if (!q) {
      setRes(null)
      setBusy(false)
      setFailed(false)
      return
    }
    setBusy(true)
    timer.current = setTimeout(() => {
      const c = (ac.current = new AbortController())
      api
        .search(q, c.signal)
        .then((r) => {
          setRes(r)
          setFailed(false)
          setBusy(false)
        })
        .catch(() => {
          if (c.signal.aborted) return
          setFailed(true)
          setBusy(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer.current)
  }, [kb.text])

  const rows = useMemo(() => resultRows(res, nav.data.videos), [res, nav.data.videos])
  const keys = layerKeys(kb.layer)
  const needle = res?.needle ?? ""

  const press = (key: KbKey) => setKb((s) => pressKey(s, key))

  const openRow = (row: ResultRow) => {
    switch (row.kind) {
      case "shuffle": {
        const s = startPlaylistOf(rows, nav.data.videos)
        if (!s) return nav.toast("Nothing here can be played")
        return nav.play(s.videoId, { startS: null, playingFrom: s.playingFrom, playlist: s.playlist })
      }
      case "video":
        if (!row.available) return nav.toast("No Copy of this Video is mounted")
        return nav.play(row.videoId, { startS: row.startS, playingFrom: playingFromRows(rows) })
      case "song":
        return nav.openGrid({ kind: "song", id: row.id, name: row.name })
      case "artist":
        return nav.openGrid({ kind: "artist", id: row.id, name: row.name })
    }
  }

  const backToKeyboard = () => {
    const r = root.current
    if (!r) return
    const el = findByKey(r, lastKbKey.current) ?? findByKey(r, "kb-0")
    focusEl(el, 0)
  }
  const lastKbKey = useRef("kb-0")

  useKeyHandler(active, (k) => {
    const r = root.current
    if (!r) return false
    if (k.action !== "back" && k.action !== "backspace" && ensure()) return true // focus was lost (a mouse click): find it again
    const cur = document.activeElement as HTMLElement | null
    const inKb = !!cur && zoneOf(cur) === "kb"
    if (inKb && cur?.dataset.key) lastKbKey.current = cur.dataset.key
    switch (k.action) {
      case "up":
      case "down":
        moveFocus(r, k.action, 40)
        return true
      case "left":
        if (!moveFocus(r, "left", 40) && !inKb) backToKeyboard() // results' left edge: the keyboard
        return true
      case "right": {
        if (moveFocus(r, "right", 40)) return true
        // The keyboard's right edge: the results, on the row nearest to this key.
        const res = itemsIn(r).filter((e) => zoneOf(e) === "res")
        if (inKb && cur && res.length) {
          const y = (cur.getBoundingClientRect().top + cur.getBoundingClientRect().bottom) / 2
          focusEl(res[nearestByY(y, res.map((e) => e.getBoundingClientRect()))]!, 40)
        }
        return true
      }
      case "enter":
        cur?.click()
        return true
      case "char":
        setKb((s) => typeChar(s, k.char ?? ""))
        if (!inKb) backToKeyboard()
        return true
      case "backspace":
        setKb((s) => pressKey(s, { kind: "backspace", label: "" }))
        return true
      case "back":
        if (!inKb) {
          backToKeyboard()
          return true
        }
        nav.back()
        return true
    }
    return false
  })

  const hasVideos = rows.some((x) => x.kind === "video")
  const groups = groupRows(rows)
  return (
    <div class="screen se" ref={root} onFocusIn={onFocusIn}>
      <div class="se-left" data-zone="kb">
        <div class="q">
          <span>{kb.text}</span>
          <i class="caret" />
          {!kb.text && <span class="ph">Songs, Videos, Artists, lyrics</span>}
        </div>
        <div class="kb">
          {keys.map((key, i) => (
            <div
              key={`${kb.layer}${i}`}
              class={`kbk${key.kind === "char" ? "" : " op"}${key.kind === "layer" && key.layer === kb.layer ? " on" : ""}${key.kind === "space" ? " wide" : ""}`}
              tabIndex={-1}
              data-item=""
              data-key={`kb-${i}`}
              data-zone="kb"
              onClick={() => press(key)}
            >
              {key.label}
            </div>
          ))}
        </div>
        <div class="hint">{LAYERS.length} layers · a keyboard types too · Right for results · Back leaves</div>
      </div>
      <div class="se-right">
        <div class="res" data-zone="res">
          {!kb.text.trim() && <div class="empty">Type to search. Lyrics need 3 letters.</div>}
          {failed && <div class="empty">The search failed. Try typing again.</div>}
          {kb.text.trim() && !failed && !res && busy && <div class="empty">Searching…</div>}
          {res && rows.length === 0 && <div class="empty">Nothing for “{kb.text.trim()}”.</div>}
          {hasVideos && <ResultRowView row={{ kind: "shuffle", key: "shuffle" }} needle="" open={openRow} />}
          {groups.map((g) => (
            <div key={g.label}>
              <div class="rh">
                {g.label} <span class="dim">{g.total}</span>
              </div>
              {g.rows.map((row) => (
                <ResultRowView key={row.key} row={row} needle={needle} open={openRow} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function groupRows(rows: ResultRow[]) {
  const out: { label: string; total: number; rows: ResultRow[] }[] = []
  for (const row of rows) {
    if (row.kind === "shuffle") continue
    let g = out.find((x) => x.label === row.group)
    if (!g) out.push((g = { label: row.group, total: row.groupTotal, rows: [] }))
    g.rows.push(row)
  }
  return out
}

const html = (text: string, needle: string) => ({ __html: needle ? highlightHtml(text, needle) : highlightHtml(text, "") })

function ResultRowView({ row, needle, open }: { row: ResultRow; needle: string; open: (r: ResultRow) => void }) {
  const props = { class: "rr", tabIndex: -1, "data-item": "", "data-key": `r-${row.key}`, "data-zone": "res", onClick: () => open(row) }
  switch (row.kind) {
    case "shuffle":
      return (
        <div {...props} class="rr shuffle">
          <div class="t">⤮ Shuffle these results</div>
        </div>
      )
    case "song":
      return (
        <div {...props}>
          <div class="t">
            <span dangerouslySetInnerHTML={html(row.name, needle)} />
            {row.englishName && <span class="dim"> <span dangerouslySetInnerHTML={html(row.englishName, needle)} /></span>}
          </div>
          <div class="s">
            {row.lyric ? (
              <>
                <span class="k">lyrics</span> <span dangerouslySetInnerHTML={html(row.lyric, needle)} />
              </>
            ) : (
              `${row.videoCount} Video${row.videoCount === 1 ? "" : "s"}`
            )}
          </div>
        </div>
      )
    case "video":
      return (
        <div {...props}>
          <div class="t" dangerouslySetInnerHTML={html(row.title, needle)} />
          <div class="s">
            {row.chapterTitle != null ? (
              <>
                <span class="k">› {fmtDuration(row.startS)}</span> <span dangerouslySetInnerHTML={html(row.chapterTitle, needle)} />
              </>
            ) : (
              <>
                <span class="k">{row.type}</span>
                {row.durationS != null ? ` · ${fmtDuration(row.durationS)}` : ""}
                {row.songs.length ? ` · ♪ ${row.songs.join(", ")}` : ""}
              </>
            )}
          </div>
        </div>
      )
    case "artist":
      return (
        <div {...props}>
          <div class="t" dangerouslySetInnerHTML={html(row.name, needle)} />
          <div class="s">
            {row.videoCount} Video{row.videoCount === 1 ? "" : "s"}
            {row.local ? " · local" : ""}
            {row.proposed ? " · proposed" : ""}
          </div>
        </div>
      )
  }
}

