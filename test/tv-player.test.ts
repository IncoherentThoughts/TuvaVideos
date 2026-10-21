// The TV Player (docs/tv-spec.md 6, 3.3, 2.5): seek acceleration, the zone reducer over the key table, the Playlist through
// src/shared/playlist.ts, the Copy list marking, the Resume cadence, the lyrics column sizing, the backdrop hues, the OSD
// texts and the Web Audio fallbacks. All pure.
import { describe, expect, test } from "bun:test"
import { DEFAULT_AUDIO, type AudioState } from "../src/shared/audio"
import { keyframeSeekTarget } from "../src/shared/playerMath"
import { current, startPlaylist, type Entry, type Playlist } from "../src/shared/playlist"
import { entryRange, nextEntry, prevEntry, reachedEnd, seekWidens } from "../src/shared/playlistPlayer"
import { ResumeClock, storedResume } from "../src/shared/resume"
import type { CopyDto, SongDto, VideoDto } from "../src/shared/types"
import { AudioChain, audioTag, type ChainDeps } from "../src/tv/audioChain"
import { pickPlayable, failedMessage } from "../src/tv/copies"
import { copyRows, fmtSize } from "../src/tv/copyList"
import { SAMPLE_N, blobColors, hueGap, hueMoved, liftedColor, matchSlots, sampleHues, stripHues, tileCells, windowTiles } from "../src/tv/hues"
import { actionFor, type TvAction } from "../src/tv/keys"
import { LYR_W_MAX, LYR_W_MIN, clampPage, fitLyrics, lyricsView, nextScript, noLyricsReason, pageLabel, paginate, stripMarkers } from "../src/tv/lyrics"
import { chapterLine, listOffset, nextUp, osdVisible, pct } from "../src/tv/osd"
import { buttonFaces, entryStart, pressRepeat, pressShuffle, resolveOpen } from "../src/tv/playlistOps"
import { RAMP_S, REW_FF_S, nextSeekStep, stepLabel } from "../src/tv/seekStep"
import { focusableTags, infoTexts, playingFromText, tagGrid } from "../src/tv/tags"
import { BUTTONS, initialZone, reduceZone, type ZoneCtx, type ZoneState } from "../src/tv/zones"

// ---- fixtures ----

const copy = (o: Partial<CopyDto> = {}): CopyDto =>
  ({ id: 1, rootKind: "local", size: 1.5e9, container: "mkv", videoCodec: "h264", audioCodec: "aac", width: 1920, height: 1080, available: true, missing: false, tv: { decision: null, order: "file" }, url: "/copy/1", ...o }) as CopyDto

// ---- seek acceleration ----

describe("seek acceleration (spec 6.3)", () => {
  test("10 s four times, then four presses each of 30 and 60, then 120 and it stays", () => {
    let ramp = null as ReturnType<typeof nextSeekStep>["ramp"] | null
    const steps: number[] = []
    let t = 1000
    for (let i = 0; i < 15; i++) {
      const x = nextSeekStep(ramp, 1, t)
      steps.push(x.step)
      ramp = x.ramp
      t += 400
    }
    expect(steps).toEqual([10, 10, 10, 10, 30, 30, 30, 30, 60, 60, 60, 60, 120, 120, 120])
    expect([...RAMP_S]).toEqual([10, 30, 60, 120])
  })

  test("a pause of more than a second starts over; exactly a second still climbs", () => {
    let x = nextSeekStep(null, 1, 0)
    for (let t = 1000; t <= 4000; t += 1000) x = nextSeekStep(x.ramp, 1, t)
    expect(x.step).toBe(30)
    const c = nextSeekStep(x.ramp, 1, 5001)
    expect(c.step).toBe(10)
  })

  test("the other direction starts over, and the label has the sign", () => {
    const a = nextSeekStep(null, 1, 0)
    expect(nextSeekStep(a.ramp, -1, 200).step).toBe(10)
    expect(stepLabel(1, 30)).toBe("+30 s")
    expect(stepLabel(-1, 10)).toBe("−10 s")
    expect(REW_FF_S).toBe(60)
  })

  test("a plain arrow lands 0.15 s past the nearest keyframe; without an index the exact target", () => {
    const kf = [0, 4, 8, 12]
    expect(keyframeSeekTarget(7.5, kf, 3)).toBeCloseTo(8.15, 5)
    expect(keyframeSeekTarget(7.5, [], 3)).toBe(7.5)
  })
})

// ---- zones ----

const ctx = (o: Partial<ZoneCtx> = {}): ZoneCtx => ({ hasLyrics: true, lyricsShown: false, versionCount: 1, tagCount: 3, chapterCount: 4, currentChapter: 2, copySwitchable: [true, false, true], currentCopy: 0, ...o })
const press = (s: ZoneState, k: TvAction, c: ZoneCtx = ctx()) => reduceZone(s, k, c)
const at = (zone: ZoneState["zone"], o: Partial<ZoneState> = {}): ZoneState => ({ ...initialZone(), zone, ...o })

