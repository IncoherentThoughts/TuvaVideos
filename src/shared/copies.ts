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
