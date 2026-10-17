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

export function installKeys(global: KeyHandler): () => void {
  globalHandler = global
  const onKey = (e: KeyboardEvent) => {
    const k = actionFor(e)
    if (!k) return
    if (e.repeat && NO_REPEAT.has(k.action)) return void e.preventDefault()
    if (dispatch(k) || k.action !== "char") e.preventDefault()
  }
  document.addEventListener("keydown", onKey)
  return () => document.removeEventListener("keydown", onKey)
}