describe("zones (spec 6.3 to 6.5)", () => {
  test("the base zone: arrows seek, Enter pauses, Back leaves", () => {
    const s = initialZone()
    expect(press(s, "left").fx).toEqual([{ t: "seek", dir: -1, kind: "ramp" }])
    expect(press(s, "right").fx).toEqual([{ t: "seek", dir: 1, kind: "ramp" }])
    expect(press(s, "enter").fx).toEqual([{ t: "toggle" }])
    expect(press(s, "rewind").fx).toEqual([{ t: "seek", dir: -1, kind: "flat" }])
    expect(press(s, "forward").fx).toEqual([{ t: "seek", dir: 1, kind: "flat" }])
    expect(press(s, "back").fx).toEqual([{ t: "leave" }])
  })

  test("Up reaches the lyrics zone, Up again the tag row; Down and Back walk back", () => {
    const a = press(initialZone(), "up")
    expect(a.state.zone).toBe("lyrics")
    const b = press(a.state, "up")
    expect(b.state.zone).toBe("tags")
    expect(press(b.state, "down").state.zone).toBe("lyrics")
    expect(press(b.state, "back").state.zone).toBe("video")
    expect(press(a.state, "down").state.zone).toBe("video")
    expect(press(a.state, "back").state.zone).toBe("video")
  })

  test("in the lyrics zone Right pulls the lyrics in and Left hides them; with no lyrics the arrows do nothing", () => {
    const z = at("lyrics")
    expect(press(z, "right").fx).toEqual([{ t: "lyrics", on: true }])
    expect(press(z, "left").fx).toEqual([{ t: "lyrics", on: false }])
    expect(press(z, "right", ctx({ hasLyrics: false })).fx).toEqual([])
    expect(press(z, "left", ctx({ hasLyrics: false })).fx).toEqual([])
  })

  test("the tag row: Left/Right walk and stop at the ends, Enter opens the tag", () => {
    let s = at("tags")
    expect(press(s, "left").state.tag).toBe(0)
    s = press(s, "right").state
    s = press(s, "right").state
    s = press(s, "right").state
    expect(s.tag).toBe(2) // three tags: clamped
    expect(press(s, "enter").fx).toEqual([{ t: "tag", index: 2 }])
    expect(press(s, "up").fx).toEqual([])
  })

  test("Down opens the button row; Left/Right move, Enter acts, Up and Back return", () => {
    const b = press(initialZone(), "down").state
    expect(b.zone).toBe("buttons")
    expect([...BUTTONS]).toEqual(["shuffle", "repeat", "copy"])
    expect(press(b, "enter").fx).toEqual([{ t: "button", id: "shuffle" }])
    const r = press(b, "right").state
    expect(press(r, "enter").fx).toEqual([{ t: "button", id: "repeat" }])
    const c = press(r, "right").state
    expect(c.button).toBe(2)
    expect(press(c, "right").state.button).toBe(2)
    expect(press(b, "left").state.button).toBe(0)
    expect(press(b, "up").state.zone).toBe("video")
    expect(press(b, "back").state.zone).toBe("video")
  })

  test("Down again opens the Chapter list on the current Chapter; with none it says so", () => {
    const b = at("buttons")
    const open = press(b, "down")
    expect(open.state).toMatchObject({ zone: "chapters", row: 2 })
    const none = press(b, "down", ctx({ chapterCount: 0 }))
    expect(none.state.zone).toBe("buttons")
    expect(none.fx).toEqual([{ t: "say", text: "No chapters" }])
    expect(press(at("buttons"), "down", ctx({ currentChapter: -1 })).state.row).toBe(0)
  })

  test("the Chapter list: Up/Down move, Enter jumps exactly and closes, Left/Back return to the button row", () => {
    const l = at("chapters", { row: 1 })
    expect(press(l, "down").state.row).toBe(2)
    expect(press(l, "up").state.row).toBe(0)
    expect(press(at("chapters", { row: 0 }), "up").state.row).toBe(0)
    expect(press(at("chapters", { row: 3 }), "down").state.row).toBe(3)
    const e = press(l, "enter")
    expect(e.fx).toEqual([{ t: "chapter", index: 1 }])
    expect(e.state.zone).toBe("video")
    expect(press(l, "left").state.zone).toBe("buttons")
    expect(press(l, "back").state.zone).toBe("buttons")
  })

  test("the Copy list opens from the Copy button on the playing row; Enter switches, a via-remux row is blocked, Back returns to the Copy button", () => {
    const b = at("buttons", { button: 2 })
    const open = press(b, "enter", ctx({ currentCopy: 2 }))
    expect(open.state).toMatchObject({ zone: "copies", row: 2 })
    const l = at("copies", { row: 0 })
    expect(press(l, "down").state.row).toBe(1)
    const blocked = press(at("copies", { row: 1 }), "enter")
    expect(blocked.fx).toEqual([{ t: "copyBlocked", index: 1 }])
    expect(blocked.state.zone).toBe("copies")
    const sw = press(at("copies", { row: 2 }), "enter")
    expect(sw.fx).toEqual([{ t: "copy", index: 2 }])
    expect(sw.state.zone).toBe("video")
    expect(press(l, "enter").fx).toEqual([]) // the playing one: nothing to switch
    expect(press(l, "back").state).toMatchObject({ zone: "buttons", button: 2 })
  })

  test("the colour keys, Channel, track keys and play/pause mean the same in every zone", () => {
    for (const zone of ["video", "lyrics", "tags", "buttons", "chapters", "copies"] as const) {
      const s = at(zone)
      expect(press(s, "yellow").fx).toEqual([{ t: "lyrics", on: "toggle" }])
      expect(press(s, "blue").fx).toEqual([{ t: "script" }])
      expect(press(s, "pageUp").fx).toEqual([{ t: "page", dir: -1 }])
      expect(press(s, "pageDown").fx).toEqual([{ t: "page", dir: 1 }])
      expect(press(s, "prev").fx).toEqual([{ t: "step", dir: -1 }])
      expect(press(s, "next").fx).toEqual([{ t: "step", dir: 1 }])
      expect(press(s, "playpause").fx).toEqual([{ t: "toggle" }])
    }
  })

  test("Green opens the Chapter list from anywhere (same as Down, Down) and closes it", () => {
    expect(press(initialZone(), "green").state).toMatchObject({ zone: "chapters", row: 2 })
    expect(press(at("tags"), "green").state.zone).toBe("chapters")
    expect(press(at("chapters"), "green").state.zone).toBe("video")
    expect(press(initialZone(), "green", ctx({ chapterCount: 0 })).fx).toEqual([{ t: "say", text: "No chapters" }])
  })

  test("Rewind/FastForward are the base zone's; the lists ignore them", () => {
    expect(press(at("chapters"), "rewind").fx).toEqual([])
    expect(press(at("buttons"), "forward").fx).toEqual([{ t: "seek", dir: 1, kind: "flat" }])
  })

  test("Back closes an open zone first and leaves the Player second", () => {
    let s = initialZone()
    s = press(s, "down").state // buttons
    s = press(s, "down").state // chapters
    const closed: string[] = [s.zone]
    for (let i = 0; i < 3; i++) {
      const r = press(s, "back")
      s = r.state
      closed.push(r.fx.some((f) => f.t === "leave") ? "leave" : s.zone)
    }
    expect(closed).toEqual(["chapters", "buttons", "video", "leave"])
  })

  test("Info and Exit are the app's, not the Player's; Red steps the Version", () => {
    expect(press(initialZone(), "info").handled).toBe(false)
    expect(press(initialZone(), "exit").handled).toBe(false)
    expect(press(initialZone(), "red").fx).toEqual([{ t: "version" }])
  })

  test("the lyrics zone: Right pulls the column in, then steps the Version when there are several", () => {
    expect(press(at("lyrics"), "right").fx).toEqual([{ t: "lyrics", on: true }])
    expect(press(at("lyrics"), "right", ctx({ lyricsShown: true, versionCount: 1 })).fx).toEqual([{ t: "lyrics", on: true }])
    expect(press(at("lyrics"), "right", ctx({ lyricsShown: true, versionCount: 3 })).fx).toEqual([{ t: "version" }])
    expect(press(at("lyrics"), "left", ctx({ lyricsShown: true, versionCount: 3 })).fx).toEqual([{ t: "lyrics", on: false }])
  })

  test("the remote's codes reach the reducer through the key table", () => {
    const k = (keyCode: number, key = "") => actionFor({ keyCode, key })!.action
    expect(k(405)).toBe("yellow")
    expect(k(406)).toBe("blue")
    expect(k(404)).toBe("green")
    expect(k(427)).toBe("pageUp")
    expect(k(10233)).toBe("next")
    expect(k(412)).toBe("rewind")
  })
})

