// The remote key table of docs/tv-spec.md §8, as data. The signed shell (tv/shell/, plain JS) registers every
// `registered` key with tizen.tvinputdevice.registerKeyBatch and the UI maps keyCode -> name through the same table.
// LG webOS sends most keys with the same codes and needs no registering; where its code differs it is in `alt`.
// tv/shell/keys.js is generated from this file by `bun run tv-install` (and `bun scripts/tv-install.ts --keys`).

export type TvKey = {
  /** Tizen key name for registered keys (what registerKeyBatch takes); a plain label for the rest. */
  name: string
  code: number
  /** True when the shell must register it; arrows, Enter and Back arrive on their own. */
  registered: boolean
  /** The same key's code on LG webOS, where it differs from Tizen's. */
  alt?: readonly number[]
}

export const TV_KEYS: readonly TvKey[] = [
  { name: "ArrowLeft", code: 37, registered: false },
  { name: "ArrowUp", code: 38, registered: false },
  { name: "ArrowRight", code: 39, registered: false },
  { name: "ArrowDown", code: 40, registered: false },
  { name: "Enter", code: 13, registered: false },
  { name: "Back", code: 10009, registered: false, alt: [461] },
  { name: "Exit", code: 10182, registered: false },
  { name: "ChannelUp", code: 427, registered: true, alt: [33] },
  { name: "ChannelDown", code: 428, registered: true, alt: [34] },
  { name: "MediaPlayPause", code: 10252, registered: true },
  { name: "MediaPlay", code: 415, registered: true },
  { name: "MediaPause", code: 19, registered: true },
  { name: "MediaRewind", code: 412, registered: true },
  { name: "MediaFastForward", code: 417, registered: true },
  { name: "MediaTrackPrevious", code: 10232, registered: true },
  { name: "MediaTrackNext", code: 10233, registered: true },
  { name: "ColorF0Red", code: 403, registered: true },
  { name: "ColorF1Green", code: 404, registered: true },
  { name: "ColorF2Yellow", code: 405, registered: true },
  { name: "ColorF3Blue", code: 406, registered: true },
  { name: "Info", code: 457, registered: true },
  ...Array.from({ length: 10 }, (_, d): TvKey => ({ name: String(d), code: 48 + d, registered: true })),
]

export function keyName(keyCode: number): string | undefined {
  return TV_KEYS.find((k) => k.code === keyCode || k.alt?.includes(keyCode))?.name
}

/** Names the shell passes to tizen.tvinputdevice.registerKeyBatch. */
export function registeredKeyNames(): string[] {
  return TV_KEYS.filter((k) => k.registered).map((k) => k.name)
}

// ---- the key dispatch table (docs/tv-spec.md 8) ----
// One place maps a keydown to an Action; every screen reads Actions, never keyCodes. Pure, so a test walks it.

export type TvAction =
  | "up" | "down" | "left" | "right" | "enter" | "back" | "exit"
  | "pageUp" | "pageDown" | "playpause" | "play" | "pause" | "rewind" | "forward" | "prev" | "next"
  | "red" | "green" | "yellow" | "blue" | "info"
  | "backspace" // a desktop keyboard's Backspace: deletes in Search, otherwise it is Back
  | "char" // a digit key or a typed character (`char` on the event)

/** TV_KEYS names -> Actions. Digits are `char`s (the Search keyboard types them). */
export const KEY_ACTIONS: Readonly<Record<string, TvAction>> = {
  ArrowLeft: "left", ArrowUp: "up", ArrowRight: "right", ArrowDown: "down", Enter: "enter", Back: "back", Exit: "exit",
  ChannelUp: "pageUp", ChannelDown: "pageDown",
  MediaPlayPause: "playpause", MediaPlay: "play", MediaPause: "pause", MediaRewind: "rewind", MediaFastForward: "forward",
  MediaTrackPrevious: "prev", MediaTrackNext: "next",
  ColorF0Red: "red", ColorF1Green: "green", ColorF2Yellow: "yellow", ColorF3Blue: "blue", Info: "info",
}

/** Desktop-browser stand-ins, for running the UI at http://127.0.0.1:4401/ without a remote (by `KeyboardEvent.key`). */
export const DESKTOP_KEYS: Readonly<Record<string, TvAction>> = {
  ArrowLeft: "left", ArrowUp: "up", ArrowRight: "right", ArrowDown: "down", Enter: "enter", Escape: "back", Backspace: "backspace",
  PageUp: "pageUp", PageDown: "pageDown", MediaPlayPause: "playpause", MediaTrackPrevious: "prev", MediaTrackNext: "next",
  "<": "prev", ">": "next", F1: "red", F2: "green", F3: "yellow", F4: "blue",
}

export interface TvKeyEvent {
  action: TvAction
  /** For `char`: the character typed. */
  char?: string
}

/** The Action for a keydown: the remote's codes first, then the desktop stand-ins, then a typed character. */
export function actionFor(e: { keyCode: number; key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): TvKeyEvent | null {
  const name = keyName(e.keyCode)
  if (name) {
    if (/^\d$/.test(name)) return { action: "char", char: /^\d$/.test(e.key) ? e.key : name }
    const a = KEY_ACTIONS[name]
    if (a) return { action: a }
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  const d = DESKTOP_KEYS[e.key]
  if (d) return { action: d }
  if (e.key.length === 1) return { action: "char", char: e.key } // letters, digits, space, punctuation
  return null
}
