// The Playing-from snapshot in the browser (spec 4.4). Taken when a list opens a Video; kept in sessionStorage so a
// reload of /play/:id keeps stepping through the same list. Pure logic lives in src/shared/playingFrom.ts.
import { uniqueIds, type PlayingFrom, type PlayingSource } from "../shared/playingFrom";

const KEY = "tuva.playingFrom";
let mem: PlayingFrom | null = null;
const subs = new Set<() => void>();

/** Re-render hook for the Now playing screen: a list can snapshot while the same Video is already open. */
export function onPlayingFromChange(f: () => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}

export function savePlayingFrom(source: PlayingSource, ids: readonly number[]) {
  mem = { source, ids: uniqueIds(ids) };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(mem));
  } catch {}
  subs.forEach((f) => f());
}

export function loadPlayingFrom(): PlayingFrom | null {
  if (mem) return mem;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as PlayingFrom;
    if (j && Array.isArray(j.ids) && (j.source === "library" || j.source === "favorites" || j.source === "search")) return (mem = j);
  } catch {}
  return null;
}
