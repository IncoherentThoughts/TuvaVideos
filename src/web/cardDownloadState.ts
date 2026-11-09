// The card's download states (downloader-spec §8): what one Video's entry in `GET /api/downloads`'s `videos` map shows
// on its card, when the cards poll, and which part of a failed item's log the pop-up opens on. Pure.

import { reasonWords } from "../server/downloads/report";

/** One entry of the snapshot's per-Video map (queue.ts `snapshot().videos`); a fresh success carries only id and state. */
export interface CardItem {
  id: number;
  videoId: string;
  state: string;
  rank?: number | null;
  reason?: string | null;
  estBytes?: number | null;
  exactBytes?: number | null;
  doneBytes?: number | null;
  etaS?: number | null;
}

export type CardState =
  | { kind: "idle"; label: "" }
  | { kind: "queued"; itemId: number; rank: number | null; label: string }
  | { kind: "waiting"; itemId: number; label: string }
  | { kind: "running"; itemId: number; fraction: number | null; label: string }
  | { kind: "merging"; itemId: number; label: string }
  | { kind: "adding"; itemId: number; label: string }
  | { kind: "failed"; itemId: number; reason: string; label: string }
  | { kind: "done"; itemId: number; label: string };

/** "31 s", "4 min", "1 h 5 min". */
export function formatEta(s: number): string {
  const n = Math.max(0, Math.round(s));
  if (n < 60) return `${n} s`;
  if (n < 3600) return `${Math.round(n / 60)} min`;
  const h = Math.floor(n / 3600);
  const m = Math.round((n % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "≈ 120 MB" (decimal units, like the dialog); "size unknown" without an estimate. */
export function formatEstimate(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "size unknown";
  if (bytes >= 1e9) return `≈ ${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `≈ ${Math.round(bytes / 1e6)} MB`;
  return `≈ ${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

/** Downloaded share of the item, 0..1, against its exact size once sized, else its estimate; null when unknown. */
export function progressFraction(i: Pick<CardItem, "doneBytes" | "exactBytes" | "estBytes">): number | null {
  const total = i.exactBytes ?? i.estBytes;
  if (!total || total <= 0 || i.doneBytes == null) return null;
  return Math.min(1, Math.max(0, i.doneBytes / total));
}

/** The card state of one Video's map entry (absent = idle). */
export function cardState(i: CardItem | null | undefined): CardState {
  if (!i) return { kind: "idle", label: "" };
  const itemId = i.id;
  switch (i.state) {
    case "queued": {
      const rank = i.rank ?? null;
      return { kind: "queued", itemId, rank, label: rank === 1 ? "Queued · next" : rank ? `Queued #${rank}` : "Queued" };
    }
    case "waiting":
      return { kind: "waiting", itemId, label: "Waiting" };
    case "sizing":
      return { kind: "running", itemId, fraction: 0, label: "Starting…" };
    case "downloading": {
      const f = progressFraction(i);
      const pct = f == null ? null : `${Math.floor(f * 100)}%`;
      const eta = i.etaS != null && i.etaS >= 0 ? formatEta(i.etaS) : null;
      return { kind: "running", itemId, fraction: f, label: [pct, eta].filter(Boolean).join(" · ") || "Downloading…" };
    }
    case "merging":
      return { kind: "merging", itemId, label: "Merging…" };
    case "scanning":
      return { kind: "adding", itemId, label: "Adding…" };
    case "failed":
      return { kind: "failed", itemId, reason: reasonWords(i.reason ?? null), label: "Failed ▾" };
    case "done":
    case "done_outside":
      return { kind: "done", itemId, label: "✓ Downloaded" };
    default: // cancelled, skipped: nothing left to show
      return { kind: "idle", label: "" };
  }
}

/** Queued (incl. waiting to return to the queue) or running: the states that change by themselves. */
export const isLive = (s: CardState) => s.kind === "queued" || s.kind === "waiting" || s.kind === "running" || s.kind === "merging" || s.kind === "adding";

export const FAST_POLL_MS = 1000;
/** Between fast polls, the cards still re-read the map now and then so a job the dialog started shows up. */
export const SLOW_POLL_MS = 10_000;

/**
 * The polling rule (§6): 1 s while any card on screen is queued or running; otherwise the slow re-read while some
 * download-capable card is on screen, and nothing when none is.
 */
export function pollInterval(onScreen: Iterable<string>, videos: Readonly<Record<string, CardItem | undefined>>): number | null {
  let any = false;
  for (const id of onScreen) {
    any = true;
    if (isLive(cardState(videos[id]))) return FAST_POLL_MS;
  }
  return any ? SLOW_POLL_MS : null;
}

/** Videos whose entry turned `done` since the last snapshot: the grid reloads so their Copy shows. */
export function newlyDone(prev: Readonly<Record<string, CardItem | undefined>>, next: Readonly<Record<string, CardItem | undefined>>): string[] {
  const out: string[] = [];
  for (const [id, i] of Object.entries(next)) if (i && (i.state === "done" || i.state === "done_outside") && prev[id]?.state !== i.state) out.push(id);
  return out;
}

/**
 * The pop-up's log (`/items/:id/log` → `{ lines, errorAt }`): at most `max` lines, the error line kept with a little
 * context after it, and the index (in the returned lines) to scroll to: the error, else the last line.
 */
export function tailAtError(lines: readonly string[], errorAt: number, max = 40, after = 3): { lines: string[]; scrollTo: number } {
  if (lines.length === 0) return { lines: [], scrollTo: -1 };
  const hasError = errorAt >= 0 && errorAt < lines.length;
  const end = hasError ? Math.min(lines.length, errorAt + 1 + after) : lines.length;
  const start = Math.max(0, end - max);
  return { lines: lines.slice(start, end), scrollTo: hasError ? errorAt - start : end - start - 1 };
}

/** A downloadable Video has a source id; hash-only Videos keep the plain Not-on-this-machine mark. */
export const hasSourceId = (v: { youtubeId: string | null; instagramId: string | null; rutubeId: string | null }) => !!(v.youtubeId || v.instagramId || v.rutubeId);
