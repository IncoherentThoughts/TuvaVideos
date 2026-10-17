// What the TV home and grids show (docs/tv-spec.md 5.1, 5.3): the rails, the Favorites tiles, the grid tile lists and
// the Playlist a Shuffle tile starts. Pure: the data in, tiles out, so a test walks every rule.
import { defaultLibraryState, viewVideos, filterVideos, type LibraryState } from "../shared/libraryView"
import { favoriteEntries, favoriteStartS, libraryFiltered, libraryStart, videoEntries, type FavoriteRow } from "../shared/playlistStart"
import { startPlaylist, type Entry, type Playlist, type PlaylistSource } from "../shared/playlist"
import { uniqueIds, type PlayingFrom, type PlayingSource } from "../shared/playingFrom"
import type { ArtistDto, ChapterDto, FavoriteItem, SongListDto, VideoDto } from "../shared/types"

export interface TvData {
  videos: VideoDto[]
  artists: ArtistDto[]
  songs: SongListDto[]
  favorites: FavoriteItem[]
}

export type Tile =
  | { kind: "shuffle"; key: "shuffle"; count: number }
  /** `startS` opens the Video there (a Song's Chapter); null/undefined opens at the Resume position. */
  | { kind: "video"; key: string; video: VideoDto; startS?: number | null }
  | { kind: "chapter"; key: string; video: VideoDto; chapter: ChapterDto }
  | { kind: "artist"; key: string; artist: ArtistDto }
  | { kind: "song"; key: string; song: SongListDto }
  | { kind: "all"; key: string; rail: RailId; label: string }

export type RailId = "favorites" | "library" | "artists" | "continue" | "recent" | "concerts" | "songs"

export interface Rail {
  id: RailId
  title: string
  /** The tiles shown (capped), then the See all tile. */
  tiles: Tile[]
  /** How many things the full grid holds. */
  total: number
}

/** Tiles in a rail before its See all tile; the grid has the rest. */
export const RAIL_CAP = 24

export const RAIL_TITLE: Record<RailId, string> = {
  favorites: "Favorites",
  library: "Library",
  artists: "Artists",
  continue: "Continue watching",
  recent: "Recently added",
  concerts: "Concerts",
  songs: "Songs with lyrics",
}

const added = (v: VideoDto) => v.addedAt ?? v.createdAt
const newestFirst = (a: string | null, b: string | null) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a < b ? 1 : a > b ? -1 : 0)

/** Favorites in the order starred, newest first (the browser's default), a Video row and a Chapter row alike. */
export function favoriteTiles(items: readonly FavoriteItem[]): Tile[] {
  return [...items]
    .sort((a, b) => newestFirst(a.favoritedAt, b.favoritedAt))
    .map((i): Tile => (i.kind === "video" ? { kind: "video", key: `v${i.video.id}`, video: i.video } : { kind: "chapter", key: `c${i.chapter.id}`, video: i.video, chapter: i.chapter }))
}

const videoTile = (video: VideoDto, startS?: number | null): Tile => ({ kind: "video", key: `v${video.id}`, video, startS })

/** Library order on the home: most watched first (the browser's Library state is not readable from the TV). */
export const libraryOrder = (videos: readonly VideoDto[]): VideoDto[] => viewVideos([...videos], defaultLibraryState())

/** Videos with a Resume position, the most recently played first. */
export function continueWatching(videos: readonly VideoDto[]): VideoDto[] {
  return videos.filter((v) => (v.resumeS ?? 0) > 0).sort((a, b) => newestFirst(a.lastPlayedAt, b.lastPlayedAt) || b.id - a.id)
}

export function recentlyAdded(videos: readonly VideoDto[]): VideoDto[] {
  return [...videos].sort((a, b) => newestFirst(added(a), added(b)) || b.id - a.id)
}

export const concerts = (videos: readonly VideoDto[]): VideoDto[] => recentlyAdded(videos.filter((v) => v.type === "concert"))

/** Artists with Videos, the most Videos first. */
export function artistsByVideos(artists: readonly ArtistDto[]): ArtistDto[] {
  return artists.filter((a) => a.videoCount > 0).sort((a, b) => b.videoCount - a.videoCount || a.name.localeCompare(b.name))
}

