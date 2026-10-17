// Left/Right in the Player (docs/tv-spec.md 6.3): 10 s, and pressed again within a second 30, then 60, then 120 s. The
// step comes from the press timing alone, so it is pure. MediaRewind/FastForward are a flat 60 s.

export const RAMP_S = [10, 30, 60, 120] as const
/** A press this soon after the last one climbs the ramp. */
export const RAMP_WINDOW_MS = 1000
export const REW_FF_S = 60

export interface SeekRamp {
  /** Index into RAMP_S of the last step taken. */
  level: number
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
 * direction, is 10 s; each press within the window of the last in the same direction takes the next rung, and the top
 * rung (120 s) stays.
 */
export function nextSeekStep(prev: SeekRamp | null, dir: 1 | -1, now: number): SeekStep {
  const climb = prev != null && prev.dir === dir && now - prev.at <= RAMP_WINDOW_MS && now >= prev.at
  const level = climb ? Math.min(RAMP_S.length - 1, prev!.level + 1) : 0
  return { step: RAMP_S[level]!, ramp: { level, at: now, dir } }
}

/** "+30 s" / "−10 s" for the large number in the middle of the video. */
export const stepLabel = (dir: 1 | -1, step: number): string => `${dir > 0 ? "+" : "−"}${step} s`
