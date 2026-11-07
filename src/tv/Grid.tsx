// A full grid (docs/tv-spec.md 5.3): six columns, windowed by rows, ChannelUp/Down page it. The first tile of every
// Video grid is Shuffle. Library grids carry the filter chips; a Song's grid loads its Videos from /api/songs/:id.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks"
import { libraryFiltered } from "../shared/playlistStart"
import { api } from "./data"
import { findByKey, focusEl, itemsIn, keyOf, moveFocus, zoneOf } from "./focus"
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

  // The tile focus was last on, by key and index: a reload can reorder the grid (the Player just counted a view, so
  // "Most watched" and Continue watching move that Video) and unmount the focused tile from the window (TV-5).
  const lastTile = useRef<{ key: string; index: number } | null>(null)
  /** Where focus belongs when it is lost: the same tile wherever it moved to, else the tile now at its old index. */
  const restoreIndex = (): number | null => {
    const t = lastTile.current
    if (!t || all.length === 0) return null
    return index.get(t.key) ?? Math.min(t.index, all.length - 1)
  }
  const firstRendered = (r: HTMLElement) => itemsIn(r).find((e) => zoneOf(e) === "grid") ?? findByKey(r, "h-search")
  const screen = useScreen(active, !loading, (r) => {
    const i = restoreIndex()
    if (i == null) return firstRendered(r)
    return findByKey(r, all[i]!.key) // null when it is outside the window: restore() scrolls to it
  })
  const { root, ensure } = screen
  const onFocusIn = (e: FocusEvent) => {
    screen.onFocusIn(e)
    const k = keyOf(e.target as Element)
    if (k != null && index.has(k)) lastTile.current = { key: k, index: index.get(k)! }
  }

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

  /** Focus is nowhere in the grid: put it back on the last tile (scrolling to it when it moved out of the window). */
  const restore = (): boolean => {
    const r = root.current
    const el = scroller.current
    if (!r || !el || (r.contains(document.activeElement) && document.activeElement !== r)) return false
    const i = restoreIndex()
    if (i == null) return ensure()
    const k = all[i]!.key
    const found = findByKey(r, k)
    if (found) return focusEl(found, 24) != null
    pending.current = k // rendered on the next frame, focused by the effect above
    el.scrollTop = scrollForRow(rowOf(i))
    setScrollTop(el.scrollTop)
    return true
  }

  // The list changed under an active grid (the reload after the Player): keep focus on the same Video.
  useLayoutEffect(() => {
    if (active && !loading) restore()
  }, [all, active])

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
    if (k.action !== "back" && k.action !== "backspace" && restore()) {
      // Focus was lost (a mouse click): it is back on the last tile. The key still counts when that tile is on screen.
      if (!r.contains(document.activeElement)) return true
    }
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