// ---- Playlist ----

const entries = (...ids: number[]) => ids.map((n) => ({ videoId: String(n) }))
const seq = (es: Entry[] = entries(1, 2, 3), o: Partial<Playlist> = {}): Playlist => ({ ...startPlaylist(es, { source: "library", shuffled: false, startAt: 0 }), ...o })

describe("Playlist on the TV (spec 6.7)", () => {
  test("end-of-Entry advances; the last one with Repeat off ends, paused on the last frame", () => {
    let pl = seq()
    const a = nextEntry(pl, "end")
    expect(a.kind).toBe("move")
    pl = a.pl
    expect(current(pl)?.videoId).toBe("2")
    pl = nextEntry(pl, "end").pl
    const last = nextEntry(pl, "end")
    expect(last.kind).toBe("ended")
    expect(current(last.pl)?.videoId).toBe("3")
    expect(nextEntry(seq(), "key").kind).toBe("move")
    expect(nextEntry(last.pl, "key").kind).toBe("none") // `>` at the end does nothing
  })

  test("Repeat one restarts the Entry at its end but `>` still moves on; Repeat list wraps", () => {
    const one = seq(undefined, { repeat: "one" })
    expect(nextEntry(one, "end").kind).toBe("restart")
    expect(nextEntry(one, "key").kind).toBe("move")
    const list = { ...seq(undefined, { repeat: "list" }), cursor: 2 }
    const w = nextEntry(list, "end")
    expect(w.kind).toBe("move")
    expect(current(w.pl)?.videoId).toBe("1")
  })

  test("unavailable Entries are skipped", () => {
    const pl = seq()
    const m = nextEntry(pl, "end", (id) => id !== "2")
    expect(current(m.pl)?.videoId).toBe("3")
    expect(prevEntry(m.pl, (id) => id !== "2")?.cursor).toBe(0)
  })

  test("a Chapter Entry plays to the next Chapter's start; seeking past it widens", () => {
    const chapters = [{ id: "10", startS: 0 }, { id: "11", startS: 100 }, { id: "12", startS: 250 }]
    const rg = entryRange({ videoId: "5", chapterId: "11" }, chapters, 400)
    expect(rg).toEqual({ start: 100, end: 250 })
    expect(reachedEnd(rg, 249.9)).toBe(false)
    expect(reachedEnd(rg, 250)).toBe(true)
    expect(seekWidens(rg, 300)).toBe(true)
    expect(entryRange({ videoId: "5", chapterId: "12" }, chapters, 400)).toEqual({ start: 250, end: 400 })
    expect(entryRange({ videoId: "5" }, chapters, 400)).toEqual({ start: 0, end: null })
  })

  test("entryStart: a Chapter Entry opens at its Chapter, a deleted Chapter as the Video", () => {
    const pl = seq([{ videoId: "5", chapterId: "11" }, { videoId: "6" }])
    expect(entryStart(pl, [{ id: "11", startS: 100 }])).toMatchObject({ startS: 100 })
    const gone = entryStart(pl, [{ id: "99", startS: 1 }])
    expect(gone.startS).toBeNull()
    expect(current(gone.pl)).toEqual({ videoId: "5" })
    expect(entryStart(seq(), null).startS).toBeNull()
  })

  test("opened from elsewhere: a Video inside the Playlist jumps to its Entry, one outside ends it", () => {
    const pl = seq()
    expect(resolveOpen(pl, "1")).toBe(pl)
    expect(current(resolveOpen(pl, "3")!)?.videoId).toBe("3")
    expect(resolveOpen(pl, "99")).toBeNull()
    expect(resolveOpen(null, "1")).toBeNull()
  })

  test("Shuffle with none active starts a whole-library Playlist from the current Video; with one it toggles the Play order", () => {
    const started = pressShuffle(null, ["4", "5", "6", "7"], "6", () => 0.5)
    expect(started.started).toBe(true)
    expect(started.pl?.source).toBe("library-all")
    expect(current(started.pl!)?.videoId).toBe("6")
    expect(started.pl?.shuffled).toBe(true)
    expect(started.pl?.repeat).toBe("off")
    expect(started.label).toContain("4")
    const toggled = pressShuffle(started.pl, ["4", "5", "6", "7"], "6")
    expect(toggled.started).toBe(false)
    expect(toggled.pl?.shuffled).toBe(false)
    expect(toggled.label).toBe("Shuffle off")
    expect(pressShuffle(null, ["1", "2"], "99").pl).toBeNull()
  })

  test("Repeat cycles off, list, one; with only Playing from it says the Video loops and shows 'one' disabled", () => {
    let pl: Playlist | null = seq()
    const modes: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = pressRepeat(pl)
      pl = r.pl
      modes.push(pl!.repeat)
    }
    expect(modes).toEqual(["list", "one", "off"])
    expect(pressRepeat(null).pl).toBeNull()
    expect(pressRepeat(null).label).toContain("this Video loops")
    expect(buttonFaces(null).repeat).toEqual({ text: "Repeat: one", on: false, disabled: true })
    expect(buttonFaces(seq()).repeat).toEqual({ text: "Repeat: off", on: false, disabled: false })
    expect(buttonFaces(seq(undefined, { shuffled: true })).shuffle.on).toBe(true)
  })
})

