// The Video's saved Audio settings on the TV (docs/tv-spec.md 6.8), through the browser's Web Audio chain
// (src/web/audioEngine.ts). Whether the R85H will route a <video> through Web Audio is unknown until it is tried, so the
// chain is made lazily on the first `play`, and the tag row says what happened:
//   "audio: web audio"  the chain is built and its context is running
//   "audio: untouched"  the context would not run, or building the chain threw: the sound plays as the file has it
// A Video whose settings are the defaults never passes through the chain (as in the browser) and says nothing.
// The controller is pure over `ChainDeps`, so a test drives the fallbacks with fakes.
import { isDefaultAudio, type AudioState } from "../shared/audio"

export type AudioMode = "none" | "pending" | "on" | "untouched"

export interface ChainHandle {
  set(s: AudioState): void
  dispose(): void
}

export interface ChainDeps {
  /** Is the AudioContext running and its clock moving? */
  probe(): Promise<boolean>
  /** Routes the element through the chain; throws when the browser will not. */
  build(el: HTMLMediaElement): ChainHandle
}

export interface ChainResult {
  mode: AudioMode
  /** Why it is untouched, for the console. */
  why?: string
  /** The element may have been captured by the context (a throw after createMediaElementSource, or a context that stalled
   *  after it): its sound cannot be given back, the caller replaces the element. */
  tainted: boolean
}

/** The tag-row text for a mode; null says nothing. */
export function audioTag(mode: AudioMode): string | null {
  switch (mode) {
    case "on": return "audio: web audio"
    case "untouched": return "audio: untouched"
    case "pending": return "audio: …"
    case "none": return null
  }
}

export class AudioChain {
  private handle: ChainHandle | null = null
  constructor(private deps: ChainDeps) {}

  private warmed: Promise<boolean> | null = null

  /** Wakes the AudioContext ahead of the first `play` (no chain yet) so the chain can be built the moment play fires. */
  warm(state: AudioState | null): void {
    if (state && !isDefaultAudio(state) && !this.warmed) this.warmed = this.deps.probe().catch(() => false)
  }

  /** Call at the first `play` of an element with the Video's saved settings. Never throws. */
  async start(el: HTMLMediaElement, state: AudioState | null, onMode?: (m: AudioMode) => void): Promise<ChainResult> {
    if (!state || isDefaultAudio(state)) return { mode: "none", tainted: false }
    onMode?.("pending")
    if (!(await (this.warmed ?? this.deps.probe()).catch(() => false))) return { mode: "untouched", why: "the AudioContext would not run", tainted: false }
    try {
      this.handle = this.deps.build(el)
      this.handle.set(state)
    } catch (e) {
      this.dispose()
      return { mode: "untouched", why: `building the chain threw: ${(e as Error)?.message ?? e}`, tainted: true }
    }
    if (!(await this.deps.probe().catch(() => false))) {
      this.dispose()
      return { mode: "untouched", why: "the AudioContext stalled after the chain was built", tainted: true }
    }
    return { mode: "on", tainted: false }
  }

  dispose(): void {
    try {
      this.handle?.dispose()
    } catch {
      /* the element is being replaced or torn down anyway */
    }
    this.handle = null
  }
}
