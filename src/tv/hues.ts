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
