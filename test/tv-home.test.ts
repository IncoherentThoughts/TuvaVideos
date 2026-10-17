// The TV home (docs/tv-spec.md 5, 7, 8): the focus geometry, the rail and tile builders, the keyboard layers, the key
// dispatch table, grid paging, the Library chips, Copy choice, Search rows and the screen stack. All pure.
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { TvBundle } from "../src/server/web"
import { defaultLibraryState } from "../src/shared/libraryView"
import { current } from "../src/shared/playlist"
import type { ArtistDto, ChapterDto, CopyDto, FavoriteItem, SearchResponse, SongListDto, VideoDto } from "../src/shared/types"
import { pickTvCopy } from "../src/tv/copies"
import { moveTarget, nearestByY, pickNext, type Box } from "../src/tv/focus"
import { COLS, ROW_H, pageTarget, windowRange, windowRows } from "../src/tv/gridMath"
import { LAYERS, layerChars, layerKeys, pressKey, typeChar, type KbState } from "../src/tv/keyboard"
import { actionFor } from "../src/tv/keys"
import { CHIPS, chipLabel, cycleChip } from "../src/tv/libchips"
import { makeEntry, pop, push, replaceTop, top } from "../src/tv/nav"
import { RAIL_CAP, artistVideoTiles, buildRails, concerts, continueWatching, favoriteTiles, gridTiles, isVideoGrid, playingFromTiles, railGrid, railTiles, recentlyAdded, shuffleStart, songVideoTiles, type TvData } from "../src/tv/rails"
import { playingFromRows, resultRows, startPlaylistOf } from "../src/tv/searchRows"

// ---- fixtures ----

let nextId = 1
const video = (o: Partial<VideoDto> = {}): VideoDto =>
  ({
    id: nextId++, title: "T", titleLatin: null, type: "song", favoritedAt: null, resumeS: null, lastPlayedAt: null, viewCount: 0, createdAt: "2026-01-01T00:00:00Z", addedAt: null,
    durationS: 200, available: true, artists: [], song: null, songSuggested: false, thumbnail: null, copies: [], chapterCount: 0, ...o,
  }) as unknown as VideoDto

const chapter = (id: number, videoId: number, startS: number): ChapterDto => ({ id, videoId, startS, title: `Ch ${id}`, favoritedAt: "x" }) as unknown as ChapterDto
const artist = (id: number, name: string, videoCount: number): ArtistDto => ({ id, name, videoCount, local: false, nameLatin: null, mirrorId: null, posterVideoId: null })
const song = (id: string, name: string, o: Partial<SongListDto> = {}): SongListDto => ({ id, name, englishName: null, videoCount: 1, chapterCount: 0, versionCount: 1, localVersionCount: 0, local: false, posterVideoId: null, addedAt: null, ...o })
const data = (o: Partial<TvData> = {}): TvData => ({ videos: [], artists: [], songs: [], favorites: [], ...o })

const box = (left: number, top: number, w = 100, h = 100): Box => ({ left, top, right: left + w, bottom: top + h })

// ---- focus geometry ----

