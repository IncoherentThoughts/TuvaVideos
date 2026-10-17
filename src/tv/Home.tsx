// The TV home (docs/tv-spec.md 5.1): the rails under a header with Search and Random.
import { useMemo } from "preact/hooks"
import { findByKey, itemsIn, moveFocus } from "./focus"
import { useKeyHandler } from "./input"
import { openTile } from "./open"
import { buildRails, railTiles, type Rail } from "./rails"
import { Header, useScreen, type Nav } from "./screen"
import { TileView } from "./ui"

export function Home({ nav, active }: { nav: Nav; active: boolean }) {
  const rails = useMemo(() => buildRails(nav.data), [nav.data])
  const { root, onFocusIn, ensure } = useScreen(active, true, (r) => itemsIn(r).find((e) => e.closest(".rail")) ?? findByKey(r, "h-search"))

  useKeyHandler(active, (k) => {
    const r = root.current
    if (!r) return false
    if (k.action !== "back" && k.action !== "backspace" && ensure()) return true // focus was lost (a mouse click): find it again
    switch (k.action) {
      case "up":
      case "down":
      case "right":
        moveFocus(r, k.action, 90)
        return true
      case "left":
        // Left at a rail's start (or the header's) opens the pane.
        if (!moveFocus(r, "left", 90)) nav.openPane()
        return true
      case "enter":
        ;(document.activeElement as HTMLElement | null)?.click()
        return true
      case "back":
        nav.openPane()
        return true
    }
    return false
  })

  return (
    <div class="screen" ref={root} onFocusIn={onFocusIn}>
      <Header title="TuvaVideos" nav={nav} />
      <div class="rails" data-zone="rails">
        {rails.length === 0 && <div class="empty">The library is empty.</div>}
        {rails.map((rail) => (
          <RailView key={rail.id} rail={rail} nav={nav} />
        ))}
      </div>
    </div>
  )
}

function RailView({ rail, nav }: { rail: Rail; nav: Nav }) {
  return (
    <section class="rail">
      <h2>
        {rail.title}
        <small>{rail.total}</small>
      </h2>
      <div class="tiles">
        {rail.tiles.map((t) => (
          <TileView key={t.key} tile={t} zone="rails" open={(tile) => openTile(tile, nav, railTiles(rail.id, nav.data), rail.id === "favorites" ? "favorites" : "library")} />
        ))}
      </div>
    </section>
  )
}
