// Left/Right in the Player (docs/tv-spec.md 6.3): 10 s, and kept pressing (each press within a second of the last) four
// presses on each rung before the next: 30, then 60, then 120 s. The step comes from the press timing alone, so it is
// pure. MediaRewind/FastForward are a flat 60 s. A held key (the remote's auto-repeat) steps at most once per
// HOLD_REPEAT_MS, and its step grows with how long the key has been held (HOLD_TIERS), the way YouTube's TV app scrubs:
// time held, not repeats counted, so the pace is bounded (audit TV-3 counted repeats as presses and ran away).

export const RAMP_S = [10, 30, 60, 120] as const
/** A press this soon after the last one climbs the ramp. */
export const RAMP_WINDOW_MS = 1000
/** Presses taken on a rung before the next one: a few 10 s jumps stay 10 s jumps. */
export const PRESSES_PER_RUNG = 4
export const REW_FF_S = 60
/** A held key steps at most this often (auto-repeat arrives every 30-100 ms). */
export const HOLD_REPEAT_MS = 250
/**
 * A held key's step by time held since the press that started it (ms, seconds): 10 s, 20 s after 1.5 s, 30 s after
 * 3 s, 60 s after 5 s. At four steps a second that is 40, 80, 120 and 240 s per second: a 5 s hold moves 7 minutes.
 */
export const HOLD_TIERS: readonly (readonly [number, number])[] = [
  [0, 10],
  [1500, 20],
  [3000, 30],
  [5000, 60],
]

/** The held step after `heldMs` of holding. */
export const holdStep = (heldMs: number): number => {
  let s = HOLD_TIERS[0]![1]
  for (const [at, step] of HOLD_TIERS) if (heldMs >= at) s = step
  return s
}

export interface SeekRamp {
  /** Index into RAMP_S of the last step taken. */
  level: number
  /** Presses taken on that rung so far (1 after the first). */
  count: number
  at: number
  dir: 1 | -1
  /** When the press that the current hold grew from was taken (ms): the hold tiers count from it. */
  pressAt: number
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
  return { step: RAMP_S[level]!, ramp: { level, count, at: now, dir, pressAt: now } }
}

/** Is an auto-repeat at `now` due a step, given the last step at `lastAt` (ms)? Repeats in between are dropped. */
export const repeatDue = (lastAt: number | null, now: number): boolean => lastAt == null || now < lastAt || now - lastAt >= HOLD_REPEAT_MS

/**
 * The step for an auto-repeat of a held arrow at `now`, at most once per HOLD_REPEAT_MS (null: drop this repeat): the
 * hold tier for the time since the press it grew from, or the rung the presses before it reached if that is larger.
 * The press count is not advanced, so letting go and pressing again carries on counting discrete presses (and starts
 * the hold tiers over). A repeat with no step before it in the same direction counts as a press.
 */
export function heldSeekStep(prev: SeekRamp | null, dir: 1 | -1, now: number): SeekStep | null {
  if (prev == null || prev.dir !== dir || now < prev.at || now - prev.at > RAMP_WINDOW_MS) return nextSeekStep(prev, dir, now)
  if (!repeatDue(prev.at, now)) return null
  return { step: Math.max(RAMP_S[prev.level]!, holdStep(now - prev.pressAt)), ramp: { ...prev, at: now } }
}

/** "+30 s" / "−10 s" for the large number in the middle of the video. */
export const stepLabel = (dir: 1 | -1, step: number): string => `${dir > 0 ? "+" : "−"}${step} s`
