// Search results as rows (docs/tv-spec.md 7): the response's Songs / Videos / Artists groups flattened for the list on
// the right (Tracks and Albums are not shown on the TV). Pure.
import type { PlayingFrom } from "../shared/playingFrom"
import { startPlaylist, type Playlist } from "../shared/playlist"
import { searchEntries } from "../shared/playlistStart"
import type { SearchResponse, VideoDto } from "../shared/types"

interface Base {
  key: string
  group: string
  groupTotal: number
}

export type ResultRow =
  | { kind: "shuffle"; key: "shuffle" }
  | (Base & { kind: "song"; id: string; name: string; englishName: string | null; /** The matching lyric line, when the Song matched through its lyrics. */ lyric: string | null; videoCount: number })
  | (Base & {
      kind: "video"
      videoId: number
      title: string
      type: string
      durationS: number | null
      available: boolean
      songs: string[]
      /** A Video reached through a matching Chapter opens there. */
      startS: number | null
      chapterTitle: string | null
    })
  | (Base & { kind: "artist"; id: number; name: string; videoCount: number; local: boolean })

export const SHOWN_GROUPS = ["songs", "videos", "artists"] as const

/** The rows in display order: Songs, then Videos (Video rows and Chapter rows as the server ranked them), then Artists. */
export function resultRows(res: SearchResponse | null, videos: readonly VideoDto[] = []): ResultRow[] {
  if (!res) return []
  const byId = new Map(videos.map((v) => [v.id, v]))
  const out: ResultRow[] = []
  for (const key of SHOWN_GROUPS) {
    const g = res.groups.find((x) => x.key === key)
    if (!g) continue
    for (const r of g.rows) {
      const base = { group: g.label, groupTotal: g.total }
      if (r.kind === "song") out.push({ ...base, kind: "song", key: `s${r.id}`, id: r.id, name: r.name, englishName: r.englishName, lyric: r.viaLyrics ? r.lyric : null, videoCount: r.videos.length })
      else if (r.kind === "video") out.push({ ...base, kind: "video", key: `v${r.id}`, videoId: r.id, title: r.title, type: r.type, durationS: r.durationS, available: r.available, songs: r.songs, startS: null, chapterTitle: null })
      else if (r.kind === "chapter") {
        const v = byId.get(r.videoId)
        out.push({ ...base, kind: "video", key: `c${r.id}`, videoId: r.videoId, title: r.videoTitle, type: v?.type ?? "other", durationS: v?.durationS ?? null, available: r.available, songs: [], startS: r.startS, chapterTitle: r.title })
      } else if (r.kind === "artist") out.push({ ...base, kind: "artist", key: `a${r.id}`, id: r.id, name: r.name, videoCount: r.videoCount, local: r.local })
    }
  }
  return out
}

/** Playing from for a Video opened from the results: the Videos listed, once each, in order (spec 5.4). */
export function playingFromRows(rows: readonly ResultRow[]): PlayingFrom {
  const ids: number[] = []
  for (const r of rows) if (r.kind === "video" && !ids.includes(r.videoId)) ids.push(r.videoId)
  return { source: "search", ids }
}

export interface RowsShuffle {
  playlist: Playlist
  playingFrom: PlayingFrom
  videoId: number
}

/** The results' Shuffle row: a shuffled Playlist of the listed Videos (capped), starting at a random Available one. */
export function startPlaylistOf(rows: readonly ResultRow[], _videos: readonly VideoDto[] = [], rng: () => number = Math.random): RowsShuffle | null {
  const pf = playingFromRows(rows)
  const availableIds = new Set(rows.flatMap((r) => (r.kind === "video" && r.available ? [r.videoId] : [])))
  const entries = searchEntries(pf.ids)
  const playable = entries.map((_, i) => i).filter((i) => availableIds.has(entries[i]!.videoId))
  if (!playable.length) return null
  const startAt = playable[Math.min(playable.length - 1, Math.floor(rng() * playable.length))]!
  const playlist = startPlaylist(entries, { source: "search", shuffled: true, startAt, rng })
  return { playlist, playingFrom: pf, videoId: entries[startAt]!.videoId }
}
