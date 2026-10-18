// TuvaVideos TV UI (docs/tv-spec.md 5, 7, 8). Loaded by the signed shell from the TV Server (/tv.js, /tv.css), or
// standalone in a desktop browser at http://127.0.0.1:4401/ for development. A stack of screens (nav.ts), a pane
// over them, one key dispatch (input.ts) and the geometry focus engine (focus.ts).
import { render } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"
import { isUuid } from "../shared/ids"
import { defaultLibraryState, type LibraryState } from "../shared/libraryView"
import { pickRandomVideo } from "../shared/random"
import { Grid } from "./Grid"
import { Home } from "./Home"
import { Pane } from "./Pane"
import { Player } from "./Player"
import { setActivePlaylist } from "./playlistOps"
import { Search } from "./Search"
import { api, exitApp } from "./data"
import { focusEl, keyOf } from "./focus"
import { installKeys } from "./input"
import { makeEntry, pop, push, replaceTop, top, type Entry, type Route } from "./nav"
import { libraryOrder, libraryTiles, shuffleStart, type TvData } from "./rails"
import type { Nav } from "./screen"

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: TvData }

async function loadAll(): Promise<TvData> {
  const [videos, artists, songs, favorites] = await Promise.all([api.videos(), api.artists(), api.songs(), api.favorites()])
  return { videos, artists, songs, favorites }
}

/** The 1920x1080 stage, scaled to fit when the window is another size (a desktop browser); exactly 1 on the TV. */
function fitStage() {
  const el = document.getElementById("tv")
  if (!el) return
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080)
  el.style.transform = s === 1 ? "" : `scale(${s})`
}