// ---- Copy list ----

describe("Copy list (spec 6.5)", () => {
  const copies = [copy({ id: 1 }), copy({ id: 2, rootKind: "external", container: "webm", tv: { decision: null, order: "live" } }), copy({ id: 3, available: false, container: "mp4", height: 720, size: 4e8 })]

  test("one row per Copy, the playing one marked, via remux greyed and not switchable", () => {
    const rows = copyRows(copies, 1)
    expect(rows.map((r) => r.playing)).toEqual([true, false, false])
    expect(rows[1]).toMatchObject({ viaRemux: true, switchable: false, root: "external" })
    expect(rows[0]).toMatchObject({ viaRemux: false, switchable: true, label: "mkv · h264 aac · 1080p", size: "1.5 GB" })
    expect(rows[2]).toMatchObject({ unavailable: true, switchable: false, size: "400 MB" })
    expect(fmtSize(0)).toBe("1 MB")
  })

  test("the Fallback order counts as playing: `file` and `fallback` rows are switchable", () => {
    const rows = copyRows([copy({ id: 5, tv: { decision: null, order: "fallback" } })], null)
    expect(rows[0]).toMatchObject({ viaRemux: false, switchable: true, playing: false })
  })

  test("the Copy to start with: a playable one beats a local one that needs the remux; only-remux says so", () => {
    const local = copy({ id: 1, tv: { decision: null, order: "live" } })
    const ext = copy({ id: 2, rootKind: "external" })
    expect(pickPlayable([local, ext])).toMatchObject({ copy: { id: 2 }, live: false })
    expect(pickPlayable([local])).toMatchObject({ copy: { id: 1 }, live: true })
    expect(pickPlayable([local, ext], new Set([2]))).toMatchObject({ live: true })
    expect(pickPlayable([copy({ available: false })])).toBeNull()
    expect(failedMessage(copy())).toBe("This Copy did not play (mkv h264/aac)")
  })
})

