// The active Playlist in the browser (spec 4.8). One per tab, kept in sessionStorage next to `tuva.playingFrom` so a
// reload of /play/:id carries on with the same Playlist. Pure transitions live in src/shared/playlist.ts; this store only
// holds the current value and tells subscribers when it changes.
import { isPlaylist, startPlaylist as start, type Entry, type Playlist, type StartOptions } from "../shared/playlist";

const KEY = "tuva.playlist";
let mem: Playlist | null | undefined; // undefined until the first load
const subs = new Set<() => void>();

/** Re-render hook for the Player and the Playlist panel. */
export function onPlaylistChange(f: () => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}

function store(pl: Playlist | null) {
  mem = pl;
  try {
    if (pl) sessionStorage.setItem(KEY, JSON.stringify(pl));
    else sessionStorage.removeItem(KEY);
  } catch {}
  subs.forEach((f) => f());
}

/** Start a new Playlist, replacing any active one. */
export function startPlaylist(entries: readonly Entry[], opts: StartOptions): Playlist {
  const pl = start(entries, opts);
  store(pl);
  return pl;
}

export function loadPlaylist(): Playlist | null {
  if (mem !== undefined) return mem;
  try {
    const raw = sessionStorage.getItem(KEY);
    const j: unknown = raw ? JSON.parse(raw) : null;
    return (mem = isPlaylist(j) ? j : null);
  } catch {
    return (mem = null);
  }
}

/** Keep the result of a transition (advance, setShuffled, …) as the active Playlist. */
export function updatePlaylist(pl: Playlist) {
  if (pl !== mem) store(pl);
}

/** A Video outside the Playlist was opened, or another shuffle is starting. */
export function endPlaylist() {
  if (loadPlaylist()) store(null);
}
