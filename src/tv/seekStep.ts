// Left/Right in the Player (docs/tv-spec.md 6.3): 10 s, and kept pressing (each press within a second of the last) four
// presses on each rung before the next: 30, then 60, then 120 s. The step comes from the press timing alone, so it is
// pure. MediaRewind/FastForward are a flat 60 s.

export const RAMP_S = [10, 30, 60, 120] as const
/** A press this soon after the last one climbs the ramp. */
export const RAMP_WINDOW_MS = 1000
/** Presses taken on a rung before the next one: a few 10 s jumps stay 10 s jumps. */
export const PRESSES_PER_RUNG = 4
export const REW_FF_S = 60

export interface SeekRamp {
  /** Index into RAMP_S of the last step taken. */
  level: number
  /** Presses taken on that rung so far (1 after the first). */
  count: number
  at: number
  dir: 1 | -1
}

export interface SeekStep {
  /** Seconds to move, always positive. */
  step: number
  ramp: SeekRamp
}

/**
 * The step for a press at `now` (ms). The first press, one more than a second after the last, or one in the other
 * direction, is 10 s; presses within the window of the last in the same direction stay on a rung for PRESSES_PER_RUNG
 * presses and then take the next, and the top rung (120 s) stays.
 */
export function nextSeekStep(prev: SeekRamp | null, dir: 1 | -1, now: number): SeekStep {
  const climb = prev != null && prev.dir === dir && now - prev.at <= RAMP_WINDOW_MS && now >= prev.at
  let level = 0
  let count = 1
  if (climb) {
    const up = prev!.count >= PRESSES_PER_RUNG && prev!.level < RAMP_S.length - 1
    level = up ? prev!.level + 1 : prev!.level
    count = up ? 1 : prev!.count + 1
  }
  return { step: RAMP_S[level]!, ramp: { level, count, at: now, dir } }
}

/** "+30 s" / "−10 s" for the large number in the middle of the video. */
export const stepLabel = (dir: 1 | -1, step: number): string => `${dir > 0 ? "+" : "−"}${step} s`
