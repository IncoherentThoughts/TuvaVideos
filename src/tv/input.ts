// One key dispatch for the whole UI (docs/tv-spec.md 8): a single keydown listener turns the event into an Action
// (keys.ts) and hands it to the topmost registered handler (the pane, else the screen on top).
import { useEffect, useRef } from "preact/hooks"
import { actionFor, type TvKeyEvent } from "./keys"

/** Returns true when it used the key. */
export type KeyHandler = (k: TvKeyEvent) => boolean | void

const stack: KeyHandler[] = []
let globalHandler: KeyHandler = () => false

/** Registers `fn` as the topmost handler while `active`. */
export function useKeyHandler(active: boolean, fn: KeyHandler): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    const h: KeyHandler = (k) => ref.current(k)
    stack.push(h)
    return () => {
      const i = stack.lastIndexOf(h)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [active])
}

/** Routes one Action: the topmost handler, then the global one; a desktop Backspace nobody used is Back. */
export function dispatch(k: TvKeyEvent): boolean {
  const top = stack[stack.length - 1]
  if (top && top(k) === true) return true
  if (k.action === "backspace") return top?.({ action: "back" }) === true || globalHandler({ action: "back" }) === true
  return globalHandler(k) === true
}

/** The keys that must not repeat while held (a held Enter would open and re-open). */
const NO_REPEAT = new Set(["enter", "back", "backspace", "playpause", "play", "pause", "info", "exit"])

/**
 * A keydown with no keyup since the last keydown of the same key, this soon after it, is an auto-repeat even when the
 * engine does not set `repeat` (a remote's held key). Longer than a remote's initial repeat delay (about 500 ms).
 */
export const HELD_GAP_MS = 800

/** Tells auto-repeats from presses: `e.repeat`, or a keydown of a key that is still down (no keyup yet). */
export class HeldKeys {
  private down = new Map<number, number>()
  keydown(code: number, now: number, repeat: boolean): boolean {
    const last = this.down.get(code)
    this.down.set(code, now)
    return repeat || (last != null && now >= last && now - last < HELD_GAP_MS)
  }
  keyup(code: number) {
    this.down.delete(code)
  }
  clear() {
    this.down.clear()
  }
}

export function installKeys(global: KeyHandler): () => void {
  globalHandler = global
  const held = new HeldKeys()
  const onKey = (e: KeyboardEvent) => {
    const repeat = held.keydown(e.keyCode, performance.now(), e.repeat)
    const k = actionFor(e)
    if (!k) return
    if (e.repeat && NO_REPEAT.has(k.action)) return void e.preventDefault()
    if (repeat) k.repeat = true
    if (dispatch(k) || k.action !== "char") e.preventDefault()
  }
  const onUp = (e: KeyboardEvent) => held.keyup(e.keyCode)
  const onBlur = () => held.clear()
  document.addEventListener("keydown", onKey)
  document.addEventListener("keyup", onUp)
  window.addEventListener("blur", onBlur)
  return () => {
    document.removeEventListener("keydown", onKey)
    document.removeEventListener("keyup", onUp)
    window.removeEventListener("blur", onBlur)
  }
}
