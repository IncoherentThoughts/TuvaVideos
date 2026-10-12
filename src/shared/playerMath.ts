// Pure arithmetic of the Player: frame stepping from r_frame_rate, speed, volume, clamped seeks, A-B loop, time formats.

/** Used when a Copy has no r_frame_rate. */
export const FALLBACK_FPS = 30;

/** "30000/1001" -> 29.97; null when absent, zero or malformed. */
export function parseFrameRate(r: string | null | undefined): number | null {
  if (!r) return null;
  const [n, d] = r.split("/").map(Number);
  if (!n || !Number.isFinite(n)) return null;
  const v = d ? n / d : n;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Frame number shown for time `t` (frame 0 starts at 0). */
export function frameNumber(t: number, fps: number): number {
  return Math.round(Math.max(0, t) * fps);
}

/** Half a millisecond past the frame boundary so the decoder presents frame n, not n-1, for a float time n/fps. */
const FRAME_EPS = 5e-4;

/** Target time of a frame step: the presentation time of the neighbouring frame, clamped to [0, last frame]. */
export function frameStepTarget(t: number, fps: number, dir: 1 | -1, durationS?: number | null): number {
  const n = Math.max(0, frameNumber(t, fps) + dir);
  let target = n / fps + FRAME_EPS;
  if (durationS != null && Number.isFinite(durationS) && durationS > 0) {
    const last = Math.max(0, Math.ceil(durationS * fps) - 1) / fps;
    target = Math.min(target, last + FRAME_EPS);
  }
  return target;
}

export const SPEED_MIN = 0.1;
export const SPEED_MAX = 8;

/** Additive speed, rounded to one decimal so 1.0 +0.1 -0.1 returns to exactly 1.0. */
export function speedBy(rate: number, delta: number): number {
  const r = Math.round((rate + delta) * 10) / 10;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, r));
}

/** Volume in 0..1, stepped in whole percent points. */
export function volumeBy(volume: number, deltaPercent: number): number {
  const pct = Math.round(volume * 100) + deltaPercent;
  return Math.min(100, Math.max(0, pct)) / 100;
}

export function clampTime(t: number, durationS: number | null | undefined): number {
  const max = durationS != null && Number.isFinite(durationS) && durationS > 0 ? durationS : Infinity;
  return Math.min(max, Math.max(0, t));
}

// ---- A-B loop (l: set A, set B, off) ----

export interface AbLoop {
  a: number | null;
  b: number | null;
}
export const AB_OFF: AbLoop = { a: null, b: null };

export function abToggle(ab: AbLoop, t: number): { ab: AbLoop; label: string } {
  if (ab.a == null) return { ab: { a: t, b: null }, label: "A-B loop: A set" };
  if (ab.b == null) {
    const [a, b] = t < ab.a ? [t, ab.a] : [ab.a, t];
    if (b - a < 0.05) return { ab, label: "A-B loop: B must be later than A" };
    return { ab: { a, b }, label: "A-B loop: B set" };
  }
  return { ab: AB_OFF, label: "A-B loop: off" };
}

/** A complete loop with both ends in order, else null (a half-set A is nothing worth keeping). */
export type StoredLoop = { a: number; b: number };
export function storedLoop(ab: AbLoop | StoredLoop | null | undefined): StoredLoop | null {
  if (!ab || ab.a == null || ab.b == null) return null;
  if (!Number.isFinite(ab.a) || !Number.isFinite(ab.b) || ab.a < 0 || ab.b - ab.a < 0.05) return null;
  return { a: ab.a, b: ab.b };
}

/** The time to jump back to when playback has run past B (or ended with only A set), else null. */
export function abLoopTarget(ab: AbLoop, t: number, ended = false): number | null {
  if (ab.a == null) return null;
  if (ab.b != null) return t >= ab.b ? ab.a : null;
  return ended ? ab.a : null;
}

// ---- formats ----

export function fmtClock(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "–:––";
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
