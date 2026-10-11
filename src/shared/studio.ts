// Studio playback, shared between server and UI (spec 7). DTOs and the pure key retargeting map. No DOM, no Node.
import type { PlayerAction } from "./keymap";

/** A Music.app track as the dump knows it. */
export interface DumpHitDto {
  persistentId: string;
  name: string;
  album: string;
  artist: string;
  albumArtist: string;
  durationS: number;
  cloudStatus: string;
}

/** A Studio track of a Song: a Mirror Track's match, or a Local Studio track (`mirrorTrackId: null`). */
export interface StudioEntryDto {
  id: number;
  mirrorTrackId: string | null;
  kind: "mirror" | "local";
  /** `missing`: the row's persistent id is no longer in the Music.app library (playing it re-dumps and re-matches). */
  state: "confirmed" | "suggested" | "missing";
  persistentId: string;
  /** From the dump when the id resolves, else the Mirror Track's own name. */
  name: string;
  album: string;
  artist: string;
  durationS: number | null;
  cloudStatus: string | null;
  trackNumber: number | null;
}

/** A Mirror Track of the Song with no Studio track: the miss UI lists it with any name-only offers. */
export interface MissingTrackDto {
  mirrorTrackId: string;
  name: string;
  album: string;
  trackNumber: number;
  durationS: number | null;
  /** Name-only hits and unresolved ties from the dump, never auto-matched (spec 7.3). */
  offers: DumpHitDto[];
}

/** GET /api/songs/:id/studio */
export interface SongStudioDto {
  songId: string;
  /** Matched Mirror Tracks by album then track number, then Local Studio tracks by `added_at`. */
  tracks: StudioEntryDto[];
  missing: MissingTrackDto[];
  /** `studio_last`: the Studio track `t` starts, when it still exists. */
  lastId: number | null;
  dumpAt: string | null;
}

export type StudioEnd = "external" | "stopped" | "stop" | "refused";

/** GET /api/studio/state and the answer of every transport call. */
export interface StudioStateDto {
  active: boolean;
  studioTrackId: number | null;
  songId: string | null;
  persistentId: string | null;
  name: string | null;
  album: string | null;
  /** Music.app's player state while active (`playing`, `paused`, ...). */
  state: string | null;
  position: number | null;
  duration: number | null;
  /** Why Studio playback ended, until the next one starts. `external`: another track took over; `stopped`: the once-play ran out. */
  ended: StudioEnd | null;
  /** The message to show when Music.app refused a command. */
  refused: string | null;
  /** Server clock (ms) when position was read, so the UI can interpolate. */
  at: number;
}

// ---- the key retargeting map (spec 7.4) ----

export type StudioKeyRoute =
  /** The key goes to Music.app: toggle pause, seek by seconds, or the A-B loop. */
  | { to: "music"; op: "toggle" | "loop" | { seek: number } }
  /** 9 0 m stay on the browser: the Player handles them as it always does. */
  | { to: "browser" }
  /** `t`: leave Studio playback. */
  | { to: "exit" }
  /** Everything else: nothing happens, the OSD says so. */
  | { to: "noop"; notice: string };

export const STUDIO_NOTICE = "not available during Studio playback";

/** What a Player action means while the Studio bar is active. */
export function studioRoute(a: PlayerAction): StudioKeyRoute {
  switch (a.type) {
    case "togglePause":
      return { to: "music", op: "toggle" };
    case "seekBy":
      return { to: "music", op: { seek: a.seconds } };
    case "abLoop":
      return { to: "music", op: "loop" };
    case "volumeBy":
    case "mute":
    case "state":
      return { to: "browser" };
    case "studio":
      return { to: "exit" };
    default:
      return { to: "noop", notice: STUDIO_NOTICE };
  }
}

/** A seek target kept inside the track. `duration` may be unknown. */
export function clampStudioSeek(position: number, duration: number | null): number {
  const max = duration != null && duration > 0 ? duration : Infinity;
  return Math.min(max, Math.max(0, position));
}
