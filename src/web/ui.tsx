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

/** Quality of a frame size, by its short side (a 1080x1920 portrait Video is 1080p, as YouTube labels it); `tier` picks the tag colour. */
export function quality(width: number | null | undefined, height: number | null | undefined): { label: string; tier: "uhd" | "fhd" | "hd" | "sd" | "low" } | null {
  const side = width && height ? Math.min(width, height) : height;
  if (!side) return null;
  if (side >= 2000) return { label: "4K", tier: "uhd" };
  const tier = side >= 1000 ? "fhd" : side >= 700 ? "hd" : side >= 460 ? "sd" : "low";
  return { label: `${side}p`, tier };
}

/** The small second row under a card's Tags: quality, and the Copy count when there is more than one. */
export function SpecTags({ video }: { video: Pick<VideoDto, "width" | "height" | "copies"> }) {
  const q = quality(video.width, video.height);
  const n = video.copies.length;
  if (!q && n < 2) return null;
  return (
    <div class="tags spec">
      {q && <span class={`tag q-${q.tier}`} title={video.width && video.height ? `${video.width}×${video.height}` : undefined}>{q.label}</span>}
      {n > 1 && <span class="tag copies">{n} copies</span>}
    </div>
  );
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
      <span class="nm">{artist.name}</span>
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
      <span class="nm">{s.name ?? "unknown song"}</span>
      {video.songSuggested && <i class="sugmark">suggested</i>}
    </span>
  );
}

/** Type, Song and Artist tags. At most `maxArtists` confirmed Artist tags (3 by default, on every list screen); the rest
 *  fold into one "+n" tag whose hover names them. Suggested Artists (the server lists them after the confirmed ones) get
 *  the same treatment with their own, tighter cap: at most `maxSuggested` shown, the rest fold into a dashed "+n suggested"
 *  tag. Now playing's header shows every Artist through its own chip editor. */
export const MAX_ARTIST_TAGS = 3;
export const MAX_SUGGESTED_ARTIST_TAGS = 1;
export function Tags({ video, maxArtists = MAX_ARTIST_TAGS, maxSuggested = MAX_SUGGESTED_ARTIST_TAGS }: {
  video: Pick<VideoDto, "type" | "artists" | "song" | "songSuggested">; maxArtists?: number; maxSuggested?: number;
}) {
  const confirmed = video.artists.filter((a) => !a.suggested);
  const suggested = video.artists.filter((a) => a.suggested);
  const shown = confirmed.slice(0, maxArtists);
  const rest = confirmed.slice(maxArtists);
  const shownSug = suggested.slice(0, maxSuggested);
  const restSug = suggested.slice(maxSuggested);
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
      {shownSug.map((a) => (
        <ArtistTag key={a.id} artist={a} />
      ))}
      {restSug.length > 0 && (
        <span class="tag more sug" title={`Suggested Artists (from the title): ${restSug.map((a) => a.name).join(", ")} — confirm them on Now playing`}>
          +{restSug.length}
          <i class="sugmark">suggested</i>
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

/** §7.1: the one small download mark in a Not on this machine card's corner. */
export function NotHereMark() {
  return (
    <span class="nothere-mark" title="Not on this machine" aria-label="Not on this machine">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v12" />
        <path d="M7 10l5 5 5-5" />
        <path d="M4 21h16" />
      </svg>
    </span>
  );
}

/** A placeholder tint from a Video id: its last 8 hex digits (a legacy id keeps its old integer's tint). */
export const phColor = (id: string) => `var(--t${((parseInt(id.slice(-8), 16) || 0) % 8) + 1})`;

/** Poster for a Video; a tinted placeholder when no Thumbnail has been generated or it fails to load. */
export function Poster({ video, dur }: { video: Pick<VideoDto, "id" | "thumbnail" | "available" | "durationS">; dur?: boolean }) {
  const [failed, setFailed] = useState(false);
  const has = !!video.thumbnail && !failed;
  return (
    <div class={`thumb${has ? "" : " ph"}${video.available ? "" : " unavail"}`} style={has ? undefined : { "--ph": phColor(video.id) }}>
      {has && <img src={video.thumbnail!.poster} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
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
