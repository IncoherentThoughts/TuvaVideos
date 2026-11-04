// Unsaved lyrics editor drafts, kept for the page's life (WEB-4). The drawer's editor can go away under the user: the
// playhead enters a Chapter with another Song, Now playing moves to the next Video, the drawer closes. What was typed
// is kept here per Song and Version, and the Reader offers to go on with it. A save, a delete or Cancel drops it. Pure
// (one in-memory map), so it can be tested.

export interface StashedDraft<D = unknown> {
  songId: string;
  /** The Local Version being edited; null for a new one. */
  versionId: string | null;
  label: string;
  drafts: D;
}

const key = (songId: string, versionId: string | null) => `${songId}\u0000${versionId ?? ""}`;

export function createDraftStash<D>() {
  const map = new Map<string, StashedDraft<D>>();
  return {
    /** Keep (or replace) the draft for this Song and Version. */
    put(d: StashedDraft<D>) {
      map.set(key(d.songId, d.versionId), d);
    },
    get(songId: string, versionId: string | null): StashedDraft<D> | null {
      return map.get(key(songId, versionId)) ?? null;
    },
    /** The Song's drafts, a new Version's first. */
    forSong(songId: string): StashedDraft<D>[] {
      return [...map.values()].filter((d) => d.songId === songId).sort((a, b) => (a.versionId === null ? -1 : b.versionId === null ? 1 : 0));
    },
    drop(songId: string, versionId: string | null) {
      map.delete(key(songId, versionId));
    },
    get size() {
      return map.size;
    },
  };
}
