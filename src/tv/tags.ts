// The Player's tag row (docs/tv-spec.md 6.4): Type, Artists, ♪ Song as focusable tags (Enter opens the grid of that Type /
// Artist / Song's Videos), then the Copy's container, codecs, resolution and Root, and "Playing from ‹list›" as text.
import type { VideoType } from "../shared/filters"
import type { PlayingFrom } from "../shared/playingFrom"
import { SOURCE_LABEL, positionIn } from "../shared/playingFrom"
import { SOURCE_LABEL as PLAYLIST_LABEL, position, type Playlist } from "../shared/playlist"
import type { CopyDto, VideoDto } from "../shared/types"
import { copyLabel } from "./copyList"
import type { GridSpec } from "./rails"

export type TagItem =
  | { kind: "type"; label: string; type: VideoType }
  | { kind: "artist"; label: string; id: number; name: string; suggested: boolean }
  | { kind: "song"; label: string; id: string; name: string; suggested: boolean }

export function focusableTags(video: Pick<VideoDto, "type" | "artists" | "song" | "songSuggested">): TagItem[] {
  const tags: TagItem[] = [{ kind: "type", label: video.type, type: video.type }]
  for (const a of video.artists) if (!a.suggested) tags.push({ kind: "artist", label: a.name, id: a.id, name: a.name, suggested: false })
  if (video.song?.name) tags.push({ kind: "song", label: `♪ ${video.song.name}`, id: video.song.id, name: video.song.name, suggested: video.songSuggested })
  return tags
}

/** The grid a tag opens. */
export function tagGrid(t: TagItem): GridSpec {
  switch (t.kind) {
    case "type": return { kind: "type", type: t.type }
    case "artist": return { kind: "artist", id: t.id, name: t.name }
    case "song": return { kind: "song", id: t.id, name: t.name }
  }
}

/** "Playing from Library · 3 of 40"; with a Playlist active "Playing from Playlist · Favorites · shuffled · 3 of 40". */
export function playingFromText(pf: PlayingFrom, videoId: number, playlist: Pick<Playlist, "source" | "shuffled" | "order" | "cursor"> | null): string {
  if (playlist) {
    const { n, total } = position(playlist as Playlist)
    return `Playing from Playlist · ${PLAYLIST_LABEL[playlist.source]} · ${playlist.shuffled ? "shuffled" : "in order"} · ${n} of ${total}`
  }
  const pos = positionIn(pf, videoId)
  return `Playing from ${SOURCE_LABEL[pf.source]}${pos ? ` · ${pos.n} of ${pos.total}` : ""}`
}

/** The text items after the tags: the Copy's facts and the audio state. `audio` is null when nothing is to be said. */
export function infoTexts(copy: Pick<CopyDto, "container" | "videoCodec" | "audioCodec" | "height" | "width" | "rootKind"> | null, audio: string | null): string[] {
  const out: string[] = []
  if (copy) out.push(`${copyLabel(copy)} · ${copy.rootKind}`)
  if (audio) out.push(audio)
  return out
}
