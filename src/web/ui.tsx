// Shared presentational pieces: Tag, AvailabilityIcon, FavoriteBadge, Thumbnail (poster / strip frame).
import { useState } from "preact/hooks";
import type { ArtistRef, VideoDto } from "../shared/types";
import { tileForTime } from "../server/stripGeometry";

export function fmtDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "";
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function resolutionLabel(height: number | null | undefined): string {
  if (!height) return "";
  if (height >= 2000) return "4K";
  return `${height}p`;
}

/** Artists hash to a tag slot (t1..t8). */
export function artistSlot(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return (h % 8) + 1;
}

export function TypeTag({ type, suggested }: { type: string; suggested?: boolean }) {
  return <span class={`tag type-${type}${suggested ? " sug" : ""}`}>{type}</span>;
}

export function artistTitle(artist: ArtistRef): string | undefined {
  return artist.suggested ? "Suggested Artist (from the title): confirm it on Now playing" : artist.local ? "Local Artist" : undefined;
}

export function ArtistTag({ artist }: { artist: ArtistRef }) {
  return (
    <span class={`tag${artist.suggested ? " sug" : ""}`} style={{ "--c": `var(--t${artistSlot(artist.name)})` }} title={artistTitle(artist)}>
      {artist.name}
      {artist.suggested && <i class="sugmark">suggested</i>}
    </span>
  );
}

/** The linked Song as a tag; dashed with a "suggested" mark while the link is only Suggested. */
export function SongTag({ video }: { video: Pick<VideoDto, "song" | "songSuggested"> }) {
  const s = video.song;
  if (!s) return null;
  return (
    <span class={`tag song${video.songSuggested ? " sug" : ""}`} title={video.songSuggested ? `Suggested Song: ${s.name ?? "unknown"} (confirm it on Now playing)` : `Song: ${s.name ?? "unknown"}`}>
      {s.name ?? "unknown song"}
      {video.songSuggested && <i class="sugmark">suggested</i>}
    </span>
  );
}

/** Type, Song and Artist tags. At most `maxArtists` Artist tags (3 by default, on every list screen); the rest fold into
 *  one "+n" tag whose hover names them. Now playing's header shows every Artist through its own chip editor. */
export const MAX_ARTIST_TAGS = 3;
export function Tags({ video, maxArtists = MAX_ARTIST_TAGS }: { video: Pick<VideoDto, "type" | "artists" | "song" | "songSuggested">; maxArtists?: number }) {
  const cap = video.artists.length > maxArtists;
  const shown = cap ? video.artists.slice(0, maxArtists) : video.artists;
  const rest = cap ? video.artists.slice(maxArtists) : [];
  return (
    <div class="tags">
      <TypeTag type={video.type} />
      <SongTag video={video} />
      {shown.map((a) => (
        <ArtistTag key={a.id} artist={a} />
      ))}
      {rest.length > 0 && (
        <span class="tag more" title={rest.map((a) => a.name).join(", ")}>
          +{rest.length}
        </span>
      )}
    </div>
  );
}

export const TRASH = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M6 6l1 14h10l1-14" />
    <path d="M10 10v6M14 10v6" />
  </svg>
);

const STAR = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
    <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8z" />
  </svg>
);
const LAPTOP = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="5" width="18" height="12" rx="2" />
    <path d="M1 20h22" />
  </svg>
);
const DRIVE = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M3 15h18" />
    <circle cx="17.5" cy="17.5" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

export function FavoriteBadge({ off }: { off?: boolean } = {}) {
  return (
    <span class={`fav${off ? " off" : ""}`} title={off ? "Not a Favorite" : "Favorite"}>
      {STAR}
    </span>
  );
}

export { LAPTOP as LaptopIcon, DRIVE as DriveIcon };

/** Laptop (green) for a local Copy, drive (blue) for an external one, dashed grey drive when unavailable. Icons only. */
export function AvailabilityIcon({ availability }: { availability: "local" | "external" | null }) {
  const cls = availability ?? "none";
  const title = availability === "local" ? "On this laptop" : availability === "external" ? "On the external drive" : "No Copy mounted";
  return (
    <span class={`avail ${cls}`} title={title}>
      {availability === "local" ? LAPTOP : DRIVE}
    </span>
  );
}

const phColor = (id: number) => `var(--t${(id % 8) + 1})`;

/** Poster for a Video; a tinted placeholder when no Thumbnail has been generated or it fails to load. */
export function Poster({ video, dur, edge }: { video: Pick<VideoDto, "id" | "thumbnail" | "available" | "availability" | "durationS">; dur?: boolean; edge?: boolean }) {
  const [failed, setFailed] = useState(false);
  const has = !!video.thumbnail && !failed;
  return (
    <div class={`thumb${has ? "" : " ph"}${video.available ? "" : " unavail"}`} style={has ? undefined : { "--ph": phColor(video.id) }}>
      {has && <img src={video.thumbnail!.poster} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
      {edge && <i class={`av ${video.availability ?? "none"}`} />}
      {dur && video.durationS != null && <span class="dur">{fmtDuration(video.durationS)}</span>}
    </div>
  );
}

/** The scrub-strip frame at time `t` (CSS sprite from the geometry the API reports); falls back to the poster. */
export function StripFrame({ video, t }: { video: VideoDto; t: number }) {
  const strip = video.thumbnail?.strip;
  if (!strip || !video.durationS) return <Poster video={video} />;
  const tile = tileForTime(t, video.durationS, { frames: strip.frames, columns: strip.columns, rows: strip.rows });
  const x = strip.columns > 1 ? (tile.column / (strip.columns - 1)) * 100 : 0;
  const y = strip.rows > 1 ? (tile.row / (strip.rows - 1)) * 100 : 0;
  return (
    <div class={`thumb${video.available ? "" : " unavail"}`}>
      <div
        class="frame"
        style={{ backgroundImage: `url(${strip.url})`, backgroundSize: `${strip.columns * 100}% ${strip.rows * 100}%`, backgroundPosition: `${x}% ${y}%` }}
      />
    </div>
  );
}