/** Songs that have lyrics, the most performed first. */
export function songsWithLyrics(songs: readonly SongListDto[]): SongListDto[] {
  return mostPerformed(songs.filter((s) => s.versionCount > 0))
}

export const mostPerformed = (songs: readonly SongListDto[]): SongListDto[] =>
  [...songs].sort((a, b) => b.videoCount + b.chapterCount - (a.videoCount + a.chapterCount) || a.name.localeCompare(b.name))

const artistTile = (artist: ArtistDto): Tile => ({ kind: "artist", key: `a${artist.id}`, artist })
const songTile = (song: SongListDto): Tile => ({ kind: "song", key: `s${song.id}`, song })

/** Every tile of a rail's full grid (without the Shuffle tile, which the grid adds). */
export function railTiles(id: RailId, d: TvData, lib: LibraryState = defaultLibraryState()): Tile[] {
  switch (id) {
    case "favorites": return favoriteTiles(d.favorites)
    case "library": return viewVideos([...d.videos], lib).map((v) => videoTile(v))
    case "artists": return artistsByVideos(d.artists).map(artistTile)
    case "continue": return continueWatching(d.videos).map((v) => videoTile(v))
    case "recent": return recentlyAdded(d.videos).map((v) => videoTile(v))
    case "concerts": return concerts(d.videos).map((v) => videoTile(v))
    case "songs": return songsWithLyrics(d.songs).map(songTile)
  }
}

export const RAIL_ORDER: readonly RailId[] = ["favorites", "library", "artists", "continue", "recent", "concerts", "songs"]

/** The home's rails in order; an empty rail is left out. Each ends in a See all tile. */
export function buildRails(d: TvData): Rail[] {
  const out: Rail[] = []
  for (const id of RAIL_ORDER) {
    const all = railTiles(id, d)
    if (!all.length) continue
    out.push({ id, title: RAIL_TITLE[id], total: all.length, tiles: [...all.slice(0, RAIL_CAP), { kind: "all", key: `all-${id}`, rail: id, label: "See all" }] })
  }
  return out
}

// ---- grids ----

export type GridSpec =
  | { kind: "library" }
  | { kind: "favorites" }
  | { kind: "artists" }
  | { kind: "songs"; lyricsOnly: boolean }
  | { kind: "rail"; rail: "continue" | "recent" | "concerts" }
  | { kind: "song"; id: string; name: string }
  | { kind: "artist"; id: number; name: string }

export const GRID_TITLE = { library: "Library", favorites: "Favorites", artists: "Artists", continue: "Continue watching", recent: "Recently added", concerts: "Concerts" } as const

export function gridTitle(g: GridSpec): string {
  if (g.kind === "songs") return g.lyricsOnly ? "Songs with lyrics" : "Songs"
  if (g.kind === "rail") return GRID_TITLE[g.rail]
  if (g.kind === "song" || g.kind === "artist") return g.name
  return GRID_TITLE[g.kind]
}

/** The full grid a rail's See all tile opens. */
export function railGrid(id: RailId): GridSpec {
  if (id === "songs") return { kind: "songs", lyricsOnly: true }
  if (id === "library" || id === "favorites" || id === "artists") return { kind: id }
  return { kind: "rail", rail: id }
}

/** What a Song's grid knows about its Videos: `GET /api/songs/:uuid` `videos`. */
export interface SongVideo {
  id: number
  pointed: boolean
  startS: number | null
}

/**
 * The Videos of a Song, library order. A Video that performs it only in a Chapter opens at that Chapter (`pointed` is
 * the Video's own Song pointer, which opens at the Resume position as usual).
 */
export function songVideoTiles(videos: readonly VideoDto[], perf: readonly SongVideo[], lib: LibraryState = defaultLibraryState()): Tile[] {
  const by = new Map(perf.map((p) => [p.id, p]))
  return viewVideos(videos.filter((v) => by.has(v.id)), lib).map((v) => {
    const p = by.get(v.id)!
    return videoTile(v, p.pointed ? null : p.startS)
  })
}

export function artistVideoTiles(videos: readonly VideoDto[], artistId: number, lib: LibraryState = defaultLibraryState()): Tile[] {
  return viewVideos(videos.filter((v) => v.artists.some((a) => a.id === artistId)), lib).map((v) => videoTile(v))
}