describe("focus geometry", () => {
  test("right and left pick the nearest in the same row, never another row", () => {
    const cur = box(0, 0)
    const row = [box(120, 0), box(240, 0), box(120, 300)]
    expect(pickNext(cur, row, "right")).toBe(0)
    expect(pickNext(box(240, 0), row, "left")).toBe(0)
    expect(pickNext(cur, [box(120, 300)], "right")).toBe(-1) // a rail never leaves its row sideways
    expect(pickNext(cur, row, "left")).toBe(-1)
  })

  test("down and up pick the nearest column in the next row; an aligned one beats a nearer, shifted one", () => {
    const cur = box(300, 0)
    const below = [box(0, 120), box(300, 120), box(600, 120), box(300, 500)]
    expect(pickNext(cur, below, "down")).toBe(1)
    expect(pickNext(box(300, 120), [box(300, 0), box(0, 0)], "up")).toBe(0)
    expect(pickNext(cur, [box(0, 120), box(110, 200)], "down")).toBe(1) // the nearer column wins even when it is a row further
    expect(pickNext(cur, [box(300, -200)], "down")).toBe(-1)
  })

  test("zones: the current zone first, then across; null at an edge", () => {
    const header = { box: box(1500, 0, 100, 60), zone: "header" }
    const a = { box: box(0, 100), zone: "rails" }
    const b = { box: box(120, 100), zone: "rails" }
    const c = { box: box(0, 300), zone: "rails" }
    const all = [header, b, c]
    expect(moveTarget(a, all, "right")).toEqual({ index: 1, crossed: false })
    expect(moveTarget(a, all, "down")).toEqual({ index: 2, crossed: false })
    expect(moveTarget(a, all, "up")).toEqual({ index: 0, crossed: true }) // the first row's Up reaches the header
    expect(moveTarget(a, [header, b], "left")).toBeNull() // Left at a rail's start: the screen opens the pane
    expect(moveTarget(c, [header, a], "down")).toBeNull()
  })

  test("nearestByY lands on the row you were on", () => {
    expect(nearestByY(150, [box(0, 0), box(0, 110), box(0, 220)])).toBe(1)
    expect(nearestByY(0, [])).toBe(-1)
  })
})

// ---- rails ----

describe("rail builders", () => {
  test("Continue watching: Videos with a Resume position, most recently played first", () => {
    const a = video({ resumeS: 30, lastPlayedAt: "2026-02-01T00:00:00Z" })
    const b = video({ resumeS: 90, lastPlayedAt: "2026-03-01T00:00:00Z" })
    const c = video({ resumeS: 0, lastPlayedAt: "2026-04-01T00:00:00Z" })
    const d = video({ resumeS: null, lastPlayedAt: "2026-05-01T00:00:00Z" })
    const e = video({ resumeS: 5, lastPlayedAt: null })
    expect(continueWatching([a, b, c, d, e]).map((v) => v.id)).toEqual([b.id, a.id, e.id])
  })

  test("Recently added by Copy mtime, Concerts are Type concert", () => {
    const a = video({ addedAt: "2026-01-01T00:00:00Z", type: "concert" })
    const b = video({ addedAt: "2026-06-01T00:00:00Z", type: "song" })
    const c = video({ addedAt: null, createdAt: "2026-03-01T00:00:00Z", type: "concert" })
    expect(recentlyAdded([a, b, c]).map((v) => v.id)).toEqual([b.id, c.id, a.id])
    expect(concerts([a, b, c]).map((v) => v.id)).toEqual([c.id, a.id])
  })

  test("empty rails are hidden; the rest come in the spec's order, each ending in See all", () => {
    expect(buildRails(data())).toEqual([])
    const v = video({ type: "song" })
    const rails = buildRails(data({ videos: [v] }))
    expect(rails.map((r) => r.id)).toEqual(["library", "recent"]) // no Favorites, Artists, Resume, Concerts, Songs
    for (const r of rails) {
      expect(r.tiles.at(-1)).toMatchObject({ kind: "all", rail: r.id, label: "See all" })
      expect(r.total).toBe(1)
    }
    const full = buildRails(
      data({
        videos: [video({ type: "concert", resumeS: 10, lastPlayedAt: "2026-01-01T00:00:00Z" })],
        artists: [artist(1, "A", 3), artist(2, "None", 0)],
        songs: [song("s1", "Song", { versionCount: 1 }), song("s2", "Mute", { versionCount: 0 })],
        favorites: [{ kind: "video", favoritedAt: "2026-01-01", video: video() } as FavoriteItem],
      }),
    )
    expect(full.map((r) => r.id)).toEqual(["favorites", "library", "artists", "continue", "recent", "concerts", "songs"])
    expect(full.find((r) => r.id === "artists")!.total).toBe(1) // an Artist without Videos is not listed
    expect(full.find((r) => r.id === "songs")!.total).toBe(1) // only Songs with lyrics
  })

  test("the Library rail is most watched first and a rail holds at most RAIL_CAP tiles before See all", () => {
    const vs = Array.from({ length: 40 }, (_, i) => video({ viewCount: i }))
    const lib = buildRails(data({ videos: vs })).find((r) => r.id === "library")!
    expect(lib.tiles).toHaveLength(RAIL_CAP + 1)
    expect(lib.total).toBe(40)
    expect(lib.tiles[0]).toMatchObject({ kind: "video", video: { viewCount: 39 } })
  })

  test("See all opens the rail's grid", () => {
    expect(railGrid("songs")).toEqual({ kind: "songs", lyricsOnly: true })
    expect(railGrid("library")).toEqual({ kind: "library" })
    expect(railGrid("concerts")).toEqual({ kind: "rail", rail: "concerts" })
    const d = data({ videos: [video({ type: "concert" }), video()] })
    expect(railTiles("concerts", d)).toHaveLength(1)
  })
})

