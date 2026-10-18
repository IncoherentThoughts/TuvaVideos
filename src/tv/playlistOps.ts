// The Playlist on the TV (docs/tv-spec.md 6.7): the browser's Playlist (spec 4.8) without the panel. The pure state and
// transitions are src/shared/playlist.ts and playlistPlayer.ts as they are; this adds the one active Playlist (in
// memory only: exiting the app ends it, a relaunch starts clean) and what the two buttons and the entry hand-over say.
import { current, cycleRepeat, jumpToVideo, widenToVideo, type Entry, type Playlist, type Rng } from "../shared/playlist"
import { libraryPlaylist, repeatIcon, repeatLabel, shuffleLabel, shuffleStartLabel, toggleShuffle } from "../shared/playlistPlayer"

// ---- the one active Playlist ----

let active: Playlist | null = null

export const activePlaylist = (): Playlist | null => active
export const setActivePlaylist = (pl: Playlist | null): void => {
  active = pl
}

/**
 * A Video was opened (by any route): inside the active Playlist the cursor moves to its Entry, outside it the Playlist ends
 * and the Player is back to plain Playing from (spec 6.7, "jumps to that Entry when opened from elsewhere").
 */
export function resolveOpen(pl: Playlist | null, videoId: string): Playlist | null {
  if (!pl) return null
  if (current(pl)?.videoId === videoId) return pl
  return jumpToVideo(pl, videoId)
}

/** The Playlist's current Entry as the Player opens it: a Chapter Entry at its Chapter's start, a deleted Chapter as the Video. */
export function entryStart(pl: Playlist, chapters: readonly { id: string; startS: number }[] | null): { pl: Playlist; startS: number | null } {
  const e: Entry | null = current(pl)
  if (!e || e.chapterId === undefined) return { pl, startS: null }
  const c = chapters?.find((x) => x.id === e.chapterId)
  return c ? { pl, startS: c.startS } : { pl: widenToVideo(pl), startS: null }
}

// ---- the buttons ----

export const NO_PLAYLIST_REPEAT = "Repeat: one (this Video loops; Shuffle starts a Playlist)"

/** Shuffle with none active starts a whole-library Playlist from the current Video; with one active it toggles the Play order. */
export function pressShuffle(pl: Playlist | null, libraryIds: readonly string[], videoId: string, rng?: Rng): { pl: Playlist | null; label: string; started: boolean } {
  if (pl) {
    const next = toggleShuffle(pl, rng)
    return { pl: next, label: shuffleLabel(next), started: false }
  }
  const started = libraryPlaylist(libraryIds, videoId, rng)
  if (!started) return { pl: null, label: "This Video is not in the library", started: false }
  return { pl: started, label: shuffleStartLabel(started.entries.length), started: true }
}

/** Repeat cycles off → list → one; with only Playing from it says the Video loops and changes nothing. */
export function pressRepeat(pl: Playlist | null): { pl: Playlist | null; label: string } {
  if (!pl) return { pl, label: NO_PLAYLIST_REPEAT }
  const next = cycleRepeat(pl)
  return { pl: next, label: repeatLabel(next) }
}

export interface ButtonFace {
  text: string
  /** Shown lit: shuffled order, or a Repeat mode other than off. */
  on: boolean
  disabled: boolean
}

/** What the Shuffle and Repeat buttons show. */
export function buttonFaces(pl: Playlist | null): { shuffle: ButtonFace; repeat: ButtonFace } {
  const r = repeatIcon(pl)
  return {
    shuffle: { text: pl ? (pl.shuffled ? "Shuffle: on" : "Shuffle: off") : "Shuffle", on: !!pl && pl.shuffled, disabled: false },
    repeat: { text: `Repeat: ${r.mode}`, on: !r.disabled && r.mode !== "off", disabled: r.disabled },
  }
}
