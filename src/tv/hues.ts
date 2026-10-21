// The lyrics column's backdrop colours (docs/tv-spec.md 6.2). Each frame of the Video's scrub strip (or the poster,
// without one) is sampled into SAMPLE_N x SAMPLE_N cells; each of the ORBS orbs takes the chroma-weighted mean of its
// region of the frame, so the colours move continuously with the picture (nothing is ranked, so nothing flips). The
// colours at a time are the frames around it blended with Gaussian weights, then styled into glowing orbs on a dark
// ground. Pure: RGBA pixels in, colours out, so a test feeds synthetic arrays.

/** Cells a frame is sampled into, each way. */
export const SAMPLE_N = 12

export type Rgb = [number, number, number]

/** A frame's colours: one per orb (its region's), and the frame's mean for the ground. */
export interface FrameColors {
  orbs: Rgb[]
  mean: Rgb
}

/** The regions of a frame (in cells, [x0, y0, x1, y1)) the orbs take their colour from: three across, two down. */
export const REGIONS: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 4, 6],
  [4, 0, 8, 6],
  [8, 0, 12, 6],
  [0, 6, 4, 12],
  [4, 6, 8, 12],
  [8, 6, 12, 12],
]
export const ORBS = REGIONS.length

/** Half-width of the Gaussian the frames around the playhead are blended with (seconds), never under 0.7 of a slice. */
export const BLEND_S = 20

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

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

/** How much a cell counts towards its region: vivid mid-light cells most, grey, black and white ones barely. */
export function cellWeight(r: number, g: number, b: number): number {
  const [, s, l] = rgbToHsl(r, g, b)
  return 0.02 + s * s * Math.max(0.1, 1 - Math.abs(l - 0.5) * 1.6)
}

/** The colours of one frame from its SAMPLE_N x SAMPLE_N RGBA cells, read from `px` at cell `offset` in rows `stride` cells wide. */
export function frameColors(px: ArrayLike<number>, stride = SAMPLE_N, offset = 0): FrameColors {
  const at = (x: number, y: number) => (offset + y * stride + x) * 4
  const orbs = REGIONS.map(([x0, y0, x1, y1]): Rgb => {
    let w = 0
    const sum: Rgb = [0, 0, 0]
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = at(x, y)
        const r = px[i] ?? 0
        const g = px[i + 1] ?? 0
        const b = px[i + 2] ?? 0
        const k = cellWeight(r, g, b)
        sum[0] += r * k
        sum[1] += g * k
        sum[2] += b * k
        w += k
      }
    return [sum[0] / w, sum[1] / w, sum[2] / w]
  })
  const mean: Rgb = [0, 0, 0]
  for (let y = 0; y < SAMPLE_N; y++)
    for (let x = 0; x < SAMPLE_N; x++) for (let c = 0; c < 3; c++) mean[c] += (px[at(x, y) + c] ?? 0) / (SAMPLE_N * SAMPLE_N)
  return { orbs, mean }
}

/** Every frame of a strip drawn at SAMPLE_N cells a tile (`columns * SAMPLE_N` wide). */
export function stripColors(px: ArrayLike<number>, columns: number, frames: number): FrameColors[] {
  const stride = columns * SAMPLE_N
  return Array.from({ length: frames }, (_, i) => frameColors(px, stride, Math.floor(i / columns) * SAMPLE_N * stride + (i % columns) * SAMPLE_N))
}

/** The frames around `t` blended with Gaussian weights over their slice centres: continuous in `t`. */
export function colorsAt(frames: FrameColors[], t: number, durationS: number): FrameColors {
  if (frames.length === 1) return frames[0]!
  const slice = durationS / frames.length
  const sigma = Math.max(BLEND_S, slice * 0.7)
  const out: FrameColors = { orbs: Array.from({ length: ORBS }, (): Rgb => [0, 0, 0]), mean: [0, 0, 0] }
  let total = 0
  frames.forEach((f, i) => {
    const d = (slice * (i + 0.5) - t) / sigma
    if (Math.abs(d) > 3) return
    const w = Math.exp(-0.5 * d * d)
    total += w
    f.orbs.forEach((c, o) => c.forEach((v, k) => (out.orbs[o]![k] += v * w)))
    f.mean.forEach((v, k) => (out.mean[k] += v * w))
  })
  if (total === 0) return frames[Math.min(frames.length - 1, Math.max(0, Math.floor(t / slice)))]!
  for (const c of [...out.orbs, out.mean]) for (let k = 0; k < 3; k++) c[k] /= total
  return out
}

/**
 * An orb's colour as drawn: the region's hue (turned `fan` degrees), saturation pushed up to at least 60 % (a grey region
 * stays grey), lightness lifted to 40-60 % but still following the picture.
 */
export function orbColor([r, g, b]: Rgb, fan = 0): Rgb {
  const [h, s, l] = rgbToHsl(r, g, b)
  const floor = 0.6 * Math.min(1, s / 0.12) // a grey region has no hue to push: it stays grey
  return hslToRgb((h + fan + 360) % 360, Math.max(floor, Math.min(0.9, 0.3 + s * 1.6)) * Math.min(1, s / 0.04), 0.4 + 0.2 * Math.sqrt(l))
}

/** The ground under the orbs: the frame's mean, very dark. */
export function groundColor([r, g, b]: Rgb): Rgb {
  const [h, s, l] = rgbToHsl(r, g, b)
  return hslToRgb(h, Math.min(0.5, s), 0.05 + 0.08 * l)
}

/** `c` eased towards `target` over `dtS` seconds with time constant `tauS` (in place). */
export function ease(c: Rgb, target: Rgb, dtS: number, tauS: number): Rgb {
  const k = 1 - Math.exp(-dtS / tauS)
  for (let i = 0; i < 3; i++) c[i] += (target[i]! - c[i]!) * k
  return c
}

/** Draws `img` into a SAMPLE_N canvas and returns its pixels; throws on a tainted canvas (no CORS), which callers ignore. */
export function samplePixels(img: CanvasImageSource): Uint8ClampedArray {
  const c = document.createElement("canvas")
  c.width = c.height = SAMPLE_N
  const g = c.getContext("2d")!
  g.drawImage(img, 0, 0, SAMPLE_N, SAMPLE_N)
  return g.getImageData(0, 0, SAMPLE_N, SAMPLE_N).data
}