function App() {
  const [load, setLoad] = useState<Load>({ state: "loading" })
  const [stack, setStack] = useState<Entry[]>(() => [makeEntry({ kind: "home" })])
  const [pane, setPane] = useState<{ open: boolean; focusKey: string | null }>({ open: false, focusKey: null })
  const [lib, setLib] = useState<LibraryState>(defaultLibraryState())
  const [toast, setToast] = useState<string | null>(null)
  const [info, setInfo] = useState(false)
  const paneReturn = useRef<HTMLElement | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const live = useRef({ stack, pane, load })
  live.current = { stack, pane, load }

  const reload = () =>
    loadAll()
      .then((data) => setLoad({ state: "ready", data }))
      .catch((e) => setLoad((l) => (l.state === "ready" ? l : { state: "error", message: String(e?.message ?? e) })))
  useEffect(() => {
    void reload()
    fitStage()
    window.addEventListener("resize", fitStage)
    return () => window.removeEventListener("resize", fitStage)
  }, [])

  const say = (msg: string) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }

  const closePane = (refocus = true) => {
    setPane({ open: false, focusKey: null })
    const el = paneReturn.current
    paneReturn.current = null
    if (refocus && el?.isConnected) requestAnimationFrame(() => focusEl(el, 80))
  }

  const data = load.state === "ready" ? load.data : null

  const openRoute = (route: Route) => {
    const fromPane = live.current.pane.open ? keyOf(document.activeElement) : null
    if (fromPane) {
      setPane({ open: false, focusKey: null })
      paneReturn.current = null
    }
    if (route.kind === "player" && route.playlist) setActivePlaylist(route.playlist) // a Shuffle started a Playlist (spec 6.7)
    setStack((s) => push(s, makeEntry(route, fromPane)))
  }

  const nav: Nav | null = data
    ? {
        data,
        lib,
        setLib,
        openGrid: (grid) => openRoute({ kind: "grid", grid }),
        openSearch: () => openRoute({ kind: "search" }),
        swapToGrid: (grid) => {
          setStack((s) => replaceTop(s, makeEntry({ kind: "grid", grid })))
          void reload() // the Player wrote Resume on the way out
        },
        play: (videoId, o) => openRoute({ kind: "player", videoId, startS: o.startS ?? null, playingFrom: o.playingFrom, playlist: o.playlist ?? null }),
        random: () => {
          const id = pickRandomVideo(data.videos)
          if (id == null) return say("No Video is available")
          openRoute({ kind: "player", videoId: id, startS: null, playingFrom: { source: "library", ids: libraryOrder(data.videos).map((v) => v.id) }, playlist: null })
        },
        shuffleLibrary: () => {
          const s = shuffleStart(libraryTiles(data.videos, defaultLibraryState()), "library", false)
          if (!s) return say("Nothing here can be played")
          openRoute({ kind: "player", videoId: s.videoId, startS: null, playingFrom: s.playingFrom, playlist: s.playlist })
        },
        openPane: () => {
          if (live.current.pane.open) return
          paneReturn.current = document.activeElement as HTMLElement | null
          setPane({ open: true, focusKey: null })
        },
        back: () => {
          const { stack: next, popped } = pop(live.current.stack)
          if (!popped) return
          setStack(next)
          if (popped.route.kind === "player") void reload() // Resume and last-played may have moved
          if (popped.fromPane) setPane({ open: true, focusKey: popped.fromPane })
        },
        toast: say,
      }
    : null

  // The global keys: Exit leaves, Info shows the state; Back with nothing else to do on the home opens the pane.
  useEffect(
    () =>
      installKeys((k) => {
        if (k.action === "exit") return exitApp()
        if (k.action === "info") {
          setInfo((v) => !v)
          return true
        }
        return false
      }),
    [],
  )

  // Desktop development only (no shell): `?play=<videoId>[&t=<seconds>]` opens that Video once the library has loaded.
  const autoPlayed = useRef(false)
  useEffect(() => {
    if (!nav || autoPlayed.current || window.tuvaTv) return
    const q = new URLSearchParams(location.search)
    const id = q.get("play")
    autoPlayed.current = true
    if (!isUuid(id)) return
    const t = q.get("t")
    nav.play(id, { startS: t != null && t !== "" ? Number(t) : null, playingFrom: { source: "library", ids: libraryOrder(nav.data.videos).map((v) => v.id) } })
  }, [!!nav])

  const topEntry = top(stack)
  const stepPlayer = (e: Entry, videoId: string, o: { startS: number | null; playlist: import("../shared/playlist").Playlist | null }) => {
    if (e.route.kind !== "player") return
    const route: Route = { ...e.route, videoId, startS: o.startS, playlist: o.playlist }
    setStack((s) => replaceTop(s, makeEntry(route, e.fromPane)))
  }

  if (load.state === "loading") return <div class="loading">Loading the library…</div>
  if (load.state === "error")
    return (
      <div class="loading">
        <div>
          Could not load the library
          <small>{load.message}</small>
        </div>
      </div>
    )
  const n = nav!
  const paneOnGrid = stack.length > 1

  return (
    <>
      <div class={`stage${pane.open ? " dim" : ""}${topEntry.route.kind === "player" ? " full" : ""}`}>
        {stack.map((e) => {
          const active = e === topEntry && !pane.open
          return (
            <div key={e.id} class={`layer${e === topEntry ? " cur" : ""}`}>
              <Screen e={e} nav={n} active={active} mounted={e === topEntry || e.route.kind !== "player"} step={(v, o) => stepPlayer(e, v, o)} />
            </div>
          )
        })}
      </div>
      {pane.open && (
        <Pane
          nav={n}
          focusKey={pane.focusKey}
          onClose={() => closePane()}
          onBack={() => {
            // Back inside the pane exits the app from the home; over a grid it only closes the pane.
            if (paneOnGrid) closePane()
            else if (!exitApp()) say("Back at the top: the TV app would exit here")
          }}
        />
      )}
      <div id="toast" class={toast ? "on" : ""}>
        {toast}
      </div>
      {info && <pre id="state">{JSON.stringify({ stack: stack.map((e) => e.route.kind), pane: pane.open, focus: keyOf(document.activeElement), lib }, null, 1)}</pre>}
      {(topEntry.route.kind !== "player" || pane.open) && <Hints route={topEntry.route} pane={pane.open} />}
    </>
  )
}

function Screen({ e, nav, active, mounted, step }: { e: Entry; nav: Nav; active: boolean; mounted: boolean; step: (videoId: string, o: { startS: number | null; playlist: import("../shared/playlist").Playlist | null }) => void }) {
  if (!mounted) return null
  const r = e.route
  switch (r.kind) {
    case "home": return <Home nav={nav} active={active} />
    case "grid": return <Grid spec={r.grid} nav={nav} active={active} />
    case "search": return <Search nav={nav} active={active} mem={e.mem} />
    case "player": return <Player videoId={r.videoId} startS={r.startS} playingFrom={r.playingFrom} playlist={r.playlist} nav={nav} active={active} step={step} />
  }
}

const HINTS: Record<Route["kind"], string> = {
  home: "◀▶▲▼ move · Enter open · Back or ◀ at the start: menu",
  grid: "◀▶▲▼ move · Enter open · Ch▲▼ page · Back returns",
  search: "◀▶▲▼ keys · Enter type or open · ▶ results · Back",
  player: "",
}

function Hints({ route, pane }: { route: Route; pane: boolean }) {
  return <div id="hints">{pane ? "▲▼ move · Enter open · ▶ close · Back exits" : HINTS[route.kind]}</div>
}

// ---- boot ----
const mount = document.getElementById("tv") ?? (() => {
  const el = document.createElement("div")
  el.id = "tv"
  document.body.appendChild(el)
  return el
})()
document.getElementById("boot")?.remove()
render(<App />, mount)
