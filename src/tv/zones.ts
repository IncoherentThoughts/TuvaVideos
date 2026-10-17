// The Player's zones and what each key does in them (docs/tv-spec.md 6.3 to 6.5, 8). A pure reducer over the key table:
// a TvAction and the zone state in, the next zone state and the effects for the Player to carry out. The Player
// holds the playback; this holds only where the focus is.
import type { TvAction } from "./keys"

export type Zone = "video" | "lyrics" | "tags" | "buttons" | "chapters" | "copies"

export const BUTTONS = ["shuffle", "repeat", "copy"] as const
export type ButtonId = (typeof BUTTONS)[number]

export interface ZoneState {
  zone: Zone
  /** Focused tag in the tag row. */
  tag: number
  /** Focused button in the button row. */
  button: number
  /** Focused row of the Chapter or Copy list. */
  row: number
}

export const initialZone = (): ZoneState => ({ zone: "video", tag: 0, button: 0, row: 0 })

/** What the reducer needs to know about the Video on screen. */
export interface ZoneCtx {
  hasLyrics: boolean
  /** Focusable tags (Type, Artists, Song). */
  tagCount: number
  chapterCount: number
  /** Index of the Chapter the playhead is in, -1 before the first. */
  currentChapter: number
  /** One flag per Copy row: can Enter switch to it (Available and not via remux)? */
  copySwitchable: readonly boolean[]
  currentCopy: number
}

export type Fx =
  | { t: "toggle" }
  | { t: "play" }
  | { t: "pause" }
  /** Left/Right (`ramp`: the accelerating step) or Rewind/FastForward (`flat`: 60 s). */
  | { t: "seek"; dir: 1 | -1; kind: "ramp" | "flat" }
  | { t: "page"; dir: 1 | -1 }
  | { t: "lyrics"; on: boolean | "toggle" }
  | { t: "script" }
  /** `<` `>`: the Playlist when one is active, else Playing from. */
  | { t: "step"; dir: 1 | -1 }
  | { t: "tag"; index: number }
  | { t: "button"; id: "shuffle" | "repeat" }
  | { t: "chapter"; index: number }
  | { t: "copy"; index: number }
  /** Enter on a Copy row that cannot be switched to (via remux, unavailable). */
  | { t: "copyBlocked"; index: number }
  | { t: "say"; text: string }
  | { t: "leave" }

