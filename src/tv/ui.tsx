// Cards of the TV home and grids (docs/tv-spec.md 5.1): the browser's card at TV size. A card is a focus item
// (`data-item`, `data-key`); Enter clicks it, so a mouse works too on the desktop.
import { useState } from "preact/hooks"
import type { ComponentChildren } from "preact"
import { tileForTime } from "../server/stripGeometry"
import { artistSlot, fmtDuration, phColor } from "../web/ui"
import type { ArtistDto, SongListDto, VideoDto, ChapterDto } from "../shared/types"
import { url } from "./data"
import type { Tile } from "./rails"

export function Poster({ video, posterOf, children }: { video: Pick<VideoDto, "id" | "thumbnail" | "available">; posterOf?: string; children?: ComponentChildren }) {
  const [failed, setFailed] = useState(false)
  const src = posterOf != null ? `/thumbs/${posterOf}/poster.webp` : video.thumbnail?.poster
  const has = !!src && !failed && (posterOf != null || !!video.thumbnail)
  return (
    <div class={`po${has ? "" : " ph"}${video.available ? "" : " unavail"}`} style={has ? undefined : { "--ph": phColor(video.id) }}>
      {has && <img src={url(src!)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
      {children}
    </div>
  )
}

/** The scrub-strip frame at `t` (a CSS sprite), else the poster: a Chapter tile's picture. */
export function StripFrame({ video, t }: { video: VideoDto; t: number }) {
  const strip = video.thumbnail?.strip
  if (!strip || !video.durationS) return <Poster video={video} />
  const tile = tileForTime(t, video.durationS, { frames: strip.frames, columns: strip.columns, rows: strip.rows })
  const x = strip.columns > 1 ? (tile.column / (strip.columns - 1)) * 100 : 0
  const y = strip.rows > 1 ? (tile.row / (strip.rows - 1)) * 100 : 0
  return (
    <div class={`po${video.available ? "" : " unavail"}`}>
      <div class="frame" style={{ backgroundImage: `url(${url(strip.url)})`, backgroundSize: `${strip.columns * 100}% ${strip.rows * 100}%`, backgroundPosition: `${x}% ${y}%` }} />
    </div>
  )
}

export const STAR = (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
    <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8z" />
  </svg>
)

export function Tags({ video }: { video: Pick<VideoDto, "type" | "artists" | "song" | "songSuggested"> }) {
  const artists = video.artists.filter((a) => !a.suggested)
  const shown = artists.slice(0, 2)
  return (
    <div class="tags">
      <span class={`tag type-${video.type}`}>{video.type}</span>
      {shown.map((a) => (
        <span key={a.id} class="tag" style={{ "--c": `var(--t${artistSlot(a.name)})` }}>
          {a.name}
        </span>
      ))}
      {artists.length > shown.length && <span class="tag more">+{artists.length - shown.length}</span>}
    </div>
  )
}

interface CardProps {
  tileKey: string
  zone: string
  onOpen: () => void
  class?: string
  children: ComponentChildren
}

function Card({ tileKey, zone, onOpen, class: cls, children }: CardProps) {
  return (
    <div class={`card${cls ? ` ${cls}` : ""}`} tabIndex={-1} data-item="" data-key={tileKey} data-zone={zone} onClick={onOpen}>
      {children}
    </div>
  )
}

function ResumeLine({ video }: { video: Pick<VideoDto, "resumeS" | "durationS"> }) {
  if (!video.resumeS || !video.durationS) return null
  return <i class="prog" style={{ width: `${Math.min(100, (video.resumeS / video.durationS) * 100)}%` }} />
}

export function VideoCard({ tileKey, zone, video, onOpen }: { tileKey: string; zone: string; video: VideoDto; onOpen: () => void }) {
  return (
    <Card tileKey={tileKey} zone={zone} onOpen={onOpen}>
      <Poster video={video}>
        {video.durationS != null && <span class="dur">{fmtDuration(video.durationS)}</span>}
        {video.favoritedAt && <span class="fav">{STAR}</span>}
        <ResumeLine video={video} />
      </Poster>
      <div class="ttl">{video.title}</div>
      <Tags video={video} />
    </Card>
  )
}

export function ChapterCard({ tileKey, zone, video, chapter, onOpen }: { tileKey: string; zone: string; video: VideoDto; chapter: ChapterDto; onOpen: () => void }) {
  return (
    <Card tileKey={tileKey} zone={zone} onOpen={onOpen} class="chapter">
      <div class="pw">
        <StripFrame video={video} t={chapter.startS} />
        <span class="dur">{fmtDuration(chapter.startS)}</span>
        <span class="fav">{STAR}</span>
        <span class="kind">chapter</span>
      </div>
      <div class="ttl">{chapter.title}</div>
      <div class="sub">{video.title}</div>
    </Card>
  )
}

export function ArtistCard({ tileKey, zone, artist, onOpen }: { tileKey: string; zone: string; artist: ArtistDto; onOpen: () => void }) {
  const poster = artist.posterVideoId
  return (
    <Card tileKey={tileKey} zone={zone} onOpen={onOpen} class="art">
      <Poster video={{ id: artist.id, thumbnail: null, available: true }} posterOf={poster ?? undefined} />
      <div class="ttl">{artist.name}</div>
      <div class="sub">
        {artist.videoCount} Video{artist.videoCount === 1 ? "" : "s"}
        {artist.local ? " · local" : ""}
        {artist.proposed ? " · proposed" : ""}
      </div>
    </Card>
  )
}

export function SongCard({ tileKey, zone, song, onOpen }: { tileKey: string; zone: string; song: SongListDto; onOpen: () => void }) {
  return (
    <Card tileKey={tileKey} zone={zone} onOpen={onOpen} class="song">
      <Poster video={{ id: song.posterVideoId ?? song.id, thumbnail: null, available: true }} posterOf={song.posterVideoId ?? undefined}>
        {song.versionCount > 0 && <span class="lyr">lyrics</span>}
      </Poster>
      <div class="ttl">
        {song.name}
        {song.englishName && <span class="en"> {song.englishName}</span>}
      </div>
      <div class="sub">
        {song.videoCount} Video{song.videoCount === 1 ? "" : "s"}
        {song.chapterCount > 0 ? ` · ${song.chapterCount} Chapter${song.chapterCount === 1 ? "" : "s"}` : ""}
      </div>
    </Card>
  )
}

export function ShuffleCard({ zone, count, onOpen }: { zone: string; count: number; onOpen: () => void }) {
  return (
    <Card tileKey="shuffle" zone={zone} onOpen={onOpen} class="more shuffle">
      <div class="po">
        <span class="glyph">⤮</span>
      </div>
      <div class="ttl">Shuffle</div>
      <div class="sub">
        {count} Video{count === 1 ? "" : "s"}
      </div>
    </Card>
  )
}

export function SeeAllCard({ tileKey, zone, label, onOpen }: { tileKey: string; zone: string; label: string; onOpen: () => void }) {
  return (
    <Card tileKey={tileKey} zone={zone} onOpen={onOpen} class="more">
      <div class="po">
        <span class="glyph">›</span>
      </div>
      <div class="ttl">{label}</div>
    </Card>
  )
}

/** One tile of any kind; `open` decides what Enter does with it. */
export function TileView({ tile, zone, open }: { tile: Tile; zone: string; open: (t: Tile) => void }) {
  const onOpen = () => open(tile)
  switch (tile.kind) {
    case "video": return <VideoCard tileKey={tile.key} zone={zone} video={tile.video} onOpen={onOpen} />
    case "chapter": return <ChapterCard tileKey={tile.key} zone={zone} video={tile.video} chapter={tile.chapter} onOpen={onOpen} />
    case "artist": return <ArtistCard tileKey={tile.key} zone={zone} artist={tile.artist} onOpen={onOpen} />
    case "song": return <SongCard tileKey={tile.key} zone={zone} song={tile.song} onOpen={onOpen} />
    case "shuffle": return <ShuffleCard zone={zone} count={tile.count} onOpen={onOpen} />
    case "all": return <SeeAllCard tileKey={tile.key} zone={zone} label={tile.label} onOpen={onOpen} />
  }
}

/** A header or pane button: a focus item with a label. */
export function Btn({ itemKey, zone, class: cls, onPress, children }: { itemKey: string; zone: string; class?: string; onPress: () => void; children: ComponentChildren }) {
  return (
    <div class={`navb${cls ? ` ${cls}` : ""}`} role="button" tabIndex={-1} data-item="" data-key={itemKey} data-zone={zone} onClick={onPress}>
      {children}
    </div>
  )
}

export function Chip({ itemKey, zone, name, value, on, onPress }: { itemKey: string; zone: string; name: string; value: string; on: boolean; onPress: () => void }) {
  return (
    <div class={`chip${on ? " on" : ""}`} role="button" tabIndex={-1} data-item="" data-key={itemKey} data-zone={zone} onClick={onPress}>
      {name}: <b>{value}</b>
    </div>
  )
}
