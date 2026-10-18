// Pieces every screen shares: the header (docs/tv-spec.md 5.1), the navigation handle and the focus bookkeeping.
import { useLayoutEffect, useRef } from "preact/hooks"
import type { PlayingFrom } from "../shared/playingFrom"
import type { Playlist } from "../shared/playlist"
import type { LibraryState } from "../shared/libraryView"
import { url } from "./data"
import { focusEl } from "./focus"
import type { GridSpec, TvData } from "./rails"
import { Btn } from "./ui"

/** What a screen can ask of the app. */
export interface Nav {
  data: TvData
  lib: LibraryState
  setLib: (l: LibraryState) => void
  openGrid: (g: GridSpec) => void
  openSearch: () => void
  /** The Player's tag row: the grid replaces the Player (it is left; Back from the grid returns to where the Video was opened from). */
  swapToGrid: (g: GridSpec) => void
  /** Play `videoId`, snapshotting `playingFrom` (spec 5.4); `playlist` when a Shuffle started one. */
  play: (videoId: string, o: { startS?: number | null; playingFrom: PlayingFrom; playlist?: Playlist | null }) => void
  random: () => void
  /** Whole-library Shuffle (the side pane's). */
  shuffleLibrary: () => void
  openPane: () => void
  back: () => void
  toast: (msg: string) => void
}

export function useScreen(active: boolean, ready: boolean, initial: (root: HTMLElement) => HTMLElement | null) {
  const root = useRef<HTMLDivElement>(null)
  const last = useRef<HTMLElement | null>(null)
  const onFocusIn = (e: FocusEvent) => {
    last.current = e.target as HTMLElement
  }
  /** Put focus back on the screen's last item (or its first) when it is nowhere in it: true when it had to. */
  const ensure = (): boolean => {
    const r = root.current
    if (!r || (r.contains(document.activeElement) && document.activeElement !== r)) return false
    const t = last.current?.isConnected && r.contains(last.current) ? last.current : initial(r)
    return focusEl(t, 80) != null
  }
  useLayoutEffect(() => {
    if (active && ready) ensure()
  }, [active, ready])
  return { root, onFocusIn, last, ensure }
}

export function Header({ title, count, nav }: { title: string; count?: string; nav: Pick<Nav, "openSearch" | "random"> }) {
  return (
    <div class="top" data-zone="header">
      <img class="brand" src={url("/olchey.svg")} alt="" />
      <h1>
        {title}
        {count && <small>{count}</small>}
      </h1>
      <span class="sp" />
      <Btn itemKey="h-search" zone="header" onPress={nav.openSearch}>
        Search
      </Btn>
      <Btn itemKey="h-random" zone="header" onPress={nav.random}>
        Random
      </Btn>
    </div>
  )
}
