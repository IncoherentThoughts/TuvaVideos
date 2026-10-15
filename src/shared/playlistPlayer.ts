// What the Player does with a Playlist (spec 4.8): the pure decisions behind end-of-Entry, the Playlist keys and the
// control-bar icons. The Player and Now playing screen only carry them out.
import { advance, current, cycleRepeat, setShuffled, startPlaylist, stepBack, type Entry, type Playable, type Playlist, type Repeat, type Rng } from "./playlist";
import { startPosition } from "./resume";

/** The part of a Video that an Entry plays: `end` is null for "to the Video's end" (or while the Chapters are unknown). */
export interface EntryRange {
  start: number;
  end: number | null;
}

/**
 * A Video Entry plays the whole Video. A Chapter Entry plays from the Chapter's start to the next Chapter's start, or the
 * Video's end. A Chapter that no longer exists (deleted) plays as a Video Entry.
 */
export function entryRange(entry: Entry | null, chapters: readonly { id: number; startS: number }[], durationS: number | null): EntryRange {
  const whole: EntryRange = { start: 0, end: null };
  if (!entry || entry.chapterId === undefined) return whole;
  const c = chapters.find((x) => x.id === entry.chapterId);
  if (!c) return whole;
  let end = durationS != null && durationS > c.startS ? durationS : null;
  for (const x of chapters) if (x.startS > c.startS && (end == null || x.startS < end)) end = x.startS;
  return { start: c.startS, end };
}

/** The playhead has reached the Entry's end (only a Chapter Entry has one before the Video's own end). */
export function reachedEnd(range: EntryRange, t: number): boolean {
  return range.end != null && t >= range.end;
}

/** A seek or step landing at `t` goes past the Entry's end: the Chapter Entry becomes a Video Entry for the rest of the Video. */
export function seekWidens(range: EntryRange, t: number): boolean {
  return reachedEnd(range, t);
}

/** Where a Video opens: inside a Playlist never at the Resume position (spec 4.8), else as `startPosition`. */
export function openAt(opts: { t: number | null; resumeS: number | null; durationS: number | null }, inPlaylist: boolean): number {
  return startPosition({ ...opts, resumeS: inPlaylist ? null : opts.resumeS });
}

/** Resume positions are written only outside a Playlist. */
export const resumeAllowed = (inPlaylist: boolean) => !inPlaylist;

export type Move =
  /** Play the same Entry again from its start (Repeat one at the end, or a one-Entry list wrapping). */
  | { kind: "restart"; pl: Playlist }
  /** Go to the Entry now current in `pl`. */
  | { kind: "move"; pl: Playlist }
  /** The end of the list with Repeat off: stay, paused on the last frame, "Playlist ended". */
  | { kind: "ended"; pl: Playlist }
  /** `n` at the end of the list with Repeat off: nothing happens. */
  | { kind: "none"; pl: Playlist };

const entryIndex = (pl: Playlist) => pl.order[pl.cursor];

/** Next Entry. `via: "end"` is the Entry finishing by itself (Repeat one applies); `"key"` is `n` / `>` (Repeat one does not hold it back). */
export function nextEntry(pl: Playlist, via: "end" | "key", playable: Playable = () => true, rng?: Rng): Move {
  if (via === "end" && pl.repeat === "one") return { kind: "restart", pl };
  const r = advance(pl, playable, rng);
  if (r.ended) return { kind: via === "end" ? "ended" : "none", pl };
  return { kind: entryIndex(r.pl) === entryIndex(pl) ? "restart" : "move", pl: r.pl };
}

/** Previous Entry (`N`, `<`): null when there is none to go back to. */
export function prevEntry(pl: Playlist, playable: Playable = () => true): Playlist | null {
  const back = stepBack(pl, playable);
  return back.cursor === pl.cursor ? null : back;
}

/** Entries for a whole-library Playlist, in library order, starting at `videoId`; null when the Video is not in the library. */
export function libraryPlaylist(videoIds: readonly number[], videoId: number, rng?: Rng): Playlist | null {
  const startAt = videoIds.indexOf(videoId);
  if (startAt < 0) return null;
  return startPlaylist(videoIds.map((id) => ({ videoId: id })), { source: "library-all", shuffled: true, startAt, rng });
}

/** `x`: shuffle toggles the Play order of the active Playlist. */
export function toggleShuffle(pl: Playlist, rng?: Rng): Playlist {
  return setShuffled(pl, !pl.shuffled, rng);
}

export { cycleRepeat };

/** What the repeat icon shows: the Playlist's mode; "one" and disabled when only Playing from (the Video loops itself). */
export function repeatIcon(pl: Playlist | null): { mode: Repeat; disabled: boolean } {
  return pl ? { mode: pl.repeat, disabled: false } : { mode: "one", disabled: true };
}

// OSD wording for the Playlist actions (spec 4.8): one place so the keys, the control bar and the panel say the same thing.
export const shuffleLabel = (pl: Playlist) => `Shuffle ${pl.shuffled ? "on" : "off"}`;
export const shuffleStartLabel = (n: number) => `Shuffle on · Playlist of ${n}`;
export const repeatLabel = (pl: Playlist) => `Repeat: ${pl.repeat}`;
export const nextLabel = (title: string) => `Next: ${title}`;
export const prevLabel = (title: string) => `Previous: ${title}`;
export const ENDED_LABEL = "Playlist ended";

/** Whether a Playlist is the one this screen is showing: its current Entry is for this Video. */
export function playlistFor(pl: Playlist | null, videoId: number): Playlist | null {
  return pl && current(pl)?.videoId === videoId ? pl : null;
}