// ---- Resume ----

describe("Resume cadence (spec 2.5)", () => {
  test("every 5 s while playing, never while paused, an event write restarts the clock", () => {
    const c = new ResumeClock(5000)
    expect(c.tick(0, true)).toBe(false) // starts the clock
    expect(c.tick(4900, true)).toBe(false)
    expect(c.tick(5000, true)).toBe(true)
    expect(c.tick(9000, true)).toBe(false)
    c.wrote(9500) // a pause or seek wrote
    expect(c.tick(14400, true)).toBe(false)
    expect(c.tick(14500, true)).toBe(true)
    expect(c.tick(30000, false)).toBe(false)
    c.stopped()
    expect(c.tick(40000, true)).toBe(false) // a fresh interval after a pause
  })

  test("what is stored: the position to 2 places, 0 inside the last 30 s", () => {
    expect(storedResume(123.456, 3600)).toBe(123.46)
    expect(storedResume(3580, 3600)).toBe(0)
    expect(storedResume(3569, 3600)).toBe(3569)
    expect(storedResume(-4, 100)).toBe(0)
    expect(storedResume(50, null)).toBe(50)
  })
})

// ---- lyrics column ----

describe("lyrics column (spec 6.1)", () => {
  test("a short longest line: 44 px and the minimum width", () => {
    expect(fitLyrics(300)).toEqual({ fontPx: 44, widthPx: LYR_W_MIN })
    expect(fitLyrics(0)).toEqual({ fontPx: 44, widthPx: LYR_W_MIN })
  })

  test("up to 900 px the type stays 44 and the column grows with the line", () => {
    const f = fitLyrics(700) // 700 + 128 padding = 828 <= 900
    expect(f.fontPx).toBe(44)
    expect(f.widthPx).toBe(700 + 128 + 8)
  })

  test("past 900 px the type shrinks first, down to 34, and the column stays near 900", () => {
    const f = fitLyrics(900)
    expect(f.fontPx).toBeLessThan(44)
    expect(f.fontPx).toBeGreaterThanOrEqual(34)
    expect(f.widthPx).toBeLessThanOrEqual(900 + 8)
  })

  test("only when 34 px is not enough does the column widen, up to 1060, then lines wrap", () => {
    const f = fitLyrics(1100) // at 34 px: 850 + 128 > 900
    expect(f.fontPx).toBe(34)
    expect(f.widthPx).toBeGreaterThan(900)
    expect(f.widthPx).toBeLessThanOrEqual(LYR_W_MAX)
    const huge = fitLyrics(5000)
    expect(huge).toEqual({ fontPx: 34, widthPx: LYR_W_MAX })
  })

  test("the base size is one CSS variable: a bigger base scales the shrink and the floor follows", () => {
    expect(fitLyrics(300, 52).fontPx).toBe(52)
    expect(fitLyrics(1100, 52, 40).fontPx).toBeGreaterThanOrEqual(40)
  })

  test("pages hold whole lines; a spacer never starts a page", () => {
    const items = [
      { top: 0, height: 60, blank: false },
      { top: 60, height: 60, blank: false },
      { top: 120, height: 36, blank: true },
      { top: 156, height: 60, blank: false },
      { top: 216, height: 60, blank: false },
      { top: 276, height: 60, blank: false },
    ]
    expect(paginate(items, 220)).toEqual([0, 216]) // first page ends before the line at 216 would pass 220
    expect(paginate(items, 1000)).toEqual([0])
    expect(paginate([], 500)).toEqual([0])
    expect(paginate([{ top: 0, height: 900, blank: false }], 500)).toEqual([0])
    expect(clampPage(5, 2)).toBe(1)
    expect(clampPage(-1, 2)).toBe(0)
    expect(pageLabel(0, 3)).toBe("page 1 of 3")
    expect(pageLabel(0, 1)).toBe("")
  })

  const song = (versions: SongDto["versions"], o: Partial<SongDto> = {}): SongDto =>
    ({ id: "s", name: "Aldyn-ool", englishName: "Golden", hidden: false, local: false, alternateTitles: [], alternateSpellings: [], names: [], versions, videos: [], ...o }) as SongDto
  const ver = (id: string, cyr: string, lat = "", en = "") => ({ id, label: id, displayOrder: 0, local: false, scripts: { cyrillic: { html: cyr, footnotes: [] }, transliteration: { html: lat, footnotes: [] }, translation: { html: en, footnotes: [] } } })

  test("one Script, no numbers, footnote markers stripped, a blank run is one spacer", () => {
    const v = lyricsView(song([ver("a", '<p>Line one<sup data-fn="1">1</sup></p><p class="ln-blank"><br></p><p>Line two</p>', "<p>Latin</p>")]), null, "cyrillic")
    expect(v.script).toBe("cyrillic")
    expect(v.lines).toEqual([{ blank: false, html: "Line one" }, { blank: true, html: "" }, { blank: false, html: "Line two" }])
    expect(v.present).toEqual(["cyrillic", "transliteration"])
    expect(stripMarkers('x<sup data-fn="2">2</sup>y')).toBe("xy")
  })

  test("the Script preference clamps to one the Version has; Blue cycles the present ones", () => {
    const v = lyricsView(song([ver("a", "<p>c</p>", "<p>l</p>", "<p>e</p>")]), null, "translation")
    expect(v.script).toBe("translation")
    expect(v.lang).toBe("en")
    expect(lyricsView(song([ver("a", "<p>c</p>")]), null, "translation").script).toBe("cyrillic")
    expect(nextScript(["cyrillic", "translation"], "cyrillic")).toBe("translation")
    expect(nextScript(["cyrillic", "translation"], "translation")).toBe("cyrillic")
    expect(nextScript([], null)).toBeNull()
  })

  test("the Version opens on the Chapter's, else the first; the Versions are listed for the pills", () => {
    const s = song([ver("a", "<p>A</p>"), ver("b", "<p>B</p>")])
    expect(lyricsView(s, "b", "cyrillic")).toMatchObject({ versionIdx: 1, lines: [{ html: "B" }] })
    expect(lyricsView(s, "gone", "cyrillic").versionIdx).toBe(0)
    expect(lyricsView(s, null, "cyrillic").versions.map((x) => x.label)).toEqual(["a", "b"])
  })

  test("why there are no lyrics", () => {
    const target = { songId: "s", versionId: null, fromChapter: false }
    expect(noLyricsReason(null, undefined)).toBe("This Video has no Song")
    expect(noLyricsReason(target, undefined)).toBeNull() // loading
    expect(noLyricsReason(target, null)).toBe("The Song did not load")
    expect(noLyricsReason(target, song([]))).toBe("Aldyn-ool has no lyrics")
    expect(noLyricsReason(target, song([ver("a", "", "", "")]))).toBe("Aldyn-ool has no lyrics")
    expect(noLyricsReason(target, song([ver("a", "<p>x</p>")]))).toBeNull()
  })
})