export interface ZoneResult {
  state: ZoneState
  fx: Fx[]
  /** False: the key is not the Player's (Info, Exit, Red), the app's own handler gets it. */
  handled: boolean
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const go = (s: ZoneState, patch: Partial<ZoneState>, ...fx: Fx[]): ZoneResult => ({ state: { ...s, ...patch }, fx, handled: true })
const stay = (s: ZoneState, ...fx: Fx[]): ZoneResult => ({ state: s, fx, handled: true })

/** Opens the Chapter list on the current Chapter (Down twice, Green). */
function openChapters(s: ZoneState, c: ZoneCtx): ZoneResult {
  if (c.chapterCount === 0) return stay(s, { t: "say", text: "No chapters" })
  return go(s, { zone: "chapters", row: clamp(c.currentChapter, 0, c.chapterCount - 1) })
}

/** The key table of the Player: zone by zone, then the keys that mean the same in every zone. */
export function reduceZone(s: ZoneState, k: TvAction, c: ZoneCtx): ZoneResult {
  // keys that mean the same everywhere
  switch (k) {
    case "playpause":
      return stay(s, { t: "toggle" })
    case "play":
      return stay(s, { t: "play" })
    case "pause":
      return stay(s, { t: "pause" })
    case "pageUp":
      return stay(s, { t: "page", dir: -1 })
    case "pageDown":
      return stay(s, { t: "page", dir: 1 })
    case "prev":
      return stay(s, { t: "step", dir: -1 })
    case "next":
      return stay(s, { t: "step", dir: 1 })
    case "yellow":
      return stay(s, { t: "lyrics", on: "toggle" })
    case "blue":
      return stay(s, { t: "script" })
    case "green":
      return s.zone === "chapters" ? go(s, { zone: "video" }) : openChapters(s, c)
    case "rewind":
    case "forward":
      if (s.zone === "chapters" || s.zone === "copies") return stay(s)
      return stay(s, { t: "seek", dir: k === "forward" ? 1 : -1, kind: "flat" })
  }

  switch (s.zone) {
    case "video":
      switch (k) {
        case "left":
        case "right":
          return stay(s, { t: "seek", dir: k === "right" ? 1 : -1, kind: "ramp" })
        case "enter":
          return stay(s, { t: "toggle" })
        case "up":
          return go(s, { zone: "lyrics" })
        case "down":
          return go(s, { zone: "buttons" })
        case "back":
          return stay(s, { t: "leave" })
      }
      break

    case "lyrics":
      switch (k) {
        case "right":
          return c.hasLyrics ? stay(s, { t: "lyrics", on: true }) : stay(s)
        case "left":
          return c.hasLyrics ? stay(s, { t: "lyrics", on: false }) : stay(s)
        case "enter":
          return c.hasLyrics ? stay(s, { t: "lyrics", on: "toggle" }) : stay(s)
        case "up":
          return c.tagCount > 0 ? go(s, { zone: "tags", tag: clamp(s.tag, 0, c.tagCount - 1) }) : stay(s)
        case "down":
        case "back":
          return go(s, { zone: "video" })
      }
      break

    case "tags":
      switch (k) {
        case "left":
          return go(s, { tag: clamp(s.tag - 1, 0, Math.max(0, c.tagCount - 1)) })
        case "right":
          return go(s, { tag: clamp(s.tag + 1, 0, Math.max(0, c.tagCount - 1)) })
        case "enter":
          return c.tagCount > 0 ? stay(s, { t: "tag", index: clamp(s.tag, 0, c.tagCount - 1) }) : stay(s)
        case "down":
          return go(s, { zone: "lyrics" })
        case "back":
          return go(s, { zone: "video" })
        case "up":
          return stay(s)
      }
      break

    case "buttons":
      switch (k) {
        case "left":
          return go(s, { button: clamp(s.button - 1, 0, BUTTONS.length - 1) })
        case "right":
          return go(s, { button: clamp(s.button + 1, 0, BUTTONS.length - 1) })
        case "enter": {
          const id = BUTTONS[s.button]!
          if (id === "copy") return go(s, { zone: "copies", row: clamp(c.currentCopy, 0, Math.max(0, c.copySwitchable.length - 1)) })
          return stay(s, { t: "button", id })
        }
        case "up":
        case "back":
          return go(s, { zone: "video" })
        case "down":
          return openChapters(s, c)
      }
      break

    case "chapters":
      switch (k) {
        case "up":
          return go(s, { row: clamp(s.row - 1, 0, Math.max(0, c.chapterCount - 1)) })
        case "down":
          return go(s, { row: clamp(s.row + 1, 0, Math.max(0, c.chapterCount - 1)) })
        case "enter":
          return go(s, { zone: "video" }, { t: "chapter", index: clamp(s.row, 0, Math.max(0, c.chapterCount - 1)) })
        case "left":
        case "back":
          return go(s, { zone: "buttons" })
      }
      break

    case "copies":
      switch (k) {
        case "up":
          return go(s, { row: clamp(s.row - 1, 0, Math.max(0, c.copySwitchable.length - 1)) })
        case "down":
          return go(s, { row: clamp(s.row + 1, 0, Math.max(0, c.copySwitchable.length - 1)) })
        case "enter":
          if (s.row === c.currentCopy) return go(s, { zone: "video" })
          return c.copySwitchable[s.row] ? go(s, { zone: "video" }, { t: "copy", index: s.row }) : stay(s, { t: "copyBlocked", index: s.row })
        case "left":
        case "back":
          return go(s, { zone: "buttons", button: BUTTONS.indexOf("copy") })
      }
      break
  }
  // a key this zone has no use for: Back still leaves from anywhere unhandled above; the rest is the app's (Info, Exit)
  return { state: s, fx: [], handled: k !== "info" && k !== "exit" && k !== "red" && k !== "char" && k !== "backspace" }
}

/** The bottom bar stays up in the zones that live in it; the top band in the zones that live there. */
export const pinsBottom = (z: Zone): boolean => z === "buttons" || z === "chapters" || z === "copies"
export const pinsTop = (z: Zone): boolean => z === "lyrics" || z === "tags"
