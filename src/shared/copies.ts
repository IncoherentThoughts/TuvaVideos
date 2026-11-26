// Copy choice at play time (spec 4.2). The server already sends Copies ranked best first (local Root, native
// playback, larger resolution, smaller size); these helpers only pick among Available ones.

export interface PickableCopy {
  id: number;
  available: boolean;
}

/** The best Available Copy that has not failed during this play. */
export function bestCopy<T extends PickableCopy>(ranked: readonly T[], failed: ReadonlySet<number> = new Set()): T | null {
  return ranked.find((c) => c.available && !failed.has(c.id)) ?? null;
}

/** When the playing Copy is lost: the next Available Copy in the ranking, never the lost one. */
export function nextCopy<T extends PickableCopy>(ranked: readonly T[], lostId: number | null, failed: ReadonlySet<number> = new Set()): T | null {
  return ranked.find((c) => c.id !== lostId && c.available && !failed.has(c.id)) ?? null;
}

/**
 * Where a Copy is asked for (home-server-spec §5.4): this Mac's `/copy/:id` and `/api/copies/:id`, or for a Home
 * Server Copy the same routes of the Home Server under this Mac's `/home` proxy, by its id there.
 */
export function copyRoutes(c: { id: number; homeId?: number }): { file: string; info: string; keyframes: string } {
  const [pre, id] = c.homeId != null ? ["/home", c.homeId] : ["", c.id];
  return { file: `${pre}/copy/${id}`, info: `${pre}/api/copies/${id}`, keyframes: `${pre}/api/copies/${id}/keyframes` };
}

/**
 * A Copy's Live stream playlist at quality `q` (home-server-spec 7.1, 7.2): this Mac's `/live/:id/index.m3u8?q=`, or
 * the Home Server's through the companion's proxy, `/home/live/:homeId/index.m3u8?q=`. Its segment URIs are relative.
 */
export function liveRoute(c: { id: number; homeId?: number }, q: "orig" | "1080" | "720" | "480"): string {
  const [pre, id] = c.homeId != null ? ["/home", c.homeId] : ["", c.id];
  return `${pre}/live/${id}/index.m3u8?q=${q}`;
}

/** Does this Copy need the "preparing" state before it can be requested as a stream? */
export function needsPrepare(c: { playback: string; fallback: { state: string } }): boolean {
  return c.playback !== "native" && c.fallback.state !== "ready";
}

/** What a 503 body says about a Fallback: still working, or given up. */
export type PrepareStatus = { kind: "wait"; progress: number | null } | { kind: "ready" } | { kind: "failed"; error?: string };

export function readPrepare(f: { state: string; progress?: number | null; error?: string } | null | undefined): PrepareStatus {
  if (!f) return { kind: "wait", progress: null };
  if (f.state === "ready") return { kind: "ready" };
  if (f.state === "failed") return { kind: "failed", error: f.error };
  return { kind: "wait", progress: typeof f.progress === "number" ? f.progress : null };
}
