// The side pane (docs/tv-spec.md 5.2): slides in from the left on Back at the home or Left at a rail's start.
// Library (with its chips), Favorites, Artists, Songs, Search, Random, Shuffle, and Server: ‹name› in the shell
// (docs/home-server-spec.md §4.2). Right closes it; Back exits the app from the home (over a grid it just closes, see
// the build report).
import { useLayoutEffect, useRef, useState } from "preact/hooks"
import { shell, url, type ShellServer } from "./data"
import { findByKey, focusEl, itemsIn, moveFocus } from "./focus"
import { useKeyHandler } from "./input"
import { CHIPS, chipLabel, cycleChip } from "./libchips"
import type { Nav } from "./screen"
import { Btn, Chip } from "./ui"

export function Pane({ nav, focusKey, onClose, onBack }: { nav: Nav; focusKey: string | null; onClose: () => void; onBack: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  const sh = shell()
  const here = sh?.server && typeof sh.servers === "function" && typeof sh.switchTo === "function" ? sh.server : null
  // The Server list under the item: null closed, "looking" while the fresh sweep runs.
  const [list, setList] = useState<null | "looking" | (ShellServer & { current: boolean })[]>(null)
  const asked = useRef(0)

  const openServers = () => {
    if (list) return setList(null)
    const n = ++asked.current
    setList("looking")
    sh!.servers!().then(
      (l) => n === asked.current && setList(l),
      () => n === asked.current && setList([]),
    )
  }
  useLayoutEffect(() => {
    const r = root.current
    if (!r || !Array.isArray(list)) return
    const other = list.find((v) => !v.current)
    focusEl(findByKey(r, `p-srv-${(other ?? list[0])?.address}`) ?? findByKey(r, "p-server"), 0)
  }, [list])

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
        if (list) {
          asked.current++
          setList(null)
          focusEl(findByKey(r, "p-server"), 0)
        } else onBack()
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
      {here && (
        <>
          <Btn itemKey="p-server" zone="pane" class="srv" onPress={openServers}>
            Server: {here.name}
          </Btn>
          {list && (
            <div class="psrv">
              {list === "looking" ? (
                <div class="pnote">Looking for Library Servers…</div>
              ) : (
                <>
                  {list.map((v) => (
                    <Btn
                      key={v.address}
                      itemKey={`p-srv-${v.address}`}
                      zone="pane"
                      class={v.current ? "on" : undefined}
                      onPress={() => (v.current ? setList(null) : sh!.switchTo!(v.address))}
                    >
                      {v.name}
                      {v.home && <small> Home</small>}
                      {v.current && <small> (this one)</small>}
                    </Btn>
                  ))}
                  {!list.some((v) => !v.current) && <div class="pnote">No other Library Server answered</div>}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