// ---- backdrop hues ----

/** RGBA for a list of [r,g,b]. */
const px = (...cells: [number, number, number][]) => Uint8ClampedArray.from(cells.flatMap(([r, g, b]) => [r, g, b, 255]))

describe("backdrop hues (spec 6.2)", () => {
  test("the most vivid cells are picked (red among them); the picked hues are 25 degrees apart or more", () => {
    const hues = sampleHues(px([220, 30, 30], [225, 35, 35], [30, 200, 40], [40, 60, 210], [220, 200, 20], [230, 25, 25]))
    expect(hues).toHaveLength(4)
    expect(hues.some((h) => h.h < 10 || h.h > 350)).toBe(true)
    for (let i = 0; i < hues.length; i++) for (let j = i + 1; j < hues.length; j++) expect(hueGap(hues[i]!.h, hues[j]!.h)).toBeGreaterThanOrEqual(25)
  })

  test("near-duplicate hues count once", () => {
    const hues = sampleHues(px([220, 30, 30], [220, 40, 30], [221, 35, 32]))
    expect(hues.filter((h) => hueGap(h.h, hues[0]!.h) < 25)).toHaveLength(1)
  })

  test("a grey poster falls back to warm hues spread round the wheel", () => {
    const grey = sampleHues(px([128, 128, 128], [20, 20, 20], [240, 240, 240], [100, 102, 100]))
    expect(grey.map((h) => h.h)).toEqual([25, 60, 95, 130])
    expect(sampleHues(new Uint8ClampedArray(0)).map((h) => h.h)).toEqual([25, 60, 95, 130])
  })

  test("fewer than four colours: the rest are warm hues spread from the first", () => {
    const hues = sampleHues(px([30, 60, 220]))
    expect(hues).toHaveLength(4)
    expect(hueGap(hues[1]!.h, (hues[0]!.h + 35) % 360)).toBeLessThan(0.001)
  })

  test("lifted to lightness 56 for the first, 48 for the rest, saturation at least 65 %", () => {
    expect(liftedColor({ h: 200, s: 0.3, l: 0.2 }, 0)).toBe("hsl(200 65% 56%)")
    expect(liftedColor({ h: 10.4, s: 0.9, l: 0.9 }, 2)).toBe("hsl(10 90% 48%)")
    const cols = blobColors(px([220, 30, 30], [30, 200, 40], [40, 60, 210], [220, 200, 20]))
    expect(cols).toHaveLength(4)
    expect(cols[0]).toMatch(/ 56%\)$/)
    expect(cols.slice(1).every((c) => / 48%\)$/.test(c))).toBe(true)
    expect(SAMPLE_N).toBe(12)
  })

  test("transparent cells are ignored", () => {
    const p = Uint8ClampedArray.from([200, 20, 20, 0])
    expect(sampleHues(p)[0]!.h).toBe(25)
  })
})

