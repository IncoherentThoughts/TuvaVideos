// Playlist (spec 4.8): the Entries the Player plays through on its own once a shuffle starts one. Pure state and
// transitions; the browser store that keeps one per tab lives in src/web/playlist.ts.
import type { PlayingSource } from "./playingFrom";

export type PlaylistSource = PlayingSource | "library-all";
export type Repeat = "off" | "list" | "one";

/** A Video, or a Chapter of one (a Favorite Chapter) that plays from the Chapter's start to the next Chapter's. */
export interface Entry {
  videoId: string;
  chapterId?: string;
}

export interface Playlist {
  source: PlaylistSource;
  entries: Entry[];
  /** The Play order: a permutation of indices into `entries`. Before `cursor` is Played, after it is upcoming. */
  order: number[];
  /** Position in `order` of the current Entry. */
  cursor: number;
  shuffled: boolean;
  repeat: Repeat;
}

export type Rng = () => number;
export type Playable = (videoId: string) => boolean;

export const SOURCE_LABEL: Record<PlaylistSource, string> = {
  library: "Library",
  favorites: "Favorites",
  search: "Search",
  "library-all": "Library",
};

const REPEATS: Repeat[] = ["off", "list", "one"];
const SOURCES: PlaylistSource[] = ["library", "favorites", "search", "library-all"];

/** Fisher–Yates over a copy of `xs`, uniform for a uniform `rng`. */
export function shuffle<T>(xs: readonly T[], rng: Rng = Math.random): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** `indices` in source order from `from` on, wrapping: the sequential Play order of what is left. */
function sequential(indices: readonly number[], from: number, n: number): number[] {
  return [...indices].sort((a, b) => (((a - from) % n) + n) % n - ((((b - from) % n) + n) % n));
}

export interface StartOptions {
  source: PlaylistSource;
  shuffled?: boolean;
  /** Index into `entries` of the first Entry; a random one when omitted. */
  startAt?: number;
  rng?: Rng;
}

/** A new Playlist at its first Entry: shuffled by default, Repeat off, nothing Played yet. */
export function startPlaylist(entries: readonly Entry[], opts: StartOptions): Playlist {
  const rng = opts.rng ?? Math.random;
  const n = entries.length;
  const shuffled = opts.shuffled ?? true;
  const startAt = n === 0 ? 0 : Math.min(n - 1, Math.max(0, opts.startAt ?? Math.floor(rng() * n)));
  const rest = entries.map((_, i) => i).filter((i) => i !== startAt);
  const order = n === 0 ? [] : [startAt, ...(shuffled ? shuffle(rest, rng) : sequential(rest, startAt, n))];
  return { source: opts.source, entries: [...entries], order, cursor: 0, shuffled, repeat: "off" };
}

/** The current Entry, or null for an empty Playlist. */
export function current(pl: Playlist): Entry | null {
  const i = pl.order[pl.cursor];
  return i === undefined ? null : pl.entries[i]!;
}

/** Entry indices still to play, in Play order. */
export function upcoming(pl: Playlist): number[] {
  return pl.order.slice(pl.cursor + 1);
}

/** Entry indices already finished or skipped past, in the order they were played. */
export function played(pl: Playlist): number[] {
  return pl.order.slice(0, pl.cursor);
}

/** "n of N" for the current Entry. */
export function position(pl: Playlist): { n: number; total: number } {
  return { n: Math.min(pl.cursor + 1, pl.order.length), total: pl.order.length };
}

/**
 * Turn the Play order shuffled or sequential. Only the upcoming Entries move: turning shuffle on again reshuffles them,
 * turning it off puts them back in source order from the current Entry on. Played Entries keep their order.
 */
export function setShuffled(pl: Playlist, on: boolean, rng: Rng = Math.random): Playlist {
  const head = pl.order.slice(0, pl.cursor + 1);
  const tail = pl.order.slice(pl.cursor + 1);
  const cur = pl.order[pl.cursor] ?? 0;
  const next = on ? shuffle(tail, rng) : sequential(tail, cur, pl.entries.length);
  return { ...pl, shuffled: on, order: [...head, ...next] };
}

/** off → list → one → off. */
export function cycleRepeat(pl: Playlist): Playlist {
  return { ...pl, repeat: REPEATS[(REPEATS.indexOf(pl.repeat) + 1) % REPEATS.length]! };
}