// ---- Favorites tiles and grids ----

describe("Favorites tile builder", () => {
  const v1 = video()
  const v2 = video()
  const items: FavoriteItem[] = [
    { kind: "video", favoritedAt: "2026-01-01T00:00:00Z", video: v1 },
    { kind: "chapter", favoritedAt: "2026-03-01T00:00:00Z", video: v2, chapter: chapter(7, v2.id, 120) },
    { kind: "video", favoritedAt: "2026-02-01T00:00:00Z", video: v2 },
  ]

  test("a Video row is a Video tile, a Chapter row a Chapter tile; newest starred first", () => {
    const tiles = favoriteTiles(items)
    expect(tiles.map((t) => t.kind)).toEqual(["chapter", "video", "video"])
    expect(tiles.map((t) => t.key)).toEqual(["c7", `v${v2.id}`, `v${v1.id}`])
    const c = tiles[0]!
    expect(c.kind === "chapter" && c.chapter.startS).toBe(120)
  })

  test("Shuffle over Favorites gives Chapter Entries that open at the Chapter", () => {
    const tiles = favoriteTiles(items)
    for (let seed = 0; seed < 8; seed++) {
      const s = shuffleStart(tiles, "favorites", false, () => (seed + 0.5) / 8)!
      const e = current(s.playlist)!
      expect(s.playlist.source).toBe("favorites")
      expect(s.playlist.shuffled).toBe(true)
      expect(s.playlist.repeat).toBe("off")
      expect(s.playlist.entries).toHaveLength(3)
      if (e.chapterId === 7) expect(s.startS).toBe(120)
      else expect(s.startS).toBeNull()
    }
    expect(playingFromTiles(tiles, "favorites")).toEqual({ source: "favorites", ids: [v2.id, v1.id] }) // one entry per Video
  })

  test("Shuffle starts at an Available Entry and is null when nothing plays", () => {
    const gone = video({ available: false })
    const ok = video()
    const tiles = gridTiles({ kind: "rail", rail: "recent" }, data({ videos: [gone, ok] }), defaultLibraryState())
    for (let i = 0; i < 6; i++) expect(shuffleStart(tiles, "other", false, () => i / 6)!.videoId).toBe(ok.id)
    expect(shuffleStart(gridTiles({ kind: "rail", rail: "recent" }, data({ videos: [gone] }), defaultLibraryState()), "other", false)).toBeNull()
    expect(shuffleStart([], "library", false)).toBeNull()
  })

  test("the whole-library Shuffle is library-all, a filtered one library", () => {
    const tiles = gridTiles({ kind: "library" }, data({ videos: [video(), video()] }), defaultLibraryState())
    expect(shuffleStart(tiles, "library", false)!.playlist.source).toBe("library-all")
    expect(shuffleStart(tiles, "library", true)!.playlist.source).toBe("library")
  })
})

