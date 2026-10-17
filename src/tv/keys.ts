// The remote key table of docs/tv-spec.md §8, as data. The signed shell (tv/shell/, plain JS) registers every
// `registered` key with tizen.tvinputdevice.registerKeyBatch and the UI maps keyCode -> name through the same table.
// tv/shell/keys.js is generated from this file by `bun run tv-install` (and `bun scripts/tv-install.ts --keys`).

export type TvKey = {
  /** Tizen key name for registered keys (what registerKeyBatch takes); a plain label for the rest. */
  name: string
  code: number
  /** True when the shell must register it; arrows, Enter and Back arrive on their own. */
  registered: boolean
}

export const TV_KEYS: readonly TvKey[] = [
  { name: "ArrowLeft", code: 37, registered: false },
  { name: "ArrowUp", code: 38, registered: false },
  { name: "ArrowRight", code: 39, registered: false },
  { name: "ArrowDown", code: 40, registered: false },
  { name: "Enter", code: 13, registered: false },
  { name: "Back", code: 10009, registered: false },
  { name: "Exit", code: 10182, registered: false },
  { name: "ChannelUp", code: 427, registered: true },
  { name: "ChannelDown", code: 428, registered: true },
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
  return TV_KEYS.find((k) => k.code === keyCode)?.name
}

/** Names the shell passes to tizen.tvinputdevice.registerKeyBatch. */
export function registeredKeyNames(): string[] {
  return TV_KEYS.filter((k) => k.registered).map((k) => k.name)
}
