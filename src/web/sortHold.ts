// Playing a Video bumps its view count and last-played time, and the Library, Favorites and Search sort by those.
// Re-sorting at once moves the Video you just opened, so Back lands on a list that is no longer where you left it.
// So a Video played in this tab keeps the sort keys it had before its first play here: the count shown is live,
// the order is not. A page reload starts a fresh tab state and sorts by the real values. Not persisted on purpose.
import type { SortKeys } from "../shared/libraryView";
import type { VideoDto } from "../shared/types";

const held = new Map<string, SortKeys>();

/** Before recording a play: remember the Video's sort keys, unless an earlier play in this tab already did. */
export function holdSortKeys(v: VideoDto) {
  if (!held.has(v.id)) held.set(v.id, { viewCount: v.viewCount, lastPlayedAt: v.lastPlayedAt });
}

/** An explicit edit (Reset views) should show in the order: sort that Video by its real values again. */
export const releaseSortKeys = (id: string) => void held.delete(id);

/** The values lists sort a Video by. */
export const sortKeysOf = (v: VideoDto): SortKeys => held.get(v.id) ?? v;