describe("grid tiles", () => {
  test("a Song's Videos: its own Video pointer opens at the Resume position, a Chapter performance at the Chapter", () => {
    const a = video({ viewCount: 1 })
    const b = video({ viewCount: 5 })
    const c = video()
    const tiles = songVideoTiles([a, b, c], [{ id: a.id, pointed: true, startS: null }, { id: b.id, pointed: false, startS: 300 }])
    expect(tiles.map((t) => (t.kind === "video" ? [t.video.id, t.startS] : null))).toEqual([[b.id, 300], [a.id, null]]) // most watched first, c is not in it
  })

  test("an Artist's Videos are the Videos carrying that Artist", () => {
    const ar = { id: 9, name: "X", nameLatin: null, local: false, suggested: false }
    const a = video({ artists: [ar] })
    const b = video({ artists: [] })
    expect(artistVideoTiles([a, b], 9).map((t) => t.key)).toEqual([`v${a.id}`])
  })

  test("Artists and Songs grids get no Shuffle tile; Video grids do", () => {
    const d = data({ videos: [video()], artists: [artist(1, "A", 2)], songs: [song("s", "S")] })
    expect(isVideoGrid(gridTiles({ kind: "artists" }, d, defaultLibraryState()))).toBe(false)
    expect(isVideoGrid(gridTiles({ kind: "songs", lyricsOnly: false }, d, defaultLibraryState()))).toBe(false)
    expect(isVideoGrid(gridTiles({ kind: "library" }, d, defaultLibraryState()))).toBe(true)
  })

  test("the Library grid follows the chips", () => {
    const s = video({ type: "song", viewCount: 1 })
    const k = video({ type: "concert", viewCount: 2, favoritedAt: "x" })
    const d = data({ videos: [s, k] })
    const ids = (lib = defaultLibraryState()) => gridTiles({ kind: "library" }, d, lib).map((t) => (t.kind === "video" ? t.video.id : 0))
    expect(ids()).toEqual([k.id, s.id])
    expect(ids(cycleChip("type", defaultLibraryState()))).toEqual([s.id]) // Type: song
    expect(ids(cycleChip("fav", defaultLibraryState()))).toEqual([k.id])
    expect(ids(cycleChip("dir", defaultLibraryState()))).toEqual([s.id, k.id])
  })
})

// ---- Library chips ----

describe("Library chips", () => {
  test("Type walks every Type then back to all", () => {
    let st = defaultLibraryState()
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      st = cycleChip("type", st)
      seen.push(chipLabel("type", st).value)
    }
    expect(seen).toEqual(["song", "concert", "interview", "other", "all"])
  })

  test("Sort advances and resets the direction to its natural one; Order flips it", () => {
    let st = cycleChip("sort", defaultLibraryState())
    expect(st.sort).toBe("added")
    st = cycleChip("sort", st)
    expect(st).toMatchObject({ sort: "title", dir: "asc" })
    expect(cycleChip("dir", st).dir).toBe("desc")
    expect(chipLabel("dir", cycleChip("dir", st)).on).toBe(true)
    expect(CHIPS).toEqual(["type", "fav", "sort", "dir"])
  })
})

// ---- keyboard ----

describe("on-screen keyboard", () => {
  test("three layers: Latin, Cyrillic with the Tuvan letters, digits", () => {
    expect(LAYERS).toEqual(["latin", "cyr", "digits"])
    expect(layerChars("latin")).toHaveLength(26)
    const cyr = layerChars("cyr")
    for (const ch of ["ө", "ү", "ң", "а", "я", "ё"]) expect(cyr).toContain(ch)
    expect(layerChars("digits").join("")).toBe("1234567890")
  })

  test("every layer ends with space, backspace, the layer switches and clear", () => {
    for (const l of LAYERS) {
      const k = layerKeys(l)
      expect(k.slice(-6).map((x) => x.kind)).toEqual(["space", "backspace", "layer", "layer", "layer", "clear"])
    }
    expect(layerKeys("cyr")).toHaveLength(42) // six rows of seven
  })

  test("typing, space rules, backspace by character, clear, layer switch", () => {
    const keys = layerKeys("cyr")
    const key = (kind: string, value?: string) => keys.find((k) => k.kind === kind && (!value || ("value" in k && k.value === value)))!
    let st: KbState = { text: "", layer: "latin" }
    st = pressKey(st, key("space"))
    expect(st.text).toBe("") // no leading space
    st = pressKey(pressKey(st, key("char", "ө")), key("char", "ү"))
    expect(st.text).toBe("өү")
    st = pressKey(pressKey(st, key("space")), key("space"))
    expect(st.text).toBe("өү ") // no double space
    st = pressKey(st, key("backspace"))
    st = pressKey(st, key("backspace"))
    expect(st.text).toBe("ө")
    expect(pressKey({ ...st, text: "😀" }, key("backspace")).text).toBe("") // a whole character
    expect(pressKey(st, { kind: "layer", layer: "digits", label: "123" }).layer).toBe("digits")
    expect(pressKey(st, key("clear")).text).toBe("")
  })

  test("a physical keyboard types any printable character", () => {
    let st: KbState = { text: "", layer: "latin" }
    for (const ch of "Tyva 5ң") st = typeChar(st, ch)
    expect(st.text).toBe("Tyva 5ң")
    expect(typeChar(st, "\n")).toEqual(st)
    expect(typeChar(st, "ab")).toEqual(st)
  })
})

