// The TV Player (docs/tv-spec.md 6, 3.3, 2.5): the whole video letterboxed in the left column, a standalone lyrics column on
// the right, the zones the arrows reach (lyrics, tag row, button row, Chapter and Copy lists), the Netflix-style OSD, the
// Playlist without its panel, the keyframe-snapped seeks, Resume and views, and the Video's Audio settings through the
// Web Audio chain. Pure parts live next to it: zones.ts (the key table), seekStep.ts, lyrics.ts, osd.ts, copyList.ts,
// tags.ts, playlistOps.ts, audioChain.ts, hues.ts.
import { useEffect, useMemo, useRef, useState } from "preact/hooks"
import type { AudioState } from "../shared/audio"
import type { ScriptKey } from "../shared/lyrics/types"
import { clampTime, fmtClock, keyframeSeekTarget } from "../shared/playerMath"
import { stepFrom, type PlayingFrom } from "../shared/playingFrom"
import { current, widenToVideo, type Playlist } from "../shared/playlist"
import { ENDED_LABEL, entryRange, nextEntry, nextLabel, openAt, prevEntry, prevLabel, reachedEnd, resumeAllowed, seekWidens } from "../shared/playlistPlayer"
import { ResumeClock, RESUME_INTERVAL_MS, storedResume } from "../shared/resume"
import { SeekThrottle } from "../shared/seekThrottle"
import type { ChapterDto, CopyDto, SongDto, VideoDto } from "../shared/types"
import { AudioEngine } from "../web/audioEngine"
import { artistSlot } from "../web/ui"
import { AudioChain, audioTag, type AudioMode } from "./audioChain"
import { REMUX_MESSAGE, failedMessage, pickPlayable } from "./copies"
import { copyLabel, copyRows } from "./copyList"
import { api, url, writes } from "./data"
import { useKeyHandler } from "./input"
import { lyricsView, nextScript, noLyricsReason, songTarget } from "./lyrics"
import { openTag } from "./open"
import { OSD_FADE_MS, chapterLine, nextUp, osdVisible, pct } from "./osd"
import { LyricsColumn, PlList, type ListRow, type LyricsCtl } from "./PlayerParts"
import { activePlaylist, buttonFaces, entryStart, pressRepeat, pressShuffle, resolveOpen, setActivePlaylist } from "./playlistOps"
import { libraryOrder } from "./rails"
import type { Nav } from "./screen"
import { REW_FF_S, nextSeekStep, stepLabel, type SeekRamp } from "./seekStep"
import { focusableTags, infoTexts, playingFromText } from "./tags"
import { BUTTONS, initialZone, pinsBottom, pinsTop, reduceZone, type Fx, type ZoneCtx, type ZoneState } from "./zones"

/** Desktop development runs muted (no stray sound while testing); on the TV the Player is not muted. */
const muted = () => typeof window !== "undefined" && (!window.tuvaTv || /[?&]mute=1\b/.test(location.search))

// Session preferences (kept across Videos until the app is closed): lyrics shown, the Script.
let lyricsOnPref = true
let scriptPref: ScriptKey = "cyrillic"

