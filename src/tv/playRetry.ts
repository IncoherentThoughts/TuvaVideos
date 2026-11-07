// What the Player does when its <video> reports an error (docs/tv-spec.md 6.6, audit TV-2). A lost TV Server or a
// dropped stream is transient: retry the same Copy with backoff and play on once the server answers again. Only a Copy
// that keeps failing while the server answers (a decode error, a format the TV cannot play) is marked failed, with the
// "did not play (codecs)" message. Pure.

/** `MediaError.code` values (the constants are not on every engine's global). */
export const MEDIA_ERR_ABORTED = 1
export const MEDIA_ERR_NETWORK = 2

/** Network errors in a row, with the server answering, before the Copy counts as unavailable (not failed). */
export const NET_TRIES_WITH_SERVER = 4
/** The one retry of a Copy that failed to decode while the server answered (a drive hiccup can look like one). */
export const DECODE_RETRY_MS = 1500

/** The wait before network retry `n` (1-based): 1.5, 3, 5, 8, 12, then every 15 s. */
export function retryDelayMs(n: number): number {
  const steps = [1500, 3000, 5000, 8000, 12000]
  return n > steps.length ? 15000 : steps[Math.max(0, n - 1)]!
}

export interface PlayErrorFacts {
  /** `GET /api/videos/:id` answered just now. */
  serverAnswered: boolean
  /** The element's `error.code`, null when there is none. */
  code: number | null
  /** The Copy is still Available and not Missing (from the fresh answer, else the last known one). */
  intact: boolean
  /** The decode retry was already spent on this Copy. */
  decodeRetried: boolean
  /** Network retries already made in a row while the server answered (reset when a load succeeds). */
  netTries: number
  /**
   * Retries made while the server did not answer (reset when a load succeeds). Counted apart from `netTries`: an
   * outage (the Mac asleep) must not spend the budget a stream error gets once the server is back.
   */
  outageTries: number
}

export type PlayErrorAction =
  /**
   * Try the same Copy again after `ms`; `net`: a network retry (says "reconnecting"), counted in `outageTries` when
   * `outage` (the server did not answer), else in `netTries`.
   */
  | { t: "retry"; ms: number; net: boolean; outage?: true }
  /** Give the Copy up: fail over to the next one, else "Copy unavailable" (`failed` false) or the codecs message. */
  | { t: "lose"; failed: boolean }

export function onPlayError(f: PlayErrorFacts): PlayErrorAction {
  if (!f.serverAnswered) return { t: "retry", ms: retryDelayMs(f.outageTries + 1), net: true, outage: true } // the TV Server is gone for now: keep trying
  if (!f.intact) return { t: "lose", failed: false } // the Root unmounted or the file went Missing
  if (f.code === MEDIA_ERR_NETWORK || f.code === MEDIA_ERR_ABORTED) {
    return f.netTries < NET_TRIES_WITH_SERVER ? { t: "retry", ms: retryDelayMs(f.netTries + 1), net: true } : { t: "lose", failed: false }
  }
  return f.decodeRetried ? { t: "lose", failed: true } : { t: "retry", ms: DECODE_RETRY_MS, net: false }
}