// ---- the key dispatch table ----

describe("key dispatch table", () => {
  const code = (keyCode: number, key = "") => actionFor({ keyCode, key })

  test("the remote's codes map to the §8 actions", () => {
    const table: [number, string][] = [
      [37, "left"], [38, "up"], [39, "right"], [40, "down"], [13, "enter"], [10009, "back"], [10182, "exit"],
      [427, "pageUp"], [428, "pageDown"], [10252, "playpause"], [415, "play"], [19, "pause"], [412, "rewind"], [417, "forward"],
      [10232, "prev"], [10233, "next"], [403, "red"], [404, "green"], [405, "yellow"], [406, "blue"], [457, "info"],
    ]
    for (const [c, a] of table) expect(code(c)?.action).toBe(a as never)
  })

  test("digits are characters (Search types them), letters too, the desktop stand-ins work", () => {
    expect(code(53, "5")).toEqual({ action: "char", char: "5" })
    expect(code(65, "a")).toEqual({ action: "char", char: "a" })
    expect(code(32, " ")).toEqual({ action: "char", char: " " })
    expect(code(27, "Escape")?.action).toBe("back")
    expect(code(8, "Backspace")?.action).toBe("backspace")
    expect(code(34, "PageDown")?.action).toBe("pageDown")
    expect(code(190, ">")?.action).toBe("next")
    expect(code(188, "<")?.action).toBe("prev")
  })

  test("modified keys and unknown keys are ignored", () => {
    expect(actionFor({ keyCode: 82, key: "r", metaKey: true })).toBeNull()
    expect(code(112, "F12")).toBeNull()
    expect(code(16, "Shift")).toBeNull()
  })
})

// ---- grid arithmetic ----

describe("grid windowing and paging", () => {
  test("six columns; the window is the visible rows plus a buffer, clamped", () => {
    expect(COLS).toBe(6)
    expect(windowRows(0, 800, 100)).toEqual({ first: 0, last: 6 })
    const w = windowRows(ROW_H * 50, 800, 100)
    expect(w.first).toBe(47)
    expect(w.last).toBe(50 + 3 + 3)
    expect(windowRows(ROW_H * 99, 800, 100).last).toBe(100)
    expect(windowRange(1000, { first: 2, last: 4 })).toEqual({ from: 12, to: 24 })
    expect(windowRange(15, { first: 2, last: 4 })).toEqual({ from: 12, to: 15 })
  })

  test("ChannelDown and Up move a page of rows in the same column, clamped to the ends", () => {
    expect(pageTarget(2, 100, 2, 1)).toBe(14)
    expect(pageTarget(14, 100, 2, -1)).toBe(2)
    expect(pageTarget(2, 100, 2, -1)).toBe(2) // already the top row
    expect(pageTarget(94, 100, 2, 1)).toBe(99) // the last row is short: its last tile
    expect(pageTarget(0, 0, 2, 1)).toBe(0)
  })
})

// ---- Copy choice ----

describe("which Copy the TV plays", () => {
  const copy = (id: number, rootKind: "local" | "external", order: "file" | "fallback" | "live", available = true): CopyDto => ({ id, rootKind, available, tv: { decision: null, order } }) as unknown as CopyDto
  test("local first, then one the TV plays, then the server's order; unavailable never", () => {
    expect(pickTvCopy([copy(1, "external", "file"), copy(2, "local", "live")])?.id).toBe(2) // local beats playable
    expect(pickTvCopy([copy(1, "local", "live"), copy(2, "local", "fallback")])?.id).toBe(2)
    expect(pickTvCopy([copy(1, "local", "file"), copy(2, "local", "file")])?.id).toBe(1)
    expect(pickTvCopy([copy(1, "local", "file", false)])).toBeNull()
    expect(pickTvCopy([])).toBeNull()
  })
})

