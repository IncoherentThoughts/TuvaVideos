// Scrub-strip geometry (spec 3.5). Pure.

export const STRIP_MAX_FRAMES = 100;
export const STRIP_COLUMNS = 10;
export const STRIP_FRAME_WIDTH = 160;

export interface StripGeometry {
  frames: number;
  columns: number;
  rows: number;
}

/** N = min(100, floor(duration)) frames; 10 columns x ceil(N/10) rows. Under 2 frames there is no strip. */
export function stripGeometry(durationS: number | null | undefined): StripGeometry | null {
  if (durationS == null || !Number.isFinite(durationS)) return null;
  const frames = Math.min(STRIP_MAX_FRAMES, Math.floor(durationS));
  if (frames < 2) return null;
  const columns = Math.min(STRIP_COLUMNS, frames);
  return { frames, columns, rows: Math.ceil(frames / columns) };
}

/** Time in seconds of the centre of slice `i` (0-based) of `frames` equal slices. */
export function sliceCentre(durationS: number, frames: number, i: number): number {
  return (durationS * (i + 0.5)) / frames;
}

export interface Tile {
  index: number;
  column: number;
  row: number;
}

/** Which tile shows time `t`: slice i covers [i*D/N, (i+1)*D/N). */
export function tileForTime(t: number, durationS: number, g: StripGeometry): Tile {
  const raw = Math.floor((Math.max(0, t) / durationS) * g.frames);
  const index = Math.min(g.frames - 1, Math.max(0, raw));
  return { index, column: index % g.columns, row: Math.floor(index / g.columns) };
}
