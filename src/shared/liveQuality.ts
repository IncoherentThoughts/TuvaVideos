// The qualities a Live stream is made at (docs/home-server-spec.md 7.1). Shared by the server (the `?q=` of
// `/live/:copyId/index.m3u8`) and the players' quality pick. A quality is a size on the short edge, so a portrait
// 1080x1920 Copy is a 1080p Copy.

export type LiveQuality = "orig" | "1080" | "720" | "480";

export const LIVE_QUALITIES: readonly LiveQuality[] = ["orig", "1080", "720", "480"];

export const parseLiveQuality = (q: string | null): LiveQuality | null => (q == null || q === "" ? "orig" : (LIVE_QUALITIES as readonly string[]).includes(q) ? (q as LiveQuality) : null);

/** The short edge of a Copy, or null when neither side is known. */
export function shortEdge(width: number | null, height: number | null): number | null {
  if (width && height) return Math.min(width, height);
  return height || width || null;
}

/** Original first, then each smaller size below the Copy's own: a quality at or above the Copy's size is not offered. */
export function qualityOptions(width: number | null, height: number | null): LiveQuality[] {
  const edge = shortEdge(width, height);
  return LIVE_QUALITIES.filter((q) => q === "orig" || (edge != null && Number(q) < edge));
}

/** A Live stream's segment length: its playlist entries, its forced keyframes, and where a seek over it snaps to. */
export const LIVE_SEGMENT_S = 10;

/** Segment starts, the points a seek over a Live stream snaps to (home-server-spec 7.2). */
export const liveSegmentStarts = (durationS: number | null): number[] =>
  durationS && durationS > 0 ? Array.from({ length: Math.ceil(durationS / LIVE_SEGMENT_S - 1e-9) }, (_, i) => i * LIVE_SEGMENT_S) : [0];