// ---- Search rows ----

describe("Search results", () => {
  const res: SearchResponse = {
    needle: "ala",
    ms: 1,
    groups: [
      { key: "videos", label: "Videos", total: 2, rows: [
        { kind: "video", id: 5, title: "Alash live", type: "concert", durationS: 60, available: true, songs: [], songSuggested: false },
        { kind: "chapter", id: 8, videoId: 6, videoTitle: "Concert", title: "Alash song", startS: 90, available: true },
      ] },
      { key: "songs", label: "Songs", total: 1, rows: [
        { kind: "song", id: "u1", name: "Alash", englishName: null, hidden: false, local: false, viaLyrics: true, lyric: "an alash line", videos: [{ id: 5, startS: null }] },
      ] },
      { key: "tracks", label: "Tracks", total: 1, rows: [{ kind: "track", id: "t", name: "T", album: null, by: [], songId: null, versionId: null }] },
      { key: "artists", label: "Artists", total: 1, rows: [{ kind: "artist", id: 3, name: "Alash Ensemble", local: false, videoCount: 4 }] },
    ],
  }

  test("grouped Songs, Videos, Artists in that order; Tracks and Albums are dropped", () => {
    const rows = resultRows(res, [video({ id: 6, type: "interview" } as Partial<VideoDto>)])
    expect(rows.map((r) => (r.kind === "shuffle" ? r.kind : r.group))).toEqual(["Songs", "Videos", "Videos", "Artists"])
    const s = rows[0]!
    expect(s.kind === "song" && s.lyric).toBe("an alash line") // the lyric line under a lyrics-matched Song
  })

  test("a Chapter hit plays its Video at the Chapter", () => {
    const rows = resultRows(res)
    const ch = rows.find((r) => r.kind === "video" && r.chapterTitle != null)!
    expect(ch.kind === "video" && [ch.videoId, ch.startS, ch.title]).toEqual([6, 90, "Concert"])
  })

  test("Playing from is the Videos listed, once each; the Shuffle row starts a search Playlist", () => {
    const rows = resultRows(res)
    expect(playingFromRows(rows)).toEqual({ source: "search", ids: [5, 6] })
    const s = startPlaylistOf(rows, [], () => 0)!
    expect(s.playlist.source).toBe("search")
    expect([5, 6]).toContain(s.videoId)
    expect(startPlaylistOf([], [])).toBeNull()
  })

  test("nothing before a response", () => {
    expect(resultRows(null)).toEqual([])
  })
})

// ---- the screen stack ----

describe("screen stack", () => {
  test("push, pop, replace; the home stays", () => {
    const home = makeEntry({ kind: "home" })
    let s = [home]
    expect(pop(s).popped).toBeNull()
    s = push(s, makeEntry({ kind: "grid", grid: { kind: "library" } }, "p-library"))
    s = push(s, makeEntry({ kind: "search" }))
    expect(top(s).route.kind).toBe("search")
    const p = pop(s)
    expect(p.popped?.route.kind).toBe("search")
    expect(top(p.stack).fromPane).toBe("p-library") // Back from the grid reopens the pane on its item
    const r = replaceTop(s, makeEntry({ kind: "home" }))
    expect(r).toHaveLength(3)
    expect(new Set(s.map((e) => e.id)).size).toBe(3)
  })
})

// ---- the bundle ----

describe("TV bundle", () => {
  test("src/tv/main.tsx bundles to /tv.js and the tokens ship as /tv.css", async () => {
    const b = new TvBundle({ webDir: join(import.meta.dir, "..", "src", "web") })
    await b.build()
    const js = await b.serve("/tv.js").text()
    expect(js.length).toBeGreaterThan(20_000)
    expect(js).not.toContain("TV UI build failed")
    expect(js).toContain("tuvaTv") // reads the shell base
    const css = await b.serve("/tv.css").text()
    expect(css).toContain("--accent: #d97757")
    expect(css).toContain("width: 1920px")
  })
})
