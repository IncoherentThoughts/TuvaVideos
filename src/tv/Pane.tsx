// The side pane (docs/tv-spec.md 5.2): slides in from the left on Back at the home or Left at a rail's start.
// Library (with its chips), Favorites, Artists, Songs, Search, Random, Shuffle. Right closes it; Back exits the app
// from the home (over a grid it just closes, see the build report).
import { useLayoutEffect, useRef } from "preact/hooks"
import { url } from "./data"
import { findByKey, focusEl, itemsIn, moveFocus } from "./focus"
import { useKeyHandler } from "./input"
import { CHIPS, chipLabel, cycleChip } from "./libchips"
import type { Nav } from "./screen"
import { Btn, Chip } from "./ui"

export function Pane({ nav, focusKey, onClose, onBack }: { nav: Nav; focusKey: string | null; onClose: () => void; onBack: () => void }) {
  const root = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const r = root.current
    if (!r) return
    focusEl((focusKey ? findByKey(r, focusKey) : null) ?? itemsIn(r)[0] ?? null, 0)
  }, [])

  useKeyHandler(true, (k) => {
    const r = root.current
    if (!r) return false
    switch (k.action) {
      case "up":
      case "down":
        moveFocus(r, k.action, 0)
        return true
      case "right":
        onClose()
        return true
      case "left":
        return true
      case "enter":
        ;(document.activeElement as HTMLElement | null)?.click()
        return true
      case "back":
        onBack()
        return true
    }
    return false
  })

  return (
    <div class="pane" ref={root} data-zone="pane">
      <img class="brand" src={url("/olchey.svg")} alt="" />
      <Btn itemKey="p-library" zone="pane" onPress={() => nav.openGrid({ kind: "library" })}>
        Library
      </Btn>
      <div class="pchips">
        {CHIPS.map((id) => {
          const c = chipLabel(id, nav.lib)
          return <Chip key={id} itemKey={`p-chip-${id}`} zone="pane" name={c.name} value={c.value} on={c.on} onPress={() => nav.setLib(cycleChip(id, nav.lib))} />
        })}
      </div>
      <Btn itemKey="p-favorites" zone="pane" onPress={() => nav.openGrid({ kind: "favorites" })}>
        Favorites
      </Btn>
      <Btn itemKey="p-artists" zone="pane" onPress={() => nav.openGrid({ kind: "artists" })}>
        Artists
      </Btn>
      <Btn itemKey="p-songs" zone="pane" onPress={() => nav.openGrid({ kind: "songs", lyricsOnly: false })}>
        Songs
      </Btn>
      <Btn itemKey="p-search" zone="pane" onPress={nav.openSearch}>
        Search
      </Btn>
      <Btn itemKey="p-random" zone="pane" onPress={nav.random}>
        Random
      </Btn>
      <Btn itemKey="p-shuffle" zone="pane" onPress={nav.shuffleLibrary}>
        Shuffle
      </Btn>
    </div>
  )
}