describe("backdrop following the playhead (spec 6.2)", () => {
  test("the window is ±30 s of slice centres, or one slice when slices are longer", () => {
    expect(windowTiles(120, 240, 100)).toEqual(Array.from({ length: 26 }, (_, i) => 37 + i)) // 2.4 s slices, centres 90 s to 150 s
    expect(windowTiles(3600, 7200, 100)).toEqual([49, 50]) // 72 s slices
    expect(windowTiles(0, 7200, 100)).toEqual([0])
    expect(windowTiles(7200, 7200, 100)).toEqual([99])
  })

  test("a tile's cells come out of the downscaled strip", () => {
    const cols = 3
    const strip = new Uint8ClampedArray(cols * SAMPLE_N * 2 * SAMPLE_N * 4)
    for (let y = SAMPLE_N; y < 2 * SAMPLE_N; y++)
      for (let x = SAMPLE_N; x < 2 * SAMPLE_N; x++) strip.set([10, 200, 30, 255], (y * cols * SAMPLE_N + x) * 4) // tile 4
    const cells = tileCells(strip, cols, 4)
    expect(cells.length).toBe(SAMPLE_N * SAMPLE_N * 4)
    expect([...cells.slice(0, 4)]).toEqual([10, 200, 30, 255])
    expect(tileCells(strip, cols, 3).every((v) => v === 0)).toBe(true)
    expect(hueGap(stripHues(strip, cols, [3, 4])[0]!.h, 127)).toBeLessThan(2)
  })

  test("slots keep the nearest hue, so blobs drift instead of swapping", () => {
    const h = (...hs: number[]) => hs.map((x) => ({ h: x, s: 0.8, l: 0.5 }))
    expect(matchSlots(h(0, 90, 180, 270), h(185, 275, 5, 95)).map((x) => x.h)).toEqual([5, 95, 185, 275])
  })

  test("a slot moves only past a hue or saturation step", () => {
    const a = { h: 100, s: 0.8, l: 0.5 }
    expect(hueMoved(a, { ...a, h: 108 })).toBe(false)
    expect(hueMoved(a, { ...a, h: 115 })).toBe(true)
    expect(hueMoved({ ...a, s: 0.2 }, { ...a, s: 0.5 })).toBe(false) // both lift to 65 %
    expect(hueMoved(a, { ...a, s: 0.6 })).toBe(true)
  })
})

// ---- OSD ----

describe("OSD (spec 6.6)", () => {
  const chapters = [{ id: "1", startS: 0, title: "Intro" }, { id: "2", startS: 100, title: "Song two" }, { id: "3", startS: 300, title: "" }]

  test("the Chapter line has the title and its span", () => {
    expect(chapterLine(chapters, 150, 500)).toBe("Song two · 1:40–5:00")
    expect(chapterLine(chapters, 350, 500)).toBe("untitled · 5:00–8:20")
    expect(chapterLine([], 10, 100)).toBe("")
    expect(chapterLine(chapters.slice(1), 10, 500)).toBe("") // before the first Chapter
  })

  test("Next: names the next Chapter in the last 20 s of a Chapter", () => {
    expect(nextUp({ t: 70, durationS: 500, chapters })).toBeNull()
    expect(nextUp({ t: 85, durationS: 500, chapters })).toBe("Next: Song two")
    expect(nextUp({ t: 290, durationS: 500, chapters })).toBe("Next: untitled")
    expect(nextUp({ t: 490, durationS: 500, chapters })).toBeNull() // the last Chapter has no next
  })

  test("with a Playlist active Next: is the next Entry, in the last 20 s of the Entry", () => {
    const entry = { end: 300, nextTitle: () => "Another Video" }
    expect(nextUp({ t: 250, durationS: 500, chapters, entry })).toBeNull()
    expect(nextUp({ t: 285, durationS: 500, chapters, entry })).toBe("Next: Another Video")
    expect(nextUp({ t: 285, durationS: 500, chapters, entry: { end: 300, nextTitle: () => null } })).toBeNull()
    expect(nextUp({ t: 485, durationS: 500, chapters, entry: { end: null, nextTitle: () => "X" } })).toBe("Next: X")
  })

  test("visible within 3 s of a key, always while paused or in a zone", () => {
    expect(osdVisible({ now: 2900, wokeAt: 0, paused: false, zonePinned: false })).toBe(true)
    expect(osdVisible({ now: 3000, wokeAt: 0, paused: false, zonePinned: false })).toBe(false)
    expect(osdVisible({ now: 9000, wokeAt: 0, paused: true, zonePinned: false })).toBe(true)
    expect(osdVisible({ now: 9000, wokeAt: 0, paused: false, zonePinned: true })).toBe(true)
  })

  test("scrub bar percentages and list scrolling", () => {
    expect(pct(50, 200)).toBe(25)
    expect(pct(5, null)).toBe(0)
    expect(pct(500, 200)).toBe(100)
    expect(listOffset(0, 64, 840, 10)).toBe(0)
    expect(listOffset(5, 64, 840, 10)).toBe(0) // the list fits
    expect(listOffset(30, 64, 840, 60)).toBeGreaterThan(0)
    expect(listOffset(59, 64, 840, 60)).toBe(60 * 64 - 840) // never past the end
  })
})

