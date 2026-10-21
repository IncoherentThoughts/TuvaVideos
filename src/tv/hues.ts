// The lyrics column's backdrop colours (docs/tv-spec.md 6.2). A dark poster blurs to black, so the poster is sampled
// into a small canvas (12x12), its four most vivid hues (25 degrees apart or more) are lifted to a fixed lightness and
// saturation, and those colours drive four drifting blobs. A grey poster (black-and-white footage) has no hue worth
// keeping: warm hues spread round the wheel. Pure: RGBA pixels in, colours out, so a test feeds synthetic arrays.

/** The canvas the poster is drawn into. */
export const SAMPLE_N = 12
/** Hues closer than this (degrees) count as one. */
export const MIN_HUE_GAP = 25
/** A cell this grey carries no hue. */
export const GREY_S = 0.15
/** Lifted lightness (percent) of the first blob and of the other three; saturation never below this (percent). */
export const LIFT_L = [56, 48, 48, 48] as const
export const LIFT_S_MIN = 65

export interface Hue {
  /** Degrees 0..360. */
  h: number
  /** 0..1 */
  s: number
  /** 0..1 */
  l: number
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}

/** Angular distance between two hues, 0..180. */
export const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

/** Warm hues, 35 degrees apart from `base`: what a poster without colour gets. */
export const WARM_BASE = 25
export const WARM_STEP = 35

/**
 * The four hues of a poster from its RGBA pixels (any length, normally SAMPLE_N * SAMPLE_N * 4): cells ranked by
 * saturation, preferring mid lightness; picked greedily at least MIN_HUE_GAP apart; missing ones filled with warm hues
 * spread from the first (or from WARM_BASE for a grey poster).
 */
export function sampleHues(pixels: ArrayLike<number>, count = 4): Hue[] {
  const cells: (Hue & { score: number })[] = []
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if ((pixels[i + 3] ?? 255) < 128) continue // transparent
    const [h, s, l] = rgbToHsl(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)
    if (s <= GREY_S || l < 0.06 || l > 0.94) continue // grey, black or white: no hue to keep
    cells.push({ h, s, l, score: s * (1 - Math.abs(l - 0.45)) })
  }
  cells.sort((a, b) => b.score - a.score)
  const picked: Hue[] = []
  for (const c of cells) {
    if (picked.length === count) break
    if (picked.every((p) => hueGap(p.h, c.h) >= MIN_HUE_GAP)) picked.push({ h: c.h, s: c.s, l: c.l })
  }
  const base = picked[0]?.h ?? WARM_BASE
  while (picked.length < count) picked.push({ h: (base + WARM_STEP * picked.length) % 360, s: 0.55, l: 0.4 })
  return picked
}

/** A picked hue lifted to the fixed lightness (56 % for the first blob, 48 % for the rest) and S of at least 65 %. */
export function liftedColor(hue: Hue, index: number): string {
  const l = LIFT_L[Math.min(index, LIFT_L.length - 1)]!
  return `hsl(${Math.round(hue.h)} ${Math.round(Math.max(LIFT_S_MIN, hue.s * 100))}% ${l}%)`
}

/** The four blob colours of a poster. */
export const blobColors = (pixels: ArrayLike<number>): string[] => sampleHues(pixels).map(liftedColor)

/** Draws `img` into a SAMPLE_N canvas and returns its pixels; throws on a tainted canvas (no CORS), which callers ignore. */
export function samplePixels(img: CanvasImageSource): Uint8ClampedArray {
  const c = document.createElement("canvas")
  c.width = c.height = SAMPLE_N
  const g = c.getContext("2d")!
  g.drawImage(img, 0, 0, SAMPLE_N, SAMPLE_N)
  return g.getImageData(0, 0, SAMPLE_N, SAMPLE_N).data
}

// ---- following the playhead (spec 6.2): the scrub strip stands in for the frames, sampled once ----

/** Half the span of the strip the colours are pooled from (seconds), never under one slice. */
export const WINDOW_S = 30
/** A slot repaints only when its hue moves this far (degrees) or its lifted saturation this much. */
export const HUE_STEP = 12
export const SAT_STEP = 0.15

/** The tiles whose slice centres lie within WINDOW_S (or one slice, if longer) of `t`; at least the tile under `t`. */
export function windowTiles(t: number, durationS: number, frames: number): number[] {
  const slice = durationS / frames
  const half = Math.max(WINDOW_S, slice)
  const lo = Math.max(0, Math.ceil((t - half) / slice - 0.5))
  const hi = Math.min(frames - 1, Math.floor((t + half) / slice - 0.5))
  if (lo > hi) return [Math.min(frames - 1, Math.max(0, Math.floor(t / slice)))]
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
}

/** The RGBA cells of tile `i` from the strip drawn at `n` cells a tile (`columns * n` wide), as one run. */
export function tileCells(strip: ArrayLike<number>, columns: number, i: number, n = SAMPLE_N): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * n * 4)
  const col = i % columns
  const row = Math.floor(i / columns)
  const width = columns * n
  for (let y = 0; y < n; y++) {
    const from = ((row * n + y) * width + col * n) * 4
    for (let k = 0; k < n * 4; k++) out[y * n * 4 + k] = strip[from + k] ?? 0
  }
  return out
}

/** The hues of tiles `tiles` pooled into one sample. */
export function stripHues(strip: ArrayLike<number>, columns: number, tiles: number[]): Hue[] {
  const pooled = new Uint8ClampedArray(tiles.length * SAMPLE_N * SAMPLE_N * 4)
  tiles.forEach((i, k) => pooled.set(tileCells(strip, columns, i), k * SAMPLE_N * SAMPLE_N * 4))
  return sampleHues(pooled)
}

const permutations = (n: number): number[][] =>
  n <= 1 ? [[0]] : permutations(n - 1).flatMap((p) => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n - 1, ...p.slice(i)]))

/** `next` reordered so each slot takes the hue nearest the one it shows (least total hue travel): blobs drift, never swap. */
export function matchSlots(prev: Hue[], next: Hue[]): Hue[] {
  if (prev.length !== next.length || next.length > 6) return next
  let best = next
  let cost = Infinity
  for (const p of permutations(next.length)) {
    const c = p.reduce((sum, j, i) => sum + hueGap(prev[i]!.h, next[j]!.h), 0)
    if (c < cost) [cost, best] = [c, p.map((j) => next[j]!)]
  }
  return best
}

/** Whether a slot showing `a` should move to `b`, compared as lifted. */
export const hueMoved = (a: Hue, b: Hue): boolean =>
  hueGap(a.h, b.h) >= HUE_STEP || Math.abs(Math.max(LIFT_S_MIN / 100, a.s) - Math.max(LIFT_S_MIN / 100, b.s)) >= SAT_STEP
