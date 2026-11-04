// Rules for the web app's in-memory copies of the library (src/web/data.ts): when a Sync means "reload", and a
// Favorite change applied to one Video only. Pure.

/** The library with one Video's `favoritedAt` set; every other row (and a Video no longer there) is left as it is. */
export const withFavorite = <V extends { id: string; favoritedAt: string | null }>(videos: V[], id: string, favoritedAt: string | null): V[] =>
  videos.map((v) => (v.id === id ? { ...v, favoritedAt } : v));

export interface SyncSeen {
  at: string | null;
}

/**
 * Whether a Sync landed since the last look, from the Session record's `lastSyncAt` (written by each successful Sync,
 * in this tab or, through the record broadcast, in another). The first value seen once the record loaded is the
 * baseline, not a Sync; a cleared record (sign-out) is not one either.
 */
export function syncLanded(seen: SyncSeen | null, recordLoaded: boolean, lastSyncAt: string | null): { seen: SyncSeen | null; reload: boolean } {
  if (!recordLoaded) return { seen, reload: false };
  if (!seen) return { seen: { at: lastSyncAt }, reload: false };
  if (lastSyncAt === seen.at) return { seen, reload: false };
  return { seen: { at: lastSyncAt }, reload: lastSyncAt != null };
}
