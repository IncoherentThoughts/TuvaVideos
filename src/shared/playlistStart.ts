// Starting a Playlist from a list page (spec 4.8 "Starting one"): the Entries each page's shuffle button hands to
// startPlaylist. Pure; the buttons themselves live in Library.tsx, SearchResults.tsx and Favorites.tsx.
import type { LibraryState } from "./libraryView";
import type { Entry, PlaylistSource } from "./playlist";

/** Most Entries a search-results Playlist holds (the results page's own cap). */
export const SEARCH_ENTRY_CAP = 500;

/** Does the Library grid apply any filter? (`song` and `artist` narrow it too; sort only reorders.) */
export function libraryFiltered(st: LibraryState): boolean {
  return st.types.length > 0 || st.availableOnly || st.fav || st.artist != null || st.song != null;
}

export const videoEntries = (videoIds: readonly number[]): Entry[] => videoIds.map((videoId) => ({ videoId }));

/** The Library grid as shown: Video Entries; the whole library is "library-all", anything narrower is "library". */
export function libraryStart(videoIds: readonly number[], filtered: boolean): { entries: Entry[]; source: PlaylistSource } {
  return { entries: videoEntries(videoIds), source: filtered ? "library" : "library-all" };
}

/** The search result list as shown, capped. */
export function searchEntries(videoIds: readonly number[]): Entry[] {
  return videoEntries(videoIds.slice(0, SEARCH_ENTRY_CAP));
}

/** A Favorites row: a Video row is a Video Entry, a Chapter row a Chapter Entry (both starred give two Entries). */
export type FavoriteRow = { kind: "video"; videoId: number } | { kind: "chapter"; videoId: number; chapterId: number; startS: number };

export const favoriteEntries = (rows: readonly FavoriteRow[]): Entry[] =>
  rows.map((r) => (r.kind === "video" ? { videoId: r.videoId } : { videoId: r.videoId, chapterId: r.chapterId }));

/** Where the Player opens `e` of `rows`: the Chapter's start for a Chapter Entry, null (the Video's start) otherwise. */
export function favoriteStartS(rows: readonly FavoriteRow[], e: Entry): number | null {
  if (e.chapterId === undefined) return null;
  const r = rows.find((x) => x.kind === "chapter" && x.chapterId === e.chapterId);
  return r && r.kind === "chapter" ? r.startS : null;
}
