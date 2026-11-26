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

/** What the players' quality pick shows: "Original", "1080p", "720p", "480p". */
export const qualityLabel = (q: LiveQuality): string => (q === "orig" ? "Original" : `${q}p`);

/**
 * The quality kept when the Player moves to another Copy (a switch or a failover): the pick stays when that Copy
 * offers it, else Original. Never remembered past the play (home-server-spec 7.1).
 */
export const keepQuality = (q: LiveQuality, width: number | null, height: number | null): LiveQuality => (qualityOptions(width, height).includes(q) ? q : "orig");

/**
 * How the desktop Player plays a Live stream (home-server-spec 7.2): natively when the element answers
 * `canPlayType('application/vnd.apple.mpegurl')` ("maybe" or "probably"), else through hls.js when Media Source
 * Extensions are there, else not at all.
 */
export const hlsMode = (canPlayHls: string, hlsJsSupported: boolean): "native" | "hlsjs" | null => (canPlayHls !== "" ? "native" : hlsJsSupported ? "hlsjs" : null);

/** The 503 `busy` answer of `/live/...` (home-server-spec 7.2): "‹server› is busy streaming to ‹devices›". */
export function busyMessage(streams: readonly { device: string; title: string }[] | null | undefined, server = "The server"): string {
  const who = (streams ?? []).map((s) => (s.title ? `${s.device} (${s.title})` : s.device)).join(" and ");
  return `${server} is busy streaming to ${who || "other devices"}`;
}

/** A `/live/...` answer read as the busy holders (a 503 `{ error: "busy", streams }`), else null (anything else). */
export function readBusy(status: number, body: unknown): { device: string; title: string }[] | null {
  if (status !== 503 || !body || typeof body !== "object") return null;
  const b = body as { error?: unknown; streams?: unknown };
  if (b.error !== "busy") return null;
  if (!Array.isArray(b.streams)) return [];
  return b.streams
    .filter((s): s is { device: string; title?: unknown } => !!s && typeof (s as { device?: unknown }).device === "string")
    .map((s) => ({ device: s.device, title: typeof s.title === "string" ? s.title : "" }));
}
