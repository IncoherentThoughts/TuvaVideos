// The TV focus engine (docs/tv-spec.md 5.1, 8): geometry-based like src/web/keys.ts. Every focusable thing is a
// `[data-item]` element with a `data-key`; an arrow picks the nearest item in its direction, first inside the current
// zone (`data-zone`), then across the zones of the current scope. The pure part works on rectangles so a test can walk it.

export type Dir = "up" | "down" | "left" | "right"

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Placed {
  box: Box
  zone: string
}

const cx = (b: Box) => (b.left + b.right) / 2
const cy = (b: Box) => (b.top + b.bottom) / 2
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0)

/**
 * The index of the candidate to move to from `cur` in direction `dir`, or -1. Sideways a candidate must share some
 * height with `cur` (a rail never leaves its row); up and down it may be anywhere above or below, and the nearest
 * column wins. Aligned candidates beat near ones: the cross-axis offset counts double.
 */
export function pickNext(cur: Box, cands: readonly Box[], dir: Dir): number {
  const horizontal = dir === "left" || dir === "right"
  let best = -1
  let bestScore = Infinity
  cands.forEach((b, i) => {
    const d = horizontal ? cx(b) - cx(cur) : cy(b) - cy(cur)
    const primary = dir === "right" || dir === "down" ? d : -d
    if (primary <= 1) return
    let cross: number
    if (horizontal) {
      if (overlap(cur.top, cur.bottom, b.top, b.bottom) <= 0) return
      cross = Math.abs(cy(b) - cy(cur))
    } else {
      cross = Math.abs(cx(b) - cx(cur)) + (overlap(cur.left, cur.right, b.left, b.right) > 0 ? 0 : 2000)
    }
    const score = primary + cross * 2
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  })
  return best
}

export interface Move {
  index: number
  /** True when the target is in another zone (the header from a rail, the chips from a grid). */
  crossed: boolean
}

/** Inside the current zone first, then across the zones; null at an edge (the screen decides what an edge means). */
export function moveTarget(cur: Placed, items: readonly Placed[], dir: Dir): Move | null {
  const inZone: number[] = []
  const outside: number[] = []
  items.forEach((p, i) => (p.zone === cur.zone ? inZone : outside).push(i))
  const a = pickNext(cur.box, inZone.map((i) => items[i]!.box), dir)
  if (a >= 0) return { index: inZone[a]!, crossed: false }
  const b = pickNext(cur.box, outside.map((i) => items[i]!.box), dir)
  return b >= 0 ? { index: outside[b]!, crossed: true } : null
}

/** The item whose centre is nearest vertically to `y` (entering a column from the side keeps the row you were on). */
export function nearestByY(y: number, boxes: readonly Box[]): number {
  let best = -1
  let bd = Infinity
  boxes.forEach((b, i) => {
    const d = Math.abs(cy(b) - y)
    if (d < bd) {
      bd = d
      best = i
    }
  })
  return best
}

// ---- DOM glue ----

/** The factor the stage is scaled by when the window is not 1920 wide (a desktop browser); 1 on the TV. */
export function stageScale(): number {
  const el = document.getElementById("tv")
  if (!el) return 1
  const w = el.getBoundingClientRect().width
  return w > 0 ? w / 1920 : 1
}

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

/** The focusable items in a scope, in document order, skipping hidden ones. */
export function itemsIn(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>("[data-item]")].filter((e) => !e.hidden && e.getClientRects().length > 0)
}

export const zoneOf = (el: Element): string => el.closest<HTMLElement>("[data-zone]")?.dataset.zone ?? ""

export function keyOf(el: Element | null): string | null {
  return el?.closest<HTMLElement>("[data-item]")?.dataset.key ?? null
}

export function findByKey(scope: ParentNode, key: string): HTMLElement | null {
  for (const e of scope.querySelectorAll<HTMLElement>("[data-item]")) if (e.dataset.key === key) return e
  return null
}

/** Scroll every scrolling ancestor of `el` just enough to bring it inside, `margin` px from the edges. */
export function ensureVisible(el: HTMLElement, margin = 48): void {
  const s = stageScale()
  let p = el.parentElement
  while (p && p.id !== "tv") {
    const cs = getComputedStyle(p)
    const sy = /(auto|scroll|hidden)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1
    const sx = /(auto|scroll|hidden)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1
    if (sy || sx) {
      const pr = p.getBoundingClientRect()
      const er = el.getBoundingClientRect()
      const m = margin * s
      if (sy) {
        if (er.top < pr.top + m) p.scrollTop -= (pr.top + m - er.top) / s
        else if (er.bottom > pr.bottom - m) p.scrollTop += (er.bottom - (pr.bottom - m)) / s
      }
      if (sx) {
        if (er.left < pr.left + m) p.scrollLeft -= (pr.left + m - er.left) / s
        else if (er.right > pr.right - m) p.scrollLeft += (er.right - (pr.right - m)) / s
      }
    }
    p = p.parentElement
  }
}

export function focusEl(el: HTMLElement | null, margin = 48): HTMLElement | null {
  if (!el) return null
  el.focus({ preventScroll: true })
  ensureVisible(el, margin)
  return el
}

/**
 * Move focus one step in `dir` inside `scope`. Returns the element it moved to, or null at an edge (the caller opens the
 * pane, reaches the keyboard, and so on).
 */
export function moveFocus(scope: ParentNode, dir: Dir, margin = 48): HTMLElement | null {
  const all = itemsIn(scope)
  const cur = all.find((e) => e === document.activeElement || e.contains(document.activeElement))
  if (!cur) return focusEl(all[0] ?? null, margin)
  const others = all.filter((e) => e !== cur)
  const move = moveTarget({ box: boxOf(cur), zone: zoneOf(cur) }, others.map((e) => ({ box: boxOf(e), zone: zoneOf(e) })), dir)
  return move ? focusEl(others[move.index]!, margin) : null
}
