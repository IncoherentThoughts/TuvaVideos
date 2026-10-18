// The TV's router: an in-memory stack of routes (docs/tv-spec.md 5.2, 5.3). Back pops; there is no URL. Pure.
import type { Playlist } from "../shared/playlist"
import type { PlayingFrom } from "../shared/playingFrom"
import type { GridSpec } from "./rails"

export type Route =
  | { kind: "home" }
  | { kind: "grid"; grid: GridSpec }
  | { kind: "search" }
  | { kind: "player"; videoId: string; startS: number | null; playingFrom: PlayingFrom; playlist: Playlist | null }

export interface Entry {
  /** A stable id for keeping the screen mounted while it is on the stack. */
  id: number
  route: Route
  /** Opened from the side pane: Back reopens the pane on this item (its `data-key`). */
  fromPane: string | null
  /** Screen-owned memory (the Search query, the grid's scroll) that survives other screens on top. */
  mem: Record<string, unknown>
}

let nextId = 1

export const makeEntry = (route: Route, fromPane: string | null = null): Entry => ({ id: nextId++, route, fromPane, mem: {} })

export function push(stack: readonly Entry[], e: Entry): Entry[] {
  return [...stack, e]
}

/** Pops the top entry; the home at the bottom stays. */
export function pop(stack: readonly Entry[]): { stack: Entry[]; popped: Entry | null } {
  if (stack.length <= 1) return { stack: [...stack], popped: null }
  return { stack: stack.slice(0, -1), popped: stack[stack.length - 1]! }
}

/** Replaces the top entry (the Player stepping to the next Video must not pile up screens). */
export function replaceTop(stack: readonly Entry[], e: Entry): Entry[] {
  return [...stack.slice(0, -1), e]
}

export const top = (stack: readonly Entry[]): Entry => stack[stack.length - 1]!
