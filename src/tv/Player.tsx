// The Player STUB (docs/tv-spec.md 6): replaced wholesale by the tv-player ticket (#100). It plays the Preferred Copy in
// a <video>, Enter pauses, Left/Right seek 10 s, `<` `>` step Playing from (or the Playlist a Shuffle started), Back
// leaves. It writes nothing: no Resume position, no view.
import { useEffect, useRef, useState } from "preact/hooks"
import { advance, current, stepBack, type Playlist } from "../shared/playlist"
import { positionIn, stepFrom, type PlayingFrom, SOURCE_LABEL } from "../shared/playingFrom"
import { startPosition } from "../shared/resume"
import type { VideoDto } from "../shared/types"
import { fmtDuration } from "../web/ui"
import { REMUX_MESSAGE, pickTvCopy } from "./copies"
import { url } from "./data"
import { useKeyHandler } from "./input"
import type { Nav } from "./screen"
import { Tags } from "./ui"

export const SEEK_S = 10
const OSD_MS = 3000

/** Desktop development runs muted (no stray sound while testing); on the TV the Player is not muted. */
const muted = () => typeof window !== "undefined" && (!window.tuvaTv || /[?&]mute=1\b/.test(location.search))

export interface PlayerProps {
  videoId: number
  startS: number | null
  playingFrom: PlayingFrom
  playlist: Playlist | null
  nav: Nav
  active: boolean
  /** Replace this screen with another Video (stepping must not pile screens up). */
  step: (videoId: number, o: { startS: number | null; playlist: Playlist | null }) => void
}

export function Player({ videoId, startS, playingFrom, playlist, nav, active, step }: PlayerProps) {
  const video: VideoDto | undefined = nav.data.videos.find((v) => v.id === videoId)
  const copy = video ? pickTvCopy(video.copies) : null
  const live = copy?.tv.order === "live"
  const ref = useRef<HTMLVideoElement>(null)
  const [paused, setPaused] = useState(false)
  const [needsEnter, setNeedsEnter] = useState(false)
  const [osd, setOsd] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [t, setT] = useState(0)
  const osdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const msgTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flash = (m: string) => {
    setMsg(m)
    clearTimeout(msgTimer.current)
    msgTimer.current = setTimeout(() => setMsg(null), 2500)
  }
  const wake = () => {
    setOsd(true)
    clearTimeout(osdTimer.current)
    osdTimer.current = setTimeout(() => setOsd(false), OSD_MS)
  }
  useEffect(() => {
    wake()
    return () => {
      clearTimeout(osdTimer.current)
      clearTimeout(msgTimer.current)
    }
  }, [videoId])

  // Open at the Chapter's time or the shared Resume position (spec 6.8); autoplay may be refused.
  useEffect(() => {
    const el = ref.current
    if (!el || !copy || live || !video) return
    const at = startPosition({ t: startS, resumeS: video.resumeS, durationS: video.durationS })
    const onMeta = () => {
      if (at > 0) {
        el.currentTime = at
        if (startS == null) flash(`Resuming at ${fmtDuration(at)}`)
      }
    }
    const onPlay = () => {
      setNeedsEnter(false)
      setPaused(false)
    }
    const onPause = () => setPaused(true)
    const onTime = () => setT(el.currentTime)
    const onEnded = () => {
      if (playlist) return next(1)
      flash(playingFrom.ids.length > 1 ? "End of the Video" : "End")
    }
    el.addEventListener("loadedmetadata", onMeta)
    el.addEventListener("play", onPlay)
    el.addEventListener("pause", onPause)
    el.addEventListener("timeupdate", onTime)
    el.addEventListener("ended", onEnded)
    el.play().catch(() => setNeedsEnter(true))
    return () => {
      for (const [n, f] of [["loadedmetadata", onMeta], ["play", onPlay], ["pause", onPause], ["timeupdate", onTime], ["ended", onEnded]] as const) el.removeEventListener(n, f)
    }
  }, [copy?.id, videoId])

  const playable = (id: number) => nav.data.videos.find((v) => v.id === id)?.available === true

  /** `<` `>`: the Playlist when a Shuffle started one, else Playing from. */
  const next = (dir: 1 | -1) => {
    if (playlist) {
      let pl = playlist
      if (dir === 1) {
        const r = advance(pl, playable)
        if (r.ended) return flash("Playlist ended")
        pl = r.pl
      } else pl = stepBack(pl, playable)
      const e = current(pl)
      if (e && e.videoId !== videoId) return step(e.videoId, { startS: null, playlist: pl })
      return
    }
    const id = stepFrom(playingFrom, videoId, dir, playable)
    if (id == null) return flash("Nothing else in this list")
    step(id, { startS: null, playlist: null })
  }

  const seek = (d: number) => {
    const el = ref.current
    if (!el) return
    el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + d))
    flash(`${d > 0 ? "+" : "−"}${SEEK_S} s`)
  }
  const toggle = () => {
    const el = ref.current
    if (!el) return
    if (el.paused) void el.play().catch(() => setNeedsEnter(true))
    else el.pause()
  }

  useKeyHandler(active, (k) => {
    wake()
    switch (k.action) {
      case "enter":
      case "playpause":
        toggle()
        return true
      case "play":
        void ref.current?.play()
        return true
      case "pause":
        ref.current?.pause()
        return true
      case "left":
        seek(-SEEK_S)
        return true
      case "right":
        seek(SEEK_S)
        return true
      case "prev":
        next(-1)
        return true
      case "next":
        next(1)
        return true
      case "back":
        nav.back()
        return true
      case "char":
        if (k.char === " ") {
          toggle()
          return true
        }
    }
    return false
  })

  const pos = positionIn(playingFrom, videoId)
  const duration = video?.durationS ?? ref.current?.duration ?? 0
  return (
    <div class="screen pl">
      {video && copy && !live && <video ref={ref} src={url(copy.url)} muted={muted()} autoplay playsInline preload="auto" />}
      {(!video || !copy || live) && (
        <div class="plmsg">
          {!video ? "This Video is not in the library." : !copy ? "Copy unavailable" : REMUX_MESSAGE}
        </div>
      )}
      <div class={`pl-top${osd || paused ? " on" : ""}`}>
        <div class="t1">{video?.title ?? ""}</div>
        {video && <Tags video={video} />}
        <div class="from">
          Playing from {SOURCE_LABEL[playingFrom.source]}
          {pos ? ` · ${pos.n} of ${pos.total}` : ""}
          {playlist ? " · shuffled Playlist" : ""}
        </div>
      </div>
      <div class={`pl-bar${osd || paused ? " on" : ""}`}>
        <span>{fmtDuration(t)}</span>
        <div class="bar">
          <i style={{ width: `${duration ? Math.min(100, (t / duration) * 100) : 0}%` }} />
        </div>
        <span>{fmtDuration(duration)}</span>
      </div>
      {needsEnter && <div class="plmsg over">Press Enter to play</div>}
      {msg && <div class="toast on">{msg}</div>}
    </div>
  )
}
