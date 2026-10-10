// Resume rules (spec 4.3): written every 5 s while playing and on pause, seek, Copy switch and page leave;
// a position within 30 s of the end counts as finished and reopens at 0. Pure; the server applies the same rule.

export const RESUME_INTERVAL_MS = 5000;
export const FINISHED_WITHIN_S = 30;

/** Within the last 30 s of a known duration. An unknown duration is never finished. */
export function isFinished(positionS: number, durationS: number | null | undefined): boolean {
  return durationS != null && Number.isFinite(durationS) && durationS > 0 && positionS >= durationS - FINISHED_WITHIN_S;
}

/** What gets stored for a position: finished -> 0, otherwise the position (never negative, 2 decimals). */
export function storedResume(positionS: number, durationS: number | null | undefined): number {
  if (!Number.isFinite(positionS) || positionS <= 0) return 0;
  if (isFinished(positionS, durationS)) return 0;
  return Math.round(positionS * 100) / 100;
}

/** Where a Video opens: an explicit `?t=` wins; else the Resume position unless finished; else 0. */
export function startPosition(opts: { t: number | null; resumeS: number | null; durationS: number | null }): number {
  const { t, resumeS, durationS } = opts;
  if (t != null && Number.isFinite(t) && t >= 0) {
    return durationS != null && durationS > 0 ? Math.min(t, Math.max(0, durationS - 0.5)) : t;
  }
  if (resumeS == null || !Number.isFinite(resumeS) || resumeS <= 0) return 0;
  return isFinished(resumeS, durationS) ? 0 : resumeS;
}

/** The 5 s cadence: due when playing and at least the interval since the last write. Event writes restart the clock. */
export class ResumeClock {
  private last = Number.NEGATIVE_INFINITY;
  constructor(private intervalMs = RESUME_INTERVAL_MS) {}
  /** Call on a timer. Returns true (and restarts the clock) when a periodic write is due. */
  tick(now: number, playing: boolean): boolean {
    if (!playing) return false;
    if (this.last === Number.NEGATIVE_INFINITY) {
      this.last = now; // the first tick of a play starts the clock; nothing to write yet
      return false;
    }
    if (now - this.last < this.intervalMs) return false;
    this.last = now;
    return true;
  }
  /** An event write (pause, seek, Copy switch, leave) happened: the next periodic write is a full interval away. */
  wrote(now: number) {
    this.last = now;
  }
  /** Playback stopped: the next play starts a fresh interval. */
  stopped() {
    this.last = Number.NEGATIVE_INFINITY;
  }
}
