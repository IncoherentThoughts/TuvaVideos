// The lyrics backdrop following the playhead (docs/tv-spec.md 6.2): orbs of colour flowing over a dark ground, drawn
// into a tiny canvas (W x H) that the stylesheet stretches over the column. The scrub strip (one image, up to 100
// frames) is sampled once (hues.ts); every RETARGET_MS the colours at the playhead are blended from the frames around
// it, and every frame the shown colours ease towards them (TAU_S), so neither playing, scrubbing nor reopening the
// column ever cuts. The cost is a few gradients on a few thousand pixels about 30 times a second; no frame is shown.
import type { StripDto } from "../shared/types"
import { ORBS, SAMPLE_N, colorsAt, ease, frameColors, groundColor, orbColor, samplePixels, stripColors, type FrameColors, type Rgb } from "./hues"

/** The canvas, in pixels: stretched over the column, the gradients stay smooth. */
export const W = 90
export const H = 120
/** Time constant of the colours easing towards the playhead's (seconds), how often those are re-blended, the frame budget. */
export const TAU_S = 6
export const RETARGET_MS = 500
export const FRAME_MS = 33

/** Where each orb (in REGIONS order: top row of the frame, then bottom) wanders, as fractions of the canvas; seconds a cycle. */
const PATHS = [
  { x: 0.18, y: 0.16, ax: 0.16, ay: 0.09, px: 31, py: 23, r: 0.53 },
  { x: 0.6, y: 0.1, ax: 0.2, ay: 0.08, px: 37, py: 29, r: 0.47 },
  { x: 0.88, y: 0.36, ax: 0.1, ay: 0.12, px: 27, py: 41, r: 0.53 },
  { x: 0.12, y: 0.66, ax: 0.12, ay: 0.12, px: 43, py: 26, r: 0.53 },
  { x: 0.52, y: 0.5, ax: 0.22, ay: 0.14, px: 34, py: 47, r: 0.45 },
  { x: 0.8, y: 0.88, ax: 0.14, ay: 0.08, px: 29, py: 38, r: 0.55 },
] as const

/** Degrees each orb's hue is turned from its region's, so a scene in one colour still glows in a few neighbouring ones. */
const FAN = [-14, 10, 20, -20, 0, 14]

interface Shown {
  orbs: Rgb[]
  ground: Rgb
}

const copy = (s: Shown): Shown => ({ orbs: s.orbs.map((c) => [...c] as Rgb), ground: [...s.ground] as Rgb })
const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`

/** The colours last shown, so the column reopened on the same Video picks up where it was instead of starting over. */
let memory: { key: string; shown: Shown } | null = null

export class Glow {
  private g: CanvasRenderingContext2D | null
  private frames: FrameColors[] | null = null
  private duration = 1
  private target: Shown | null = null
  private shown: Shown | null
  private raf = 0
  private last = 0
  private retargetAt = 0
  private img: HTMLImageElement | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    private key: string,
    private time: () => number,
  ) {
    canvas.width = W
    canvas.height = H
    this.g = canvas.getContext("2d")
    this.shown = memory?.key === key ? copy(memory.shown) : null
    this.raf = requestAnimationFrame(this.tick)
  }

  /** Samples the strip (else, or when it fails, the poster) once; until then nothing is drawn and the ground shows. */
  follow(strip: StripDto | null, stripSrc: string | null, posterSrc: string | null, durationS: number | null) {
    const poster = () => posterSrc && this.load(posterSrc, (img) => [frameColors(samplePixels(img))], 1)
    if (strip && stripSrc && durationS && strip.frames >= 2) {
      this.load(
        stripSrc,
        (img) => {
          const c = document.createElement("canvas")
          c.width = strip.columns * SAMPLE_N
          c.height = strip.rows * SAMPLE_N
          const g = c.getContext("2d")!
          g.imageSmoothingQuality = "high"
          g.drawImage(img, 0, 0, c.width, c.height)
          return stripColors(g.getImageData(0, 0, c.width, c.height).data, strip.columns, strip.frames)
        },
        durationS,
        poster,
      )
    } else poster()
  }

  private load(src: string, sample: (img: HTMLImageElement) => FrameColors[], durationS: number, fallback?: () => void) {
    const img = (this.img = new Image())
    img.crossOrigin = "anonymous"
    img.onload = () => {
      try {
        this.frames = sample(img)
        this.duration = durationS
        this.retargetAt = 0
      } catch {
        fallback?.() // a tainted canvas (no CORS)
      }
    }
    img.onerror = () => fallback?.()
    img.src = src
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick)
    if (now - this.last < FRAME_MS) return
    const dt = this.last ? Math.min(0.25, (now - this.last) / 1000) : 0
    this.last = now
    if (this.frames && now >= this.retargetAt) {
      const c = colorsAt(this.frames, this.time(), this.duration)
      this.target = { orbs: c.orbs.map((o, i) => orbColor(o, FAN[i])), ground: groundColor(c.mean) }
      this.retargetAt = now + RETARGET_MS
    }
    if (!this.target) return
    if (!this.shown) this.shown = copy(this.target)
    else {
      this.shown.orbs.forEach((c, i) => ease(c, this.target!.orbs[i]!, dt, TAU_S))
      ease(this.shown.ground, this.target.ground, dt, TAU_S)
    }
    memory = { key: this.key, shown: this.shown }
    this.draw(now / 1000)
  }

  private draw(s: number) {
    const g = this.g
    const shown = this.shown
    if (!g || !shown) return
    g.globalCompositeOperation = "source-over"
    g.fillStyle = rgba(shown.ground, 1)
    g.fillRect(0, 0, W, H)
    g.globalCompositeOperation = "screen"
    for (let i = 0; i < ORBS; i++) {
      const p = PATHS[i]!
      const x = (p.x + p.ax * Math.sin((2 * Math.PI * s) / p.px + i)) * W
      const y = (p.y + p.ay * Math.sin((2 * Math.PI * s) / p.py + i * 1.7)) * H
      const r = p.r * W * (1 + 0.12 * Math.sin((2 * Math.PI * s) / (19 + i * 3)))
      const c = shown.orbs[i]!
      const grad = g.createRadialGradient(x, y, 0, x, y, r)
      grad.addColorStop(0, rgba(c, 0.95))
      grad.addColorStop(0.4, rgba(c, 0.7))
      grad.addColorStop(0.75, rgba(c, 0.18))
      grad.addColorStop(1, rgba(c, 0))
      g.fillStyle = grad
      g.fillRect(0, 0, W, H)
    }
    this.canvas.classList.add("on")
  }

  stop() {
    cancelAnimationFrame(this.raf)
    if (this.img) this.img.onload = this.img.onerror = null
  }
}
