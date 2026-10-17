// A full grid (docs/tv-spec.md 5.3): six columns, windowed by rows, ChannelUp/Down page it. The first tile of every
// Video grid is Shuffle. Library grids carry the filter chips; a Song's grid loads its Videos from /api/songs/:id.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks"
import { libraryFiltered } from "../shared/playlistStart"
import { api } from "./data"
import { findByKey, focusEl, keyOf, moveFocus } from "./focus"
import { COLS, ROW_H, pageTarget, rowOf, scrollForRow, windowRange, windowRows } from "./gridMath"
import { useKeyHandler } from "./input"
import { CHIPS, chipLabel, cycleChip } from "./libchips"
import { openTile } from "./open"
import { gridTiles, gridTitle, isVideoGrid, shuffleStart, type GridSpec, type SongVideo, type Tile } from "./rails"
import { Header, useScreen, type Nav } from "./screen"
import { Chip, TileView } from "./ui"

export function Grid({ spec, nav, active }: { spec: GridSpec; nav: Nav; active: boolean }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(800)
  const [perf, setPerf] = useState<SongVideo[] | null | undefined>(spec.kind === "song" ? undefined : null)
  const pending = useRef<string | null>(null)

  useEffect(() => {
    if (spec.kind !== "song") return
    let alive = true
    api.song(spec.id).then((s) => alive && setPerf(s.videos)).catch(() => alive && setPerf([]))
    return () => {
      alive = false
    }
  }, [spec.kind === "song" ? spec.id : ""])

  const loading = spec.kind === "song" && perf === undefined
  const tiles = useMemo(() => (loading ? [] : gridTiles(spec, nav.data, nav.lib, perf ?? [])), [spec, nav.data, nav.lib, perf, loading])
  const withShuffle = isVideoGrid(tiles)
  const all: Tile[] = useMemo(() => (withShuffle ? [{ kind: "shuffle", key: "shuffle", count: tiles.length }, ...tiles] : tiles), [tiles, withShuffle])
  const index = useMemo(() => new Map(all.map((t, i) => [t.key, i])), [all])
  const rows = Math.ceil(all.length / COLS)

  const { root, onFocusIn, ensure } = useScreen(active, !loading, (r) => findByKey(r, all[0]?.key ?? "") ?? findByKey(r, "h-search"))

  // Measure the view, and follow the scroll (focus moves scroll it; so does paging).
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => setViewH(el.clientHeight)
    measure()
    const onScroll = () => setScrollTop(el.scrollTop)
    el.addEventListener("scroll", onScroll)
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  // New chips, new list: start at the top.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0
  }, [nav.lib])

  const range = windowRange(all.length, windowRows(scrollTop, viewH, rows))

  // After a jump, the target's row is rendered one frame later: focus it then.
  useLayoutEffect(() => {
    const k = pending.current
    if (!k || !root.current) return
    const el = findByKey(root.current, k)
    if (el) {
      pending.current = null
      focusEl(el, 24)
    }
  })

  const shuffle = () => {
    const grid = spec.kind === "favorites" ? "favorites" : spec.kind === "library" ? "library" : "other"
    const s = shuffleStart(tiles, grid, libraryFiltered(nav.lib))
    if (!s) return nav.toast("Nothing here can be played")
    nav.play(s.videoId, { startS: s.startS, playingFrom: s.playingFrom, playlist: s.playlist })
  }
  const open = (t: Tile) => (t.kind === "shuffle" ? shuffle() : openTile(t, nav, tiles, spec.kind === "favorites" ? "favorites" : "library"))

  const page = (dir: 1 | -1) => {
    const cur = keyOf(document.activeElement)
    const el = scroller.current
    if (!el || cur == null || !index.has(cur)) return
    const from = index.get(cur)!
    const to = pageTarget(from, all.length, Math.max(1, Math.floor(el.clientHeight / ROW_H)), dir)
    pending.current = all[to]!.key
    el.scrollTop = scrollForRow(rowOf(to))
    setScrollTop(el.scrollTop)
  }

  useKeyHandler(active, (k) => {
    const r = root.current
    if (!r) return false
    if (k.action !== "back" && k.action !== "backspace" && ensure()) return true // focus was lost (a mouse click): find it again
    switch (k.action) {
      case "up":
      case "down":
      case "right":
        moveFocus(r, k.action, 24)
        return true
      case "left":
        if (!moveFocus(r, "left", 24)) nav.openPane()
        return true
      case "pageUp":
      case "pageDown":
        page(k.action === "pageDown" ? 1 : -1)
        return true
      case "enter":
        ;(document.activeElement as HTMLElement | null)?.click()
        return true
      case "back":
        nav.back()
        return true
    }
    return false
  })

  const count = loading ? "loading…" : `${tiles.length}`
  return (
    <div class="screen" ref={root} onFocusIn={onFocusIn}>
      <Header title={gridTitle(spec)} count={count} nav={nav} />
      {spec.kind === "library" && (
        <div class="chips" data-zone="chips">
          {CHIPS.map((id) => {
            const c = chipLabel(id, nav.lib)
            return <Chip key={id} itemKey={`chip-${id}`} zone="chips" name={c.name} value={c.value} on={c.on} onPress={() => nav.setLib(cycleChip(id, nav.lib))} />
          })}
        </div>
      )}
      <div class="gridscroll" ref={scroller}>
        {all.length === 0 && !loading && <div class="empty">{emptyText(spec)}</div>}
        <div class="gridin" style={{ height: `${rows * ROW_H + 40}px` }}>
          <div class="gridrows" data-zone="grid" style={{ transform: `translateY(${rowOf(range.from) * ROW_H}px)` }}>
            {all.slice(range.from, range.to).map((t) => (
              <TileView key={t.key} tile={t} zone="grid" open={open} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function emptyText(spec: GridSpec): string {
  switch (spec.kind) {
    case "favorites": return "Nothing starred yet."
    case "library": return "No Videos match these chips."
    case "song": return "No Video performs this Song."
    default: return "Nothing here."
  }
}
