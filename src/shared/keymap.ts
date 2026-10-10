// The Player's keyboard (spec 4.5): a pure key -> action map and the focus rule. No DOM here.

export type PlayerAction =
  | { type: "togglePause" }
  | { type: "seekBy"; seconds: number; exact: boolean }
  | { type: "frameStep"; dir: 1 | -1 }
  | { type: "speedBy"; delta: number }
  | { type: "speedSet"; rate: number }
  | { type: "volumeBy"; delta: number }
  | { type: "mute" }
  | { type: "fullscreen" }
  | { type: "abLoop" }
  | { type: "chapter"; dir: 1 | -1 }
  | { type: "video"; dir: 1 | -1 }
  | { type: "screenshot" }
  | { type: "osd"; always: boolean }
  | { type: "studio" };

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/** Speed step of `[` `]` (additive: mpv's x0.9 / x1.1 never returns to 1.0) and volume step of `9` `0` (percent points). */
export const SPEED_STEP = 0.1;
export const VOLUME_STEP = 5;

/**
 * Bare keys only: any of Meta, Ctrl or Alt means the browser or the OS owns the chord and the Player ignores it.
 * Shift is part of the binding (arrows) or already folded into `key` (`{`, `<`, `O`).
 */
export function keyAction(e: KeyLike): PlayerAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const shift = !!e.shiftKey;
  switch (e.key) {
    case " ":
    case "p":
      return { type: "togglePause" };
    case "ArrowRight":
      return shift ? { type: "seekBy", seconds: 1, exact: true } : { type: "seekBy", seconds: 5, exact: false };
    case "ArrowLeft":
      return shift ? { type: "seekBy", seconds: -1, exact: true } : { type: "seekBy", seconds: -5, exact: false };
    case "ArrowUp":
      return shift ? { type: "seekBy", seconds: 5, exact: true } : { type: "seekBy", seconds: 60, exact: false };
    case "ArrowDown":
      return shift ? { type: "seekBy", seconds: -5, exact: true } : { type: "seekBy", seconds: -60, exact: false };
    case ".":
      return { type: "frameStep", dir: 1 };
    case ",":
      return { type: "frameStep", dir: -1 };
    case "[":
      return { type: "speedBy", delta: -SPEED_STEP };
    case "]":
      return { type: "speedBy", delta: SPEED_STEP };
    case "{":
      return { type: "speedSet", rate: 0.5 };
    case "}":
      return { type: "speedSet", rate: 2 };
    case "Backspace":
      return { type: "speedSet", rate: 1 };
    case "9":
      return { type: "volumeBy", delta: -VOLUME_STEP };
    case "0":
      return { type: "volumeBy", delta: VOLUME_STEP };
    case "m":
      return { type: "mute" };
    case "f":
      return { type: "fullscreen" };
    case "l":
      return { type: "abLoop" };
    case "!":
    case "PageUp":
      return { type: "chapter", dir: -1 };
    case "@":
    case "PageDown":
      return { type: "chapter", dir: 1 };
    case "<":
      return { type: "video", dir: -1 };
    case ">":
      return { type: "video", dir: 1 };
    case "s":
      return { type: "screenshot" };
    case "o":
      return { type: "osd", always: false };
    case "O":
      return { type: "osd", always: true };
    case "t":
      return { type: "studio" };
    default:
      return null;
  }
}

/** Held keys repeat for relative movement and stepping; one-shot toggles must not flicker. */
export function isRepeatable(a: PlayerAction): boolean {
  return a.type === "seekBy" || a.type === "frameStep" || a.type === "speedBy" || a.type === "volumeBy" || a.type === "chapter";
}

export interface FocusState {
  /** `document.activeElement` is the Player container itself. */
  containerFocused: boolean;
}

/**
 * The focus rule (spec 4.5, playback-architecture): the Player handles a key only while its container has focus.
 * Focus on the search box, a menu inside the container, a lyrics drawer or the page body means the key is not ours.
 */
export function playerOwnsKey(e: KeyLike, focus: FocusState): boolean {
  return focus.containerFocused && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** What a keydown means to the Player: `handled` keys get `preventDefault`; `action` is null for a repeat of a one-shot key. */
export function dispatchKey(e: KeyLike & { repeat?: boolean }, focus: FocusState): { action: PlayerAction | null; handled: boolean } {
  if (!playerOwnsKey(e, focus)) return { action: null, handled: false };
  const action = keyAction(e);
  if (!action) return { action: null, handled: false };
  return { action: e.repeat && !isRepeatable(action) ? null : action, handled: true };
}
