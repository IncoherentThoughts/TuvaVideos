// Resume and Favorites follow you (docs/home-server-spec.md §6): the wire shapes of `/api/me/*`, the newest-wins rule
// and the outbox's order. Pure.
import type { Identity } from "./homeIndex";

/** `PUT /api/me/resume`: a Resume position, as stored on the writing machine (finished = 0). */
export interface MeResume {
  video: Identity;
  resumeS: number | null;
  resumeAt: string;
}

/** `PUT /api/me/favorite`: a star or unstar of a Video (`startMs` null) or of a Chapter (its start in ms). */
export interface MeFavorite {
  video: Identity;
  startMs: number | null;
  /** Null: unstarred. */
  favoritedAt: string | null;
  favoriteAt: string;
}

/** `GET /api/me/state?since=`: what changed on the Home Server since `since` (its own clock), and the next `since`. */
export interface MeStateDto {
  now: string;
  resume: MeResume[];
  favorites: MeFavorite[];
}

/** `PUT /api/me/favorites`: first connect (§6.2), the laptop's Favorites replace the Home Server's. */
export interface MeReplaceFavorites {
  favorites: { video: Identity; startMs: number | null; favoritedAt: string }[];
}

/** The Export Favorites… file (§6.2), also the Home Server's `favorites.before-home-sync-<date>.json`. */
export interface FavoritesFile {
  app: "TuvaVideos";
  kind: "favorites";
  version: 1;
  exportedAt: string;
  machine: string;
  favorites: { id: string; youtubeId: string | null; contentHash: string | null; title: string; startMs: number | null; chapterTitle: string | null; favoritedAt: string }[];
}

/** A Chapter's key between machines: its start, in whole ms (§6.1). */
export const chapterStartMs = (startS: number) => Math.round(startS * 1000);

/** Newest wins (§6.1): the incoming write applies when it is newer than what is stored; a tie keeps what is stored. */
export function newer(incomingAt: string | null | undefined, storedAt: string | null | undefined): boolean {
  if (!incomingAt) return false;
  if (!storedAt) return true;
  const a = Date.parse(incomingAt);
  const b = Date.parse(storedAt);
  if (!Number.isFinite(a)) return false;
  if (!Number.isFinite(b)) return true;
  return a > b;
}

/** The outbox key: a later write of the same thing supersedes an earlier one. */
export const outboxKey = (kind: "resume" | "favorite", video: Identity, startMs: number | null = null) =>
  `${kind}|${video.id}|${startMs ?? ""}`;

/**
 * The outbox in send order (§6.1): oldest first, one entry per key (the last one written; it carries the newest
 * time, and the Home Server keeps the newest anyway). Answers the entries to send and the ids they replace.
 */
export function outboxPlan<T extends { id: number; key: string }>(rows: readonly T[]): { send: T[]; superseded: number[] } {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const last = new Map<string, number>();
  for (const r of sorted) last.set(r.key, r.id);
  const send: T[] = [];
  const superseded: number[] = [];
  for (const r of sorted) {
    if (last.get(r.key) === r.id) send.push(r);
    else superseded.push(r.id);
  }
  return { send, superseded };
}

/** The date part of a backup's name, `favorites.before-home-sync-<date>.json` (local date, YYYY-MM-DD). */
export function backupName(at: Date, taken: (name: string) => boolean): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  const base = `favorites.before-home-sync-${day}`;
  if (!taken(`${base}.json`)) return `${base}.json`;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}.json`)) return `${base}-${i}.json`;
}

/** Checks a parsed Favorites file enough to import it. */
export function parseFavoritesFile(x: unknown): FavoritesFile | null {
  if (!x || typeof x !== "object") return null;
  const f = x as Partial<FavoritesFile>;
  if (f.kind !== "favorites" || !Array.isArray(f.favorites)) return null;
  const ok = f.favorites.every(
    (e) => e && typeof e.id === "string" && typeof e.favoritedAt === "string" && (e.startMs == null || typeof e.startMs === "number"),
  );
  return ok ? (f as FavoritesFile) : null;
}

/** Checks an Identity from a request body. */
export function parseIdentity(x: unknown): Identity | null {
  if (!x || typeof x !== "object") return null;
  const v = x as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id) return null;
  const opt = (k: string) => (typeof v[k] === "string" && v[k] ? (v[k] as string) : null);
  return { id: v.id, youtubeId: opt("youtubeId"), contentHash: opt("contentHash") };
}
