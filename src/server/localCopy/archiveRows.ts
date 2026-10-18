// The archive's own rows as the Local copy holds them (docs/sharing-spec.md §6.1, ADR 0009). Sync and the cache apply
// hand over rows in the archive's Supabase shape (`songs`, `song_lyrics`, `artists`, ...); these pure mappers turn one
// into its `archive_*` row. The rules are the retired Mirror import's (docs/research/mirror-import-mapping.md), row by
// row: names trimmed of zero-width junk, Footnotes as JSON, Performance URLs parsed for a YouTube or Rutube id.
import { parseFootnotes } from "../../shared/lyrics/scripts";

/** "Various Artists": the sentinel Artist. `is_various_artists` is derived from this id, never from the name. */
export const VARIOUS_ARTISTS_ID = "b33e4b80-8951-4600-8d1e-031e7fe84ee9";

export type Row = Record<string, any>;

// ---------------------------------------------------------------------------------------------------------------
// YouTube and Rutube ids and offsets from a Performance URL
// ---------------------------------------------------------------------------------------------------------------

const YT_RE = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|watch\/|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;
const RT_RE = /rutube\.ru\/(?:video\/|play\/embed\/|shorts\/|video\/private\/)([0-9a-fA-F]{32})(?![0-9a-fA-F])/;

/** `t=` or `start=` as seconds: `112`, `112s`, `1h2m3s`. */
export function parseOffset(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i.exec(raw);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export interface PerformanceIds {
  youtubeId: string | null;
  /** The 32-hex id of a rutube.ru video URL, lowercased (§4.3). */
  rutubeId: string | null;
  startS: number | null;
}

/** The YouTube or Rutube id and start offset a Performance URL carries; all null for any other host or no URL. */
export function parsePerformanceUrl(url: string | null | undefined): PerformanceIds {
  const none = { youtubeId: null, rutubeId: null, startS: null };
  if (!url) return none;
  const yt = YT_RE.exec(url);
  const rt = yt ? null : RT_RE.exec(url);
  if (!yt && !rt) return none;
  const t = /[?&#](?:t|start)=([^&#\s]+)/.exec(url);
  return { youtubeId: yt ? yt[1]! : null, rutubeId: rt ? rt[1]!.toLowerCase() : null, startS: t ? parseOffset(t[1]!) : null };
}

// ---------------------------------------------------------------------------------------------------------------
// Row mappers: one archive row in, one `archive_*` row out (null = not held here)
// ---------------------------------------------------------------------------------------------------------------

export const clean = (s: unknown): string | null => {
  if (s == null) return null;
  const t = String(s).replace(/[​﻿]/g, "").trim(); // trim also covers U+2028 / U+2029
  return t === "" ? null : t;
};
const bool = (v: unknown) => (v ? 1 : 0);
const ts = (v: unknown): string | null => (v == null ? null : String(v));

/** The archive's own test rows (slug or name `zz_…`, hidden) are never held, nor anything that belongs to them. */
export const isArchiveTestSong = (s: Row) => !!s.is_hidden && (/^zz_/i.test(String(s.slug ?? "")) || /^zz_/i.test(String(s.name ?? "")));

export function mapSong(s: Row): Row | null {
  if (isArchiveTestSong(s)) return null;
  return {
    id: s.id, name: clean(s.name) ?? s.slug, slug: s.slug ?? s.id, english_name: clean(s.english_name), alternate_titles: clean(s.alternate_titles),
    alternate_spellings: clean(s.alternate_spellings), country: clean(s.country), notes: clean(s.notes), is_hidden: bool(s.is_hidden),
    updated_at: ts(s.updated_at),
  };
}

const text = (x: unknown) => (typeof x === "string" && x.trim() !== "" ? x : null);

export function mapVersion(v: Row): Row {
  return {
    id: v.id, song_id: v.song_id, label: clean(v.version_label) ?? "Complete", display_order: v.display_order ?? 0,
    cyrillic: text(v.lyrics_cyrillic), transliteration: text(v.lyrics_transliteration), translation: text(v.lyrics_translation),
    footnotes_cyrillic: JSON.stringify(parseFootnotes(v.footnotes_cyrillic)),
    footnotes_transliteration: JSON.stringify(parseFootnotes(v.footnotes_transliteration)),
    footnotes_translation: JSON.stringify(parseFootnotes(v.footnotes_translation)),
    updated_at: ts(v.updated_at),
  };
}

export function mapArtist(a: Row): Row {
  const va = a.id === VARIOUS_ARTISTS_ID;
  return {
    id: a.id, name: clean(a.name) ?? "(unnamed)", is_hidden: bool(a.is_hidden), is_various_artists: bool(va),
    country: clean(a.country), bio: va ? null : clean(a.bio), picture_url: clean(a.profile_picture_url ?? a.picture_url), picture_file: null,
    updated_at: ts(a.updated_at),
  };
}

export function mapAlbum(a: Row): Row {
  return {
    id: a.id, name: clean(a.name) ?? "(untitled)", artist_id: a.artist_id, release_year: a.release_year ?? null,
    cover_url: clean(a.cover_image_url ?? a.cover_url), cover_file: null, notes: clean(a.notes), updated_at: ts(a.updated_at),
  };
}

export function mapTrack(t: Row): Row {
  return {
    id: t.id, album_id: t.album_id, track_number: t.track_number, name: clean(t.name) ?? "(untitled)", duration_s: t.duration ?? t.duration_s ?? null,
    song_id: t.song_id ?? null, version_id: t.song_id ? (t.track_version_id ?? t.version_id ?? null) : null, updated_at: ts(t.updated_at),
  };
}

export function mapPerformance(p: Row): Row {
  const url = clean(p.url);
  const { youtubeId, rutubeId, startS } = parsePerformanceUrl(url);
  return {
    id: p.id, song_id: p.song_id, description: clean(p.description), url, display_order: p.display_order ?? 0,
    is_highlighted: bool(p.is_highlighted), youtube_id: youtubeId, rutube_id: rutubeId, start_s: startS, updated_at: ts(p.updated_at),
  };
}

const byCreated = (a: Row, b: Row) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));

/** An Album's additional Credits (`album_artists`), positions 0..n-1 in creation order. Grouped by Album. */
export function mapAlbumCredits(rows: Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const c of [...rows].sort(byCreated)) {
    if (!c.album_id || !c.artist_id) continue;
    const list = out.get(c.album_id) ?? out.set(c.album_id, []).get(c.album_id)!;
    if (list.some((x) => x.artist_id === c.artist_id)) continue;
    list.push({ album_id: c.album_id, artist_id: c.artist_id, position: list.length, updated_at: ts(c.updated_at) });
  }
  return out;
}

/** A Track's Artists (`album_track_artists`), renumbered 0..n-1 by position then creation, duplicates dropped. Grouped by Track. */
export function mapTrackArtists(rows: Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of [...rows].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || byCreated(a, b))) {
    const track = r.album_track_id ?? r.track_id;
    if (!track || !r.artist_id) continue;
    const list = out.get(track) ?? out.set(track, []).get(track)!;
    if (list.some((x) => x.artist_id === r.artist_id)) continue;
    list.push({ track_id: track, artist_id: r.artist_id, position: list.length, updated_at: ts(r.updated_at) });
  }
  return out;
}
