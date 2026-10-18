// Playing from (spec 4.4): the ordered Video ids the Player steps through, snapshotted when the Player opens.

export type PlayingSource = "library" | "favorites" | "search";

export interface PlayingFrom {
  source: PlayingSource;
  ids: string[];
}

export const SOURCE_LABEL: Record<PlayingSource, string> = { library: "Library", favorites: "Favorites", search: "Search" };

/** De-duplicate keeping the first occurrence (a Favorites list holds a Video row and Chapter rows of one Video). */
export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** Position of `videoId` as "n of N" (1-based), or null when it is not in the list. */
export function positionIn(pf: PlayingFrom, videoId: string): { n: number; total: number } | null {
  const i = pf.ids.indexOf(videoId);
  return i < 0 ? null : { n: i + 1, total: pf.ids.length };
}

/**
 * The Video `dir` steps away from `videoId`, wrapping at both ends and skipping ids `playable` rejects.
 * Null when the current id is not in the list or nothing else is playable.
 */
export function stepFrom(pf: PlayingFrom, videoId: string, dir: 1 | -1, playable: (id: string) => boolean = () => true): string | null {
  const n = pf.ids.length;
  const start = pf.ids.indexOf(videoId);
  if (start < 0 || n < 2) return null;
  for (let k = 1; k < n; k++) {
    const id = pf.ids[(((start + dir * k) % n) + n) % n]!;
    if (id !== videoId && playable(id)) return id;
  }
  return null;
}

/** Keep the existing snapshot when it still holds the Video (a reload, or stepping); otherwise fall back to library order. */
export function resolvePlayingFrom(saved: PlayingFrom | null, videoId: string, libraryIds: readonly string[]): PlayingFrom {
  if (saved && saved.ids.includes(videoId)) return saved;
  return { source: "library", ids: [...libraryIds] };
}