function playableAt(pl: Playlist, pos: number, playable: Playable): boolean {
  const e = pl.entries[pl.order[pos]!]!;
  return playable(e.videoId);
}

/**
 * Move to the next playable Entry (the `n` key, or the end of an Entry with Repeat off or list). Unplayable Entries
 * are skipped past and count as Played. At the end of the list: Repeat list wraps (reshuffling a shuffled Playlist),
 * anything else stays put and reports `ended`. Repeat one is the caller's business — it restarts the Entry instead.
 */
export function advance(pl: Playlist, playable: Playable = () => true, rng: Rng = Math.random): { pl: Playlist; ended: boolean } {
  for (let pos = pl.cursor + 1; pos < pl.order.length; pos++) {
    if (playableAt(pl, pos, playable)) return { pl: { ...pl, cursor: pos }, ended: false };
  }
  if (pl.repeat !== "list" || pl.order.length === 0) return { pl, ended: true };
  const wrapped = pl.shuffled ? { ...pl, order: shuffle(pl.order, rng), cursor: 0 } : { ...pl, order: sequential(pl.order, 0, pl.entries.length), cursor: 0 };
  for (let pos = 0; pos < wrapped.order.length; pos++) {
    if (playableAt(wrapped, pos, playable)) return { pl: { ...wrapped, cursor: pos }, ended: false };
  }
  return { pl, ended: true };
}

/** Move to the previous playable Entry (`N`). Wraps to the end only with Repeat list; otherwise stays at the first. */
export function stepBack(pl: Playlist, playable: Playable = () => true): Playlist {
  for (let pos = pl.cursor - 1; pos >= 0; pos--) {
    if (playableAt(pl, pos, playable)) return { ...pl, cursor: pos };
  }
  if (pl.repeat !== "list") return pl;
  for (let pos = pl.order.length - 1; pos > pl.cursor; pos--) {
    if (playableAt(pl, pos, playable)) return { ...pl, cursor: pos };
  }
  return pl;
}

/** Jump to the Entry at `entryIndex` (a panel row click, Played or upcoming). Everything before it in Play order is Played. */
export function jumpTo(pl: Playlist, entryIndex: number): Playlist {
  const pos = pl.order.indexOf(entryIndex);
  return pos < 0 ? pl : { ...pl, cursor: pos };
}

/**
 * Jump to the Entry for `videoId` when the Playlist holds one: the first upcoming occurrence, else the first in Play
 * order (the current one included). Null when the Video is not in the Playlist, so opening it ends the Playlist.
 */
export function jumpToVideo(pl: Playlist, videoId: string): Playlist | null {
  const at = (pos: number) => pl.entries[pl.order[pos]!]!.videoId === videoId;
  for (let pos = pl.cursor + 1; pos < pl.order.length; pos++) if (at(pos)) return { ...pl, cursor: pos };
  for (let pos = 0; pos <= pl.cursor && pos < pl.order.length; pos++) if (at(pos)) return { ...pl, cursor: pos };
  return null;
}

/** The current Chapter Entry ran past its end (a seek or step): it is a Video Entry for the rest of that Video. */
export function widenToVideo(pl: Playlist): Playlist {
  const i = pl.order[pl.cursor];
  if (i === undefined || pl.entries[i]!.chapterId === undefined) return pl;
  const entries = [...pl.entries];
  entries[i] = { videoId: entries[i]!.videoId };
  return { ...pl, entries };
}

/** A stored Playlist that still has the shape above (sessionStorage can hold anything). */
export function isPlaylist(j: unknown): j is Playlist {
  if (!j || typeof j !== "object") return false;
  const p = j as Playlist;
  if (!SOURCES.includes(p.source) || !REPEATS.includes(p.repeat) || typeof p.shuffled !== "boolean") return false;
  if (!Array.isArray(p.entries) || !Array.isArray(p.order) || p.order.length !== p.entries.length) return false;
  if (!p.entries.every((e) => e && typeof e.videoId === "string" && (e.chapterId === undefined || typeof e.chapterId === "string"))) return false;
  const seen = new Set(p.order);
  if (seen.size !== p.order.length || !p.order.every((i) => Number.isInteger(i) && i >= 0 && i < p.entries.length)) return false;
  return Number.isInteger(p.cursor) && p.cursor >= 0 && (p.cursor < p.order.length || p.order.length === 0);
}