/** Tiles of the Library grid with the chips applied (the same call as the browser's Library). */
export function libraryTiles(videos: readonly VideoDto[], lib: LibraryState): Tile[] {
  return viewVideos(filterVideos([...videos], lib), lib).map((v) => videoTile(v))
}

/** Every tile of a grid (without Shuffle). `perf` is a Song grid's `SongDto.videos`, loaded by the grid. */
export function gridTiles(g: GridSpec, d: TvData, lib: LibraryState, perf: readonly SongVideo[] = []): Tile[] {
  switch (g.kind) {
    case "library": return libraryTiles(d.videos, lib)
    case "favorites": return favoriteTiles(d.favorites)
    case "artists": return artistsByVideos(d.artists).map(artistTile)
    case "songs": return (g.lyricsOnly ? songsWithLyrics(d.songs) : mostPerformed(d.songs)).map(songTile)
    case "rail": return railTiles(g.rail, d)
    case "song": return songVideoTiles(d.videos, perf, lib)
    case "artist": return artistVideoTiles(d.videos, g.id, lib)
  }
}

export const isVideoTile =(t: Tile) => t.kind === "video" || t.kind === "chapter"

/** Does the grid get a Shuffle tile? Every Video grid does (Artists and Songs grids list people and Songs, not Videos). */
export const isVideoGrid = (tiles: readonly Tile[]) => tiles.some(isVideoTile)

// ---- Playing from and the Shuffle tile ----

export interface OpenList {
  source: PlayingSource
  ids: number[]
}

/** The list a Video opened from `tiles` steps through (Playing from, spec 4.4): Favorites stay Favorites, the rest are library lists. */
export function playingFromTiles(tiles: readonly Tile[], source: PlayingSource = "library"): PlayingFrom {
  const ids: number[] = []
  for (const t of tiles) if (t.kind === "video" || t.kind === "chapter") ids.push(t.video.id)
  return { source, ids: uniqueIds(ids) }
}

export interface ShuffleStart {
  playlist: Playlist
  playingFrom: PlayingFrom
  /** Where the Player opens: the first Entry's Video, at the Chapter's start for a Chapter Entry. */
  videoId: number
  startS: number | null
}

/**
 * The Shuffle tile (spec 5.3, 6.7): a shuffled Playlist of the grid as filtered, Repeat off, starting at a random
 * Available Entry. A Favorites Chapter tile is a Chapter Entry; everything else is a Video Entry. Null when nothing is
 * playable.
 */
export function shuffleStart(tiles: readonly Tile[], grid: "library" | "favorites" | "other", filtered: boolean, rng: () => number = Math.random): ShuffleStart | null {
  const vt = tiles.filter((t): t is Extract<Tile, { kind: "video" | "chapter" }> => t.kind === "video" || t.kind === "chapter")
  if (!vt.length) return null
  let entries: Entry[]
  let source: PlaylistSource
  let rows: FavoriteRow[] = []
  if (grid === "favorites") {
    rows = vt.map((t): FavoriteRow => (t.kind === "video" ? { kind: "video", videoId: t.video.id } : { kind: "chapter", videoId: t.video.id, chapterId: t.chapter.id, startS: t.chapter.startS }))
    entries = favoriteEntries(rows)
    source = "favorites"
  } else if (grid === "library") {
    ;({ entries, source } = libraryStart(vt.map((t) => t.video.id), filtered))
  } else {
    entries = videoEntries(vt.map((t) => t.video.id))
    source = "library"
  }
  const playable = entries.map((_, i) => i).filter((i) => vt[i]!.video.available)
  if (!playable.length) return null
  const startAt = playable[Math.min(playable.length - 1, Math.floor(rng() * playable.length))]!
  const playlist = startPlaylist(entries, { source, shuffled: true, startAt, rng })
  const first = entries[startAt]!
  return {
    playlist,
    playingFrom: { source: source === "favorites" ? "favorites" : "library", ids: uniqueIds(vt.map((t) => t.video.id)) },
    videoId: first.videoId,
    startS: grid === "favorites" ? favoriteStartS(rows, first) : null,
  }
}

export { libraryFiltered }
