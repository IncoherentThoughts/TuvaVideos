// The lyrics backdrop following the playhead (docs/tv-spec.md 6.2). The scrub strip (up to 100 frames, one image) is
// drawn once into a canvas of SAMPLE_N cells a tile; every LOOK_MS the colours of the strip around the playhead are
// picked, and at most one slot (a blob, or the blurred frame underneath) crossfades towards them over FADE_S. Each slot
// is two stacked layers whose opacity swaps, so the browser only composites: no per-frame script, no repaint of a
// gradient mid-fade, no reading back the video.
import type { StripDto } from "../shared/types"
import { tileForTime } from "../server/stripGeometry"
import { SAMPLE_N, hueMoved, liftedColor, matchSlots, samplePixels, sampleHues, stripHues, windowTiles, type Hue } from "./hues"

/** How long one crossfade lasts (seconds; the stylesheet's `--glow-fade` reads the same) and how often the playhead is looked at. */
export const FADE_S = 14
export const LOOK_MS = 2500
/** The blurred frame underneath changes at most this often. */
export const FRAME_HOLD_MS = 20000

interface Pair {
  layers: HTMLElement[]
  on: number
  busyUntil: number
}

/** Shows the other layer of `p` (already painted by the caller) and hides the current one. */
function swap(p: Pair, now: number) {
  const next = 1 - p.on
  p.layers[next]!.classList.add("on")
  p.layers[p.on]!.classList.remove("on")
  p.on = next
  p.busyUntil = now + FADE_S * 1000
}

export class Glow {
  private blobs: (Pair & { hue: Hue | null })[]
  private frame: Pair & { tile: number; shownAt: number }
  private strip: { img: HTMLImageElement; cells: Uint8ClampedArray; g: StripDto; fw: number; fh: number } | null = null
  private cache = new Map<string, Hue[]>()
  private turn = 0
  private timer: ReturnType<typeof setInterval>
  private img: HTMLImageElement | null = null
  private duration = 0

  constructor(root: HTMLElement, private time: () => number) {
    this.blobs = [...root.querySelectorAll<HTMLElement>(".blob")].map((b) => ({
      layers: [...b.children] as HTMLElement[],
      on: 0,
      busyUntil: 0,
      hue: null,
    }))
    this.frame = { layers: [...root.querySelectorAll<HTMLElement>(".drift canvas")], on: 1, busyUntil: 0, tile: -1, shownAt: -Infinity }
    this.timer = setInterval(() => this.look(), LOOK_MS)
  }

  /** The poster's colours, painted at once, until the strip takes over. A tainted canvas keeps the stylesheet's. */
  poster(img: HTMLImageElement) {
    if (this.strip) return
    try {
      const hues = sampleHues(samplePixels(img))
      this.blobs.forEach((b, i) => {
        b.hue = hues[i]!
        b.layers[b.on]!.style.setProperty("--c", liftedColor(b.hue, i))
      })
    } catch {
      /* no CORS on the poster */
    }
  }

  /** Loads the Video's strip; once sampled the backdrop follows the playhead. */
  follow(strip: StripDto | null, src: string | null, durationS: number | null) {
    if (!strip || !src || !durationS || strip.frames < 2) return
    const img = (this.img = new Image())
    img.crossOrigin = "anonymous"
    img.onload = () => {
      try {
        const c = document.createElement("canvas")
        c.width = strip.columns * SAMPLE_N
        c.height = strip.rows * SAMPLE_N
        const g = c.getContext("2d")!
        g.imageSmoothingQuality = "high"
        g.drawImage(img, 0, 0, c.width, c.height)
        const cells = g.getImageData(0, 0, c.width, c.height).data
        const fw = strip.frameWidth ?? img.naturalWidth / strip.columns
        const fh = strip.frameHeight ?? img.naturalHeight / strip.rows
        for (const l of this.frame.layers) Object.assign(l, { width: fw, height: fh })
        this.strip = { img, cells, g: strip, fw, fh }
        this.duration = durationS
        this.look()
      } catch {
        /* tainted: the poster's colours stay */
      }
    }
    img.src = src
  }

  /** Picks the colours around the playhead and starts at most one crossfade (round the slots in turn). */
  private look() {
    const s = this.strip
    if (!s) return
    const t = this.time()
    const tiles = windowTiles(t, this.duration, s.g.frames)
    const key = `${tiles[0]}-${tiles[tiles.length - 1]}`
    let target = this.cache.get(key)
    if (!target) this.cache.set(key, (target = stripHues(s.cells, s.g.columns, tiles)))
    const shown = this.blobs.map((b, i) => b.hue ?? target![i]!)
    const hues = matchSlots(shown, target)
    const now = performance.now()
    const n = this.blobs.length + 1
    for (let k = 0; k < n; k++) {
      const slot = (this.turn + k) % n
      if (slot === this.blobs.length ? this.stepFrame(t, now) : this.stepBlob(slot, hues[slot]!, now)) {
        this.turn = slot + 1
        return
      }
    }
  }

  private stepBlob(i: number, hue: Hue, now: number): boolean {
    const b = this.blobs[i]!
    if (now < b.busyUntil) return false
    if (b.hue && !hueMoved(b.hue, hue)) return false
    b.hue = hue
    b.layers[1 - b.on]!.style.setProperty("--c", liftedColor(hue, i))
    swap(b, now)
    return true
  }

  private stepFrame(t: number, now: number): boolean {
    const s = this.strip!
    const f = this.frame
    const tile = tileForTime(t, this.duration, s.g)
    if (tile.index === f.tile || now < f.busyUntil || now - f.shownAt < FRAME_HOLD_MS) return false
    const c = f.layers[1 - f.on] as HTMLCanvasElement | undefined
    const g = c?.getContext("2d")
    if (!c || !g) return false
    g.drawImage(s.img, tile.column * s.fw, tile.row * s.fh, s.fw, s.fh, 0, 0, c.width, c.height)
    f.tile = tile.index
    f.shownAt = now
    swap(f, now)
    return true
  }

  stop() {
    clearInterval(this.timer)
    if (this.img) this.img.onload = null
  }
}