const songCache = new Map<string, SongDto>()
async function songFor(id: string): Promise<SongDto | null> {
  const hit = songCache.get(id)
  if (hit) return hit
  try {
    const s = await api.song(id)
    songCache.set(id, s)
    return s
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Phase = "loading" | "ready" | "unavailable" | "failed" | "remux"

export interface PlayerProps {
  videoId: string
  startS: number | null
  playingFrom: PlayingFrom
  /** The route's hint; the active Playlist lives in playlistOps (set by the Shuffle that starts one). */
  playlist: Playlist | null
  nav: Nav
  active: boolean
  /** Replace this screen with another Video (stepping must not pile screens up). */
  step: (videoId: string, o: { startS: number | null; playlist: Playlist | null }) => void
}

export function Player({ videoId, startS, playingFrom, nav, active, step }: PlayerProps) {
  const vid = useRef<HTMLVideoElement>(null)
  const elRef = useRef<HTMLVideoElement | null>(null) // the element as last mounted, for the cleanup (the ref may be nulled by then)
  const [gen, setGen] = useState(0) // a new <video> element: the Web Audio chain captured the old one and failed
  const [video, setVideo] = useState<VideoDto | undefined>(() => nav.data.videos.find((v) => v.id === videoId))
  const [pl, setPlState] = useState<Playlist | null>(() => {
    const r = resolveOpen(activePlaylist(), videoId) // opened from elsewhere: jumps to that Entry, else the Playlist ends
    setActivePlaylist(r)
    return r
  })
  const [chapters, setChapters] = useState<ChapterDto[]>([])
  const [copyId, setCopyId] = useState<number | null>(null)
  const [phase, setPhase] = useState<Phase>("loading")
  const [failedCopy, setFailedCopy] = useState<CopyDto | null>(null)
  const [t, setT] = useState(0)
  const [paused, setPaused] = useState(true)
  const [needsEnter, setNeedsEnter] = useState(false)
  const [zs, setZsState] = useState<ZoneState>(initialZone())
  const [awakeAt, setAwakeAt] = useState(() => Date.now())
  const [, setTick] = useState(0)
  const [flash, setFlash] = useState<{ text: string; n: number } | null>(null)
  const [badge, setBadge] = useState<string | null>(null)
  const [lyricsOn, setLyricsOnState] = useState(lyricsOnPref)
  const [scriptTick, setScriptTick] = useState(0)
  const [song, setSong] = useState<SongDto | null | undefined>(undefined)
  const [audioMode, setAudioMode] = useState<AudioMode>("none")
  const [resumeMark, setResumeMark] = useState<number | null>(null)

  // ---- mutable state that handlers read ----
  const R = useRef({
    started: false, // metadata loaded and the start position applied: only then may Resume be written
    viewed: false, // one view per Player visit, the first time playback starts (spec 2.5)
    pending: { at: 0, play: true, announce: false },
    keyframes: null as number[] | null, // the playing Copy's keyframe index, once fetched
    seekTarget: null as number | null, // the last requested seek while in flight or queued: held keys step from it
    ramp: null as SeekRamp | null,
    entryDone: false, // the Playlist Entry's end was handled once; cleared when the playhead is back inside it
    failed: new Set<number>(),
    retried: new Set<number>(),
    lastPos: 0,
    hold: 0, // position kept while "Copy unavailable"
    token: 0, // bumped by every load and on unmount: a stale keyframe poll stops when it sees a newer one
    copyId: null as number | null,
    audio: null as Promise<AudioState | null> | null,
    audioStarted: false,
    audioOff: false,
    seekWrite: 0 as unknown as ReturnType<typeof setTimeout>,
    flashTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    badgeTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    awakeTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    flashN: 0,
    alive: true,
  })
  const clock = useRef(new ResumeClock(RESUME_INTERVAL_MS))
  const throttle = useRef(
    new SeekThrottle((to) => {
      const v = vid.current
      if (v) v.currentTime = to
    }),
  )
  const chain = useRef(
    new AudioChain({
      probe: () => AudioEngine.probe(),
      build: (el) => {
        const e = AudioEngine.for(el)
        return { set: (s) => e.set(s), dispose: () => e.dispose() }
      },
    }),
  )
  const lyricsCtl = useRef<LyricsCtl | null>(null)
  const PL = useRef(pl)
  PL.current = pl
  const ZS = useRef(zs)
  ZS.current = zs
  // handlers, re-assigned every render so listeners never see a stale closure
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const E = useRef({} as Record<string, (...a: any[]) => any>)

  // ---- derived ----
  const copies = video?.copies ?? []
  const copy = copies.find((c) => c.id === copyId) ?? null
  const durationNow = (): number | null => {
    const d = vid.current?.duration
    return d != null && Number.isFinite(d) && d > 0 ? d : (copy?.durationS ?? video?.durationS ?? null)
  }
  const duration = durationNow()
  const playable = (id: string) => nav.data.videos.find((v) => v.id === id)?.available === true
  const titleOf = (id: string) => nav.data.videos.find((v) => v.id === id)?.title ?? `Video ${id}`
  const range = pl ? entryRange(current(pl), chapters, duration) : null
  const { chapter: curChapter, target } = songTarget(chapters, t, video ?? { songId: null, versionId: null })
  const targetId = target?.songId ?? null
  const lview = useMemo(() => (song ? lyricsView(song, target?.versionId ?? null, scriptPref) : null), [song, target?.versionId, scriptTick])
  const hasLyrics = !!lview && lview.script != null && lview.lines.length > 0
  const reason: string | null = hasLyrics ? null : targetId && song === undefined ? "Loading lyrics…" : (noLyricsReason(target, song) ?? (lview ? "This Version has no text" : null))
  const showLyrics = lyricsOn && hasLyrics
  const tags = video ? focusableTags(video) : []
  const rows = copyRows(copies, copyId)
  const chIdx = curChapter ? chapters.indexOf(curChapter) : -1
  const zctx: ZoneCtx = { hasLyrics, tagCount: tags.length, chapterCount: chapters.length, currentChapter: chIdx, copySwitchable: rows.map((r) => r.switchable), currentCopy: Math.max(0, rows.findIndex((r) => r.playing)) }
  const S = useRef({ video, copies, chapters, range, duration, playable, zctx })
  S.current = { video, copies, chapters, range, duration, playable, zctx }

  // ---- the little things: OSD wake, flashes, badge ----
  const wake = () => {
    setAwakeAt(Date.now())
    clearTimeout(R.current.awakeTimer)
    R.current.awakeTimer = setTimeout(() => setTick((n) => n + 1), OSD_FADE_MS + 60)
  }
  const say = (text: string, ms = 2400) => {
    const r = R.current
    setFlash({ text, n: ++r.flashN })
    clearTimeout(r.flashTimer)
    r.flashTimer = setTimeout(() => setFlash(null), ms)
    wake()
  }
  const showBadge = (text: string) => {
    const r = R.current
    setBadge(text)
    clearTimeout(r.badgeTimer)
    r.badgeTimer = setTimeout(() => setBadge(null), 900)
  }
  const setZone = (z: ZoneState) => {
    ZS.current = z
    setZsState(z)
  }
  const commitPl = (next: Playlist | null) => {
    PL.current = next
    setActivePlaylist(next)
    setPlState(next)
  }

  // ---- Resume (spec 2.5) ----
  const writeResume = () => {
    const r = R.current
    if (!r.started || !resumeAllowed(!!PL.current) || !S.current.video) return
    const v = vid.current
    const pos = v && v.readyState > 0 ? v.currentTime : r.lastPos
    clock.current.wrote(Date.now())
    writes.resume(videoId, storedResume(pos, S.current.duration), r.copyId)
  }

  // ---- loading a Copy ----
  const fetchKeyframes = async (id: number, token: number) => {
    for (let tries = 0; tries < 60; tries++) {
      const st = await api.keyframes(id).catch(() => null)
      if (token !== R.current.token || !st || st.state === "none") return
      if (st.state === "ready") {
        R.current.keyframes = st.keyframes
        return
      }
      await sleep(3000) // indexing (202): exact seeks until it arrives
    }
  }

  const attach = (c: CopyDto, at: number, play: boolean, announce = false) => {
    const v = vid.current
    if (!v) return
    const r = R.current
    r.pending = { at, play, announce }
    r.started = false
    r.keyframes = null
    r.seekTarget = null
    r.copyId = c.id
    const token = ++r.token
    throttle.current.reset()
    setCopyId(c.id)
    setPhase("loading")
    setNeedsEnter(false)
    v.src = url(c.url)
    v.load()
    void fetchKeyframes(c.id, token)
  }

  /** The playing Copy is gone (Root unmounted) or broken: next Available Copy at the same time, else "Copy unavailable" (spec 4.2). */
  const lose = (id: number, markFailed: boolean, atOverride?: number, playOverride?: boolean) => {
    const r = R.current
    const v = vid.current
    const pos = atOverride ?? (v && v.readyState > 0 ? v.currentTime : r.lastPos)
    const wasPlaying = playOverride ?? (v ? !v.paused : true)
    if (markFailed) r.failed.add(id)
    writeResume()
    const skip = new Set([...r.failed, id])
    const n = pickPlayable(S.current.copies, skip)
    if (n && !n.live) {
      say(`Switching to ${n.copy.rootKind} Copy · ${copyLabel(n.copy)}`, 3000)
      attach(n.copy, pos, wasPlaying)
      return
    }
    r.token++
    r.hold = pos
    r.started = false
    r.copyId = null
    if (v) {
      v.pause()
      v.removeAttribute("src")
      v.load()
    }
    setPaused(true)
    setFailedCopy(markFailed ? (S.current.copies.find((c) => c.id === id) ?? null) : null)
    setPhase(n ? "remux" : markFailed ? "failed" : "unavailable")
  }

  const pickCopy = (index: number) => {
    const row = S.current.copies[index]
    const v = vid.current
    if (!row) return
    const pos = v && v.readyState > 0 ? v.currentTime : R.current.lastPos
    writeResume()
    R.current.failed.delete(row.id)
    say(`Copy: ${copyLabel(row)} · ${row.rootKind}`)
    attach(row, pos, v ? !v.paused : true) // exact seek at the same time; the choice is never remembered
  }

  // ---- seeking (spec 3.3) ----
  /** `keyframe` snaps to the Copy's index once it has arrived (nearest to the target; `from` makes a relative seek always move). */
  const seekTo = (to: number, mode: "exact" | "keyframe" = "exact", from?: number, throttled = false, internal = false) => {
    const v = vid.current
    if (!v || v.readyState === 0) return
    const dur = Number.isFinite(v.duration) ? v.duration : null
    let c = clampTime(to, dur)
    const rg = S.current.range
    if (!internal && PL.current && rg && seekWidens(rg, c)) commitPl(widenToVideo(PL.current)) // past the Chapter Entry's end: a Video Entry now
    if (mode === "keyframe" && R.current.keyframes) c = clampTime(keyframeSeekTarget(c, R.current.keyframes, from), dur)
    R.current.seekTarget = c
    throttle.current.request(c, throttled)
    setT(c)
  }
  const seekBy = (dir: 1 | -1, kind: "ramp" | "flat") => {
    const v = vid.current
    if (!v || !R.current.started) return
    let stepS = REW_FF_S
    if (kind === "ramp") {
      const x = nextSeekStep(R.current.ramp, dir, performance.now())
      R.current.ramp = x.ramp
      stepS = x.step
    }
    const base = R.current.seekTarget ?? v.currentTime // a held key steps from the seek already requested
    seekTo(base + dir * stepS, "keyframe", base, true)
    showBadge(stepLabel(dir, stepS))
  }

  const toggle = () => {
    const v = vid.current
    if (!v || !R.current.started) return
    if (v.paused) void v.play().catch(() => setNeedsEnter(true))
    else v.pause()
  }

  // ---- the Playlist (spec 6.7) ----
  /** Make `next`'s current Entry the one on screen: a Chapter Entry of this Video is a seek, another Video replaces the screen. */
  const goTo = async (next: Playlist, label?: string) => {
    const e = current(next)
    if (!e) return
    if (label) say(label, 2600)
    if (e.videoId === videoId) {
      const s = entryStart(next, S.current.chapters)
      commitPl(s.pl)
      R.current.entryDone = false
      seekTo(s.startS ?? 0, "exact", undefined, false, true)
      void vid.current?.play().catch(() => {})
      return
    }
    const chs = e.chapterId !== undefined ? await api.chapters(e.videoId).catch(() => null) : null
    const s = entryStart(next, chs)
    commitPl(s.pl)
    writeResume()
    step(e.videoId, { startS: s.startS, playlist: s.pl })
  }

  /** The Entry is over (the Video ended, or a Chapter Entry reached the next Chapter): Repeat one restarts it, else the Playlist advances. */
  const entryEnded = () => {
    const r = R.current
    const v = vid.current
    const cur = PL.current
    if (!cur || !v || r.entryDone) return
    r.entryDone = true
    const m = nextEntry(cur, "end", S.current.playable)
    if (m.kind === "restart") {
      if (m.pl !== cur) commitPl(m.pl)
      seekTo(S.current.range?.start ?? 0, "exact", undefined, false, true)
      r.entryDone = false
      void v.play().catch(() => {})
    } else if (m.kind === "ended") {
      v.pause() // paused on the last frame
      say(ENDED_LABEL, 6000)
    } else if (m.kind === "move") {
      void goTo(m.pl, nextLabel(titleOf(current(m.pl)!.videoId)))
    }
  }

  /** `<` `>`: the Playlist when one is active, else Playing from. */
  const stepKey = (dir: 1 | -1) => {
    const cur = PL.current
    if (cur) {
      if (dir === 1) {
        const m = nextEntry(cur, "key", S.current.playable)
        if (m.kind === "none") return say("End of the Playlist")
        if (m.pl !== cur) commitPl(m.pl)
        return void goTo(m.pl, nextLabel(titleOf(current(m.pl)!.videoId)))
      }
      const back = prevEntry(cur, S.current.playable)
      if (!back) return say("Start of the Playlist")
      return void goTo(back, prevLabel(titleOf(current(back)!.videoId)))
    }
    const id = stepFrom(playingFrom, videoId, dir, S.current.playable)
    if (id == null) return say("Nothing else in this list")
    writeResume()
    step(id, { startS: null, playlist: null })
  }

  const setLyricsOn = (on: boolean) => {
    lyricsOnPref = on
    setLyricsOnState(on)
  }

  // ---- the effects of a key (zones.ts decides, this does) ----
  const runFx = (fx: Fx) => {
    switch (fx.t) {
      case "toggle": return toggle()
      case "play": return void vid.current?.play().catch(() => setNeedsEnter(true))
      case "pause": return vid.current?.pause()
      case "seek": return seekBy(fx.dir, fx.kind)
      case "page": return lyricsCtl.current?.page(fx.dir)
      case "lyrics": {
        if (!hasLyrics) return say(reason ?? "No lyrics")
        const on = fx.on === "toggle" ? !lyricsOn : fx.on
        setLyricsOn(on)
        return say(on ? "Lyrics on" : "Lyrics off", 1400)
      }
      case "script": {
        if (!lview || !lview.script) return say(reason ?? "No lyrics to switch")
        const n = nextScript(lview.present, lview.script)
        if (!n || n === lview.script) return say("Only one Script in this Version", 1800)
        scriptPref = n
        setScriptTick((k) => k + 1)
        return say(`Script: ${n}`, 1400)
      }
      case "step": return stepKey(fx.dir)
      case "tag": {
        const tag = tags[fx.index]
        if (!tag) return
        writeResume()
        return openTag(tag, nav) // leaves the Player: the grid replaces it, Back returns to where the Video was opened from
      }
      case "button": {
        if (fx.id === "shuffle") {
          const res = pressShuffle(PL.current, libraryOrder(nav.data.videos).map((x) => x.id), videoId)
          if (res.pl !== PL.current) commitPl(res.pl)
          return say(res.label)
        }
        const res = pressRepeat(PL.current)
        if (res.pl !== PL.current) commitPl(res.pl)
        return say(res.label, 2600)
      }
      case "chapter": {
        const c = S.current.chapters[fx.index]
        if (!c) return
        seekTo(c.startS, "exact") // Chapters are exact
        void vid.current?.play().catch(() => {})
        return
      }
      case "copy": return pickCopy(fx.index)
      case "copyBlocked": {
        const row = rows[fx.index]
        return say(row?.viaRemux ? REMUX_MESSAGE : "Copy unavailable", 3000)
      }
      case "say": return say(fx.text, 1800)
      case "leave": return nav.back()
    }
  }

  useKeyHandler(active, (k) => {
    wake()
    if (k.action === "char") {
      if (k.char !== " ") return false
      toggle()
      return true
    }
    const res = reduceZone(ZS.current, k.action, S.current.zctx)
    if (res.state !== ZS.current) setZone(res.state)
    for (const fx of res.fx) runFx(fx)
    return res.handled
  })

  // ---- media event handlers (re-assigned each render; the listeners below call through E) ----
  E.current.onMeta = () => {
    const v = vid.current!
    const r = R.current
    const { at, play, announce } = r.pending
    if (muted()) v.muted = true
    if (at > 0) v.currentTime = clampTime(at, v.duration)
    r.started = true
    r.lastPos = at
    setT(at)
    setPhase("ready")
    if (announce) say(`Resuming at ${fmtClock(at)}`)
    if (play) v.play().catch(() => setNeedsEnter(true))
  }
  E.current.onPlay = () => {
    const v = vid.current!
    const r = R.current
    setPaused(false)
    setNeedsEnter(false)
    if (!r.audioStarted && !r.audioOff) {
      r.audioStarted = true
      void (async () => {
        const st = await (r.audio ?? Promise.resolve(null))
        const res = await chain.current.start(v, st, setAudioMode)
        if (!r.alive) return
        setAudioMode(res.mode)
        if (res.why) console.warn(`[tv audio] untouched: ${res.why}`)
        if (res.tainted) {
          // the context captured this element and then failed: its sound cannot be given back, so a new element plays instead
          r.audioOff = true
          r.pending = { at: v.currentTime, play: !v.paused, announce: false }
          setGen((g) => g + 1)
        }
      })()
    }
  }
  E.current.onPlaying = () => {
    const r = R.current
    if (!r.viewed) {
      r.viewed = true
      writes.view(videoId) // one view per Player visit (spec 2.5); counted inside a Playlist too
    }
  }
  E.current.onPause = () => {
    const v = vid.current!
    setPaused(true)
    clock.current.stopped()
    if (R.current.started) {
      R.current.lastPos = v.currentTime
      writeResume()
    }
    setT(v.currentTime)
  }
  E.current.onSeeked = () => {
    const v = vid.current!
    const r = R.current
    throttle.current.landed()
    if (!throttle.current.busy) r.seekTarget = null
    setT(v.currentTime)
    r.lastPos = v.currentTime
    clearTimeout(r.seekWrite)
    r.seekWrite = setTimeout(() => E.current.writeResume!(), 400) // one write per burst of seeks
  }
  E.current.onTime = () => {
    const v = vid.current!
    const r = R.current
    if (!r.started) return
    const now = v.currentTime
    r.lastPos = now
    if (!throttle.current.busy) setT(now)
    if (!v.paused && clock.current.tick(Date.now(), true)) writeResume() // every 5 s while playing
    const rg = S.current.range
    if (PL.current && rg?.end != null) {
      if (reachedEnd(rg, now)) {
        if (!r.entryDone && !v.seeking) entryEnded()
      } else if (now < rg.end - 0.5) r.entryDone = false
    }
  }
  E.current.onEnded = () => {
    const v = vid.current!
    if (PL.current) return entryEnded()
    v.currentTime = 0 // Playing from: a Video opened this way loops itself (spec 4.4)
    void v.play().catch(() => {})
  }
  E.current.onError = async () => {
    const r = R.current
    const v = vid.current
    const id = r.copyId
    if (id == null || !v || !v.getAttribute("src")) return
    const pos = r.started ? v.currentTime : r.pending.at
    const play = r.started ? !v.paused : r.pending.play
    const fresh = await api.video(videoId).catch(() => null)
    if (!r.alive || r.copyId !== id) return
    if (fresh) {
      S.current.video = fresh
      S.current.copies = fresh.copies
      setVideo(fresh)
    }
    const cur = (fresh ?? S.current.video)?.copies.find((c) => c.id === id)
    const intact = !!cur && cur.available && !cur.missing
    if (intact && !r.retried.has(id)) {
      r.retried.add(id) // the drive hiccuped: one more try of the same Copy before giving up on it
      await sleep(1500)
      if (r.alive && r.copyId === id && cur) attach(cur, pos, play)
      return
    }
    lose(id, intact, pos, play)
  }
  E.current.writeResume = writeResume

  // ---- mount: media listeners ----
  useEffect(() => {
    const el = vid.current
    if (!el) return
    elRef.current = el
    // an element that was replaced or removed may still fire a last event: only the current one counts
    const on = (ev: string, name: string) => el.addEventListener(ev, (e) => vid.current === el && E.current[name]!(e))
    on("loadedmetadata", "onMeta")
    on("play", "onPlay")
    on("playing", "onPlaying")
    on("pause", "onPause")
    on("seeked", "onSeeked")
    on("timeupdate", "onTime") // never requestVideoFrameCallback: it fires for the first frame only on the TV (spec 3.3)
    on("ended", "onEnded")
    on("error", "onError")
  }, [gen])

  // a new element after the Web Audio chain failed: put the same Copy back at the same time
  useEffect(() => {
    if (gen === 0) return
    const c = S.current.copies.find((x) => x.id === R.current.copyId)
    if (c) attach(c, R.current.pending.at, R.current.pending.play)
  }, [gen])

  // ---- mount: open ----
  useEffect(() => {
    const r = R.current
    r.alive = true
    let cancelled = false
    void (async () => {
      // the shared Resume position may have moved since the library loaded (the browser): ask once
      const fresh = (await api.video(videoId).catch(() => null)) ?? S.current.video
      if (cancelled) return
      if (!fresh) return setPhase("unavailable")
      S.current.video = fresh
      S.current.copies = fresh.copies
      setVideo(fresh)
      const picked = pickPlayable(fresh.copies)
      if (!picked) {
        r.hold = startS ?? fresh.resumeS ?? 0
        return setPhase("unavailable")
      }
      if (picked.live) {
        setCopyId(picked.copy.id)
        return setPhase("remux")
      }
      const inPl = !!PL.current
      const at = openAt({ t: startS, resumeS: fresh.resumeS, durationS: picked.copy.durationS ?? fresh.durationS }, inPl)
      const announce = startS == null && at > 0 && !inPl
      setResumeMark(announce ? at : null)
      attach(picked.copy, at, true, announce)
    })()
    // chapters (Chapter list, lyrics follow the Chapter) and the Video's Audio settings
    api.chapters(videoId).then((cs) => !cancelled && setChapters([...cs].sort((a, b) => a.startS - b.startS))).catch(() => {})
    r.audio = api
      .audio(videoId)
      .then((a) => a.state)
      .catch(() => null)
    void r.audio.then((st) => chain.current.warm(st))
    // the library moves under the Player: a Root unmounting under the playing Copy, or a Copy coming back
    const poll = setInterval(() => {
      api
        .video(videoId)
        .then((v) => {
          if (!r.alive) return
          S.current.video = v
          S.current.copies = v.copies
          setVideo(v)
        })
        .catch(() => {})
    }, 10_000)
    const leave = () => E.current.writeResume!()
    const vis = () => document.visibilityState === "hidden" && leave()
    window.addEventListener("pagehide", leave)
    document.addEventListener("visibilitychange", vis)
    wake()
    return () => {
      cancelled = true
      r.alive = false
      r.token++
      clearInterval(poll)
      for (const k of ["seekWrite", "flashTimer", "badgeTimer", "awakeTimer"] as const) clearTimeout(r[k])
      window.removeEventListener("pagehide", leave)
      document.removeEventListener("visibilitychange", vis)
      leave() // leaving the Player writes the position
      chain.current.dispose()
      const v = vid.current ?? elRef.current
      if (v) {
        v.pause()
        v.removeAttribute("src")
        v.load()
      }
    }
  }, [])

  // the Video moved under the Player (poll, error refresh): a lost Copy fails over; a Copy back after "unavailable" plays again
  useEffect(() => {
    const r = R.current
    if (!video) return
    if (phase === "unavailable" || phase === "failed" || phase === "remux") {
      const b = pickPlayable(video.copies, r.failed)
      if (b && !b.live && r.alive) {
        say(`Copy available again · ${copyLabel(b.copy)}`, 2600)
        attach(b.copy, r.hold, !paused || r.pending.play)
      }
      return
    }
    const cur = video.copies.find((c) => c.id === r.copyId)
    if (phase === "ready" && cur && (!cur.available || cur.missing)) lose(cur.id, false)
  }, [video, phase])

  // the Song under the playhead: the Chapter's, else the Video's
  useEffect(() => {
    let alive = true
    if (!targetId) return setSong(null)
    setSong(undefined)
    void songFor(targetId).then((s) => alive && setSong(s))
    return () => {
      alive = false
    }
  }, [targetId])

  // ---- render ----
  const z = zs.zone
  const pinned = paused || pinsTop(z) || pinsBottom(z) || phase !== "ready"
  const osdOn = osdVisible({ now: Date.now(), wokeAt: awakeAt, paused: pinned, zonePinned: false })
  const listOpen = z === "chapters" || z === "copies"
  const topOn = osdOn && !listOpen
  const faces = buttonFaces(pl)
  const next = nextUp({
    t,
    durationS: duration,
    chapters,
    entry: pl ? { end: range?.end ?? duration, nextTitle: () => nextEntryTitle(pl, nav, playable) } : null,
  })
  const poster = video?.thumbnail ? url(video.thumbnail.poster) : null
  const tagLine = infoTexts(copy, audioTag(audioMode))

  const chapterRows: ListRow[] = chapters.map((c, i) => ({
    key: c.id,
    lead: fmtClock(c.startS),
    title: `${c.title || "untitled"}${c.songId ? "  ♪" : ""}`,
    marks: c.suggested ? [{ text: "suggested", cls: "sug" }] : [],
    current: i === chIdx,
    focused: z === "chapters" && i === zs.row,
    dim: false,
  }))
  const copyListRows: ListRow[] = rows.map((r, i) => ({
    key: r.id,
    lead: r.root,
    title: `${r.label} · ${r.size}`,
    marks: [...(r.playing ? [{ text: "playing", cls: "now" }] : []), ...(r.viaRemux ? [{ text: "via remux", cls: "sug" }] : []), ...(r.unavailable ? [{ text: "unavailable", cls: "sug" }] : [])],
    current: r.playing,
    focused: z === "copies" && i === zs.row,
    dim: !r.switchable,
  }))

  return (
    <div class={`screen pl${showLyrics ? " lyrics" : ""}${listOpen ? " listopen" : ""}`}>
      <div class="pl-vid">
        <video key={gen} ref={vid} muted={muted()} playsInline preload="auto" />
        {phase !== "ready" && phase !== "loading" && (
          <div class="plmsg">{!video ? "This Video is not in the library." : phase === "remux" ? REMUX_MESSAGE : phase === "failed" && failedCopy ? failedMessage(failedCopy) : "Copy unavailable"}</div>
        )}
        {needsEnter && <div class="plmsg over">Press Enter to play</div>}
        {badge && <div class="pl-badge">{badge}</div>}
        {flash && (
          <div class="pl-flash" key={flash.n}>
            {flash.text}
          </div>
        )}

        <div class={`pl-top${topOn ? " on" : ""}${z === "tags" || z === "lyrics" ? " pin" : ""}`}>
          <div class="t1">{video?.title ?? ""}</div>
          <div class="tagrow">
            {tags.map((tg, i) => (
              <span
                key={tg.label}
                class={`tag${tg.kind === "type" ? ` type-${tg.type}` : ""}${tg.kind !== "type" && tg.suggested ? " sug" : ""}${z === "tags" && zs.tag === i ? " f" : ""}`}
                style={tg.kind === "artist" ? { "--c": `var(--t${artistSlot(tg.name)})` } : tg.kind === "song" ? { "--c": "var(--accent)" } : undefined}
              >
                {tg.label}
              </span>
            ))}
            {tagLine.map((x) => (
              <span key={x} class="info">
                {x}
              </span>
            ))}
          </div>
          <div class="from">{playingFromText(playingFrom, videoId, pl)}</div>
          {z === "lyrics" && (
            <div class="lyrband">
              <b>{showLyrics ? "◂ Lyrics" : "Lyrics ▸"}</b>
              <span>{showLyrics ? "◂ hides them" : (reason ?? "▸ shows them")}</span>
            </div>
          )}
          {z === "tags" && (
            <div class="lyrband">
              <span>◂ ▸ choose a tag · Enter opens its Videos</span>
            </div>
          )}
        </div>

        <div class={`pl-bar${osdOn ? " on" : ""}${pinsBottom(z) ? " pin" : ""}`}>
          <div class="row">
            <span class="chap">{chapterLine(chapters, t, duration)}</span>
            <span class="sp" />
            {next && <span class="nextup">{next}</span>}
          </div>
          <div class="tm">
            <span class="mono">{fmtClock(t)}</span>
            <div class="bar">
              {chapters.map((c) => (
                <i key={c.id} class="tick" style={{ left: `${pct(c.startS, duration)}%` }} />
              ))}
              {resumeMark != null && <i class="rmark" style={{ left: `${pct(resumeMark, duration)}%` }} title="Resume" />}
              <i class="fill" style={{ width: `${pct(t, duration)}%` }} />
            </div>
            <span class="mono">{fmtClock(duration)}</span>
          </div>
          <div class="btns">
            {BUTTONS.map((b, i) => {
              const face = b === "shuffle" ? faces.shuffle : b === "repeat" ? faces.repeat : { text: "Copy", on: false, disabled: false }
              return (
                <span key={b} class={`pbtn${z === "buttons" && zs.button === i ? " f" : ""}${face.on ? " lit" : ""}${face.disabled ? " off" : ""}`}>
                  {b === "copy" ? `Copy${copy ? ` · ${[copy.container, copy.height ? `${copy.height}p` : ""].filter(Boolean).join(" ")}` : ""}` : face.text}
                </span>
              )
            })}
          </div>
        </div>

        {z === "chapters" && <PlList title="Chapters" rows={chapterRows} focus={zs.row} hint="▲▼ choose · Enter jumps · ◀ or Back closes" />}
        {z === "copies" && <PlList title="Copies" rows={copyListRows} focus={zs.row} hint="▲▼ choose · Enter switches for this play · ◀ or Back closes" />}
      </div>
      {showLyrics && lview && <LyricsColumn view={lview} poster={poster} ctl={lyricsCtl} />}
    </div>
  )
}

/** The title of the Playlist's next Entry (what "Next:" names in the last 20 s), skipping unavailable Videos. */
function nextEntryTitle(pl: Playlist, nav: Nav, playable: (id: string) => boolean): string | null {
  const m = nextEntry(pl, "end", playable)
  if (m.kind !== "move" && m.kind !== "restart") return null
  if (m.kind === "move" && m.pl.cursor <= pl.cursor) return null // Repeat list wrapping reshuffles only when it happens: nothing to name yet
  const e = current(m.pl)
  return e ? (nav.data.videos.find((v) => v.id === e.videoId)?.title ?? null) : null
}