// ---- tags ----

describe("tag row (spec 6.4)", () => {
  const video = { type: "concert", artists: [{ id: "3", name: "Alash", nameLatin: null, local: false, proposed: false, suggested: false }, { id: "4", name: "Maybe", nameLatin: null, local: false, proposed: false, suggested: true }], song: { id: "uuid-1", name: "Aldyn-ool", englishName: null, hidden: false, local: false, versions: [] }, songSuggested: false } as unknown as VideoDto

  test("Type, confirmed Artists, then the Song; each opens its grid", () => {
    const tags = focusableTags(video)
    expect(tags.map((t) => t.label)).toEqual(["concert", "Alash", "♪ Aldyn-ool"])
    expect(tags.map(tagGrid)).toEqual([{ kind: "type", type: "concert" }, { kind: "artist", id: "3", name: "Alash" }, { kind: "song", id: "uuid-1", name: "Aldyn-ool" }])
  })

  test("a Video without Song or Artists has just its Type", () => {
    expect(focusableTags({ ...video, artists: [], song: null } as VideoDto)).toHaveLength(1)
  })

  test("the text after the tags: the Copy's facts and the audio state; Playing from with or without a Playlist", () => {
    expect(infoTexts(copy(), "audio: untouched")).toEqual(["mkv · h264 aac · 1080p · local", "audio: untouched"])
    expect(infoTexts(null, null)).toEqual([])
    const pf = { source: "favorites" as const, ids: ["7", "8", "9"] }
    expect(playingFromText(pf, "8", null)).toBe("Playing from Favorites · 2 of 3")
    expect(playingFromText(pf, "8", seq())).toBe("Playing from Playlist · Library · in order · 1 of 3")
  })
})

// ---- Web Audio chain ----

describe("Audio settings on the TV (spec 6.8)", () => {
  const tuned: AudioState = { ...DEFAULT_AUDIO, preamp: 6 }
  const el = {} as HTMLMediaElement
  const deps = (o: { probes: boolean[]; buildThrows?: boolean }): ChainDeps & { built: number; set: AudioState[]; disposed: number } => {
    const calls = { built: 0, set: [] as AudioState[], disposed: 0 }
    let n = 0
    return Object.assign(calls, {
      probe: async () => o.probes[Math.min(n++, o.probes.length - 1)]!,
      build: () => {
        if (o.buildThrows) throw new Error("no createMediaElementSource")
        calls.built++
        return { set: (s: AudioState) => void calls.set.push(s), dispose: () => void calls.disposed++ }
      },
    })
  }

  test("default or missing settings never pass through the chain and say nothing", async () => {
    const d = deps({ probes: [true] })
    const c = new AudioChain(d)
    expect((await c.start(el, null)).mode).toBe("none")
    expect((await c.start(el, DEFAULT_AUDIO)).mode).toBe("none")
    expect(d.built).toBe(0)
    expect(audioTag("none")).toBeNull()
  })

  test("a running context: the chain is built, the settings applied, the tag row says web audio", async () => {
    const d = deps({ probes: [true, true] })
    const modes: string[] = []
    const r = await new AudioChain(d).start(el, tuned, (m) => modes.push(m))
    expect(r).toMatchObject({ mode: "on", tainted: false })
    expect(d.set).toEqual([tuned])
    expect(modes).toEqual(["pending"])
    expect(audioTag("on")).toBe("audio: web audio")
  })

  test("a context that stays suspended: nothing is built (the element is not captured), untouched", async () => {
    const d = deps({ probes: [false] })
    const r = await new AudioChain(d).start(el, tuned)
    expect(r).toMatchObject({ mode: "untouched", tainted: false })
    expect(d.built).toBe(0)
    expect(audioTag("untouched")).toBe("audio: untouched")
  })

  test("createMediaElementSource throwing: untouched and the element is replaced to be safe", async () => {
    const r = await new AudioChain(deps({ probes: [true], buildThrows: true })).start(el, tuned)
    expect(r).toMatchObject({ mode: "untouched", tainted: true })
    expect(r.why).toContain("threw")
  })

  test("a context that stalls after the chain is built: the chain is torn down and the element replaced", async () => {
    const d = deps({ probes: [true, false] })
    const r = await new AudioChain(d).start(el, tuned)
    expect(r).toMatchObject({ mode: "untouched", tainted: true })
    expect(d.disposed).toBe(1)
  })

  test("warm() wakes the context ahead of play, once, and only for non-default settings", async () => {
    let probes = 0
    const c = new AudioChain({ probe: async () => (probes++, true), build: () => ({ set() {}, dispose() {} }) })
    c.warm(DEFAULT_AUDIO)
    c.warm(null)
    expect(probes).toBe(0)
    c.warm(tuned)
    c.warm(tuned)
    expect(probes).toBe(1)
    await c.start(el, tuned)
    expect(probes).toBe(2) // the post-build check
  })
})
