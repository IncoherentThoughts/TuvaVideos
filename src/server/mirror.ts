// Mirror import (spec 2.4, ADR-0001, docs/research/mirror-import-mapping.md). `mapBackup` is pure (parsed JSON tables in,
// Mirror rows out); `importMirror` reads a backup directory and does the one-transaction wipe-and-replace.
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Db } from "./db";
import { parseFootnotes } from "../shared/lyrics/scripts";
import { isRichText } from "../shared/lyrics/richText";

/** "Various Artists": the sentinel Artist. `is_various_artists` is derived from this id, never from the name. */
export const VARIOUS_ARTISTS_ID = "b33e4b80-8951-4600-8d1e-031e7fe84ee9";

export class BackupError extends Error {}

type Row = Record<string, any>;
export type RawBackup = Record<string, Row[]>;

/** The backup tables the import reads. `album_track_artists` is required: its absence means a pre-126 backup. */
const TABLES = ["songs", "song_lyrics", "artists", "albums", "album_artists", "album_tracks", "album_track_artists", "song_performances"] as const;

export const MIRROR_TABLES = [
  "mirror_song", "mirror_version", "mirror_artist", "mirror_album", "mirror_album_credit", "mirror_track", "mirror_track_artist", "mirror_performance",
] as const;

export interface MappedBackup {
  mirror_artist: Row[];
  mirror_album: Row[];
  mirror_album_credit: Row[];
  mirror_song: Row[];
  mirror_version: Row[];
  mirror_track: Row[];
  mirror_track_artist: Row[];
  mirror_performance: Row[];
  /** What was dropped and why, for the import log. */
  skipped: { testSongs: number; versionsOfSkipped: number; performancesOfSkipped: number; tracksUnlinked: number; plainTextScripts: number };
  hiddenSongs: number;
}

// ---------------------------------------------------------------------------------------------------------------
// YouTube ids and offsets from a Performance URL
// ---------------------------------------------------------------------------------------------------------------

const YT_RE = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|watch\/|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;

/** `t=` or `start=` as seconds: `112`, `112s`, `1h2m3s`. */
export function parseOffset(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i.exec(raw);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** The YouTube id and start offset a Performance URL carries; both null for any other host or a missing URL. */
export function parsePerformanceUrl(url: string | null | undefined): { youtubeId: string | null; startS: number | null } {
  const m = url ? YT_RE.exec(url) : null;
  if (!m) return { youtubeId: null, startS: null };
  const t = /[?&#](?:t|start)=([^&#\s]+)/.exec(url!);
  return { youtubeId: m[1]!, startS: t ? parseOffset(t[1]!) : null };
}

// ---------------------------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------------------------

const clean = (s: unknown): string | null => {
  if (s == null) return null;
  const t = String(s).replace(/[​﻿]/g, "").trim(); // trim also covers U+2028 / U+2029
  return t === "" ? null : t;
};
const bool = (v: unknown) => (v ? 1 : 0);
const byCreated = (a: Row, b: Row) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));

export function mapBackup(raw: RawBackup): MappedBackup {
  const rows = (t: string) => raw[t] ?? [];
  const skipped = { testSongs: 0, versionsOfSkipped: 0, performancesOfSkipped: 0, tracksUnlinked: 0, plainTextScripts: 0 };

  // Hidden Songs are kept with `is_hidden` (they hold a third of the Performance ids); only the archive's test rows
  // (slug `zz_…`, hidden) are dropped with everything that belongs to them.
  const hidden = new Set<string>();
  let hiddenSongs = 0;
  const mirror_song: Row[] = [];
  for (const s of rows("songs")) {
    if (s.is_hidden && (/^zz_/i.test(String(s.slug ?? "")) || /^zz_/i.test(String(s.name ?? "")))) {
      hidden.add(s.id);
      skipped.testSongs++;
      continue;
    }
    if (s.is_hidden) hiddenSongs++;
    mirror_song.push({
      id: s.id, name: clean(s.name) ?? s.slug, slug: s.slug, english_name: clean(s.english_name), alternate_titles: clean(s.alternate_titles),
      alternate_spellings: clean(s.alternate_spellings), country: clean(s.country), notes: clean(s.notes), is_hidden: bool(s.is_hidden),
    });
  }
  const songIds = new Set(mirror_song.map((s) => s.id));

  const mirror_version: Row[] = [];
  for (const v of [...rows("song_lyrics")].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))) {
    if (hidden.has(v.song_id) || !songIds.has(v.song_id)) {
      skipped.versionsOfSkipped++;
      continue;
    }
    const text = (x: unknown) => {
      const t = typeof x === "string" && x.trim() !== "" ? x : null;
      if (t && !isRichText(t)) skipped.plainTextScripts++; // the archive's CHECK forbids it; counted, still imported
      return t;
    };
    mirror_version.push({
      id: v.id, song_id: v.song_id, label: clean(v.version_label) ?? "Complete", display_order: v.display_order ?? 0,
      cyrillic: text(v.lyrics_cyrillic), transliteration: text(v.lyrics_transliteration), translation: text(v.lyrics_translation),
      footnotes_cyrillic: JSON.stringify(parseFootnotes(v.footnotes_cyrillic)),
      footnotes_transliteration: JSON.stringify(parseFootnotes(v.footnotes_transliteration)),
      footnotes_translation: JSON.stringify(parseFootnotes(v.footnotes_translation)),
    });
  }
  const versionIds = new Set(mirror_version.map((v) => v.id));

  const mirror_artist: Row[] = rows("artists").map((a) => ({
    id: a.id, name: clean(a.name) ?? "(unnamed)", is_hidden: bool(a.is_hidden), is_various_artists: bool(a.id === VARIOUS_ARTISTS_ID),
    country: clean(a.country), bio: a.id === VARIOUS_ARTISTS_ID ? null : clean(a.bio), picture_url: clean(a.profile_picture_url), picture_file: null,
  }));

  const mirror_album: Row[] = rows("albums").map((a) => ({
    id: a.id, name: clean(a.name) ?? "(untitled)", artist_id: a.artist_id, release_year: a.release_year ?? null,
    cover_url: clean(a.cover_image_url), cover_file: null, notes: clean(a.notes),
  }));
  const albumIds = new Set(mirror_album.map((a) => a.id));

  const mirror_album_credit: Row[] = [];
  const creditPos = new Map<string, number>();
  for (const c of [...rows("album_artists")].sort(byCreated)) {
    if (!albumIds.has(c.album_id) || !c.artist_id) continue;
    const pos = creditPos.get(c.album_id) ?? 0;
    creditPos.set(c.album_id, pos + 1);
    mirror_album_credit.push({ album_id: c.album_id, artist_id: c.artist_id, position: pos });
  }

  const mirror_track: Row[] = rows("album_tracks")
    .filter((t) => albumIds.has(t.album_id))
    .map((t) => {
      const linked = t.song_id && songIds.has(t.song_id);
      if (t.song_id && !linked) skipped.tracksUnlinked++; // a dropped Song's Track stays on its Album, unlinked
      return {
        id: t.id, album_id: t.album_id, track_number: t.track_number, name: clean(t.name) ?? "(untitled)", duration_s: t.duration ?? null,
        song_id: linked ? t.song_id : null, version_id: linked && t.track_version_id && versionIds.has(t.track_version_id) ? t.track_version_id : null,
      };
    });
  const trackIds = new Set(mirror_track.map((t) => t.id));

  // Track artists: positions are renumbered 0..n-1 per Track (the source has several at position 0 in principle).
  const mirror_track_artist: Row[] = [];
  const taPos = new Map<string, number>();
  const seenTA = new Set<string>();
  for (const r of [...rows("album_track_artists")].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || byCreated(a, b))) {
    const key = `${r.album_track_id}\0${r.artist_id}`;
    if (!trackIds.has(r.album_track_id) || !r.artist_id || seenTA.has(key)) continue;
    seenTA.add(key);
    const pos = taPos.get(r.album_track_id) ?? 0;
    taPos.set(r.album_track_id, pos + 1);
    mirror_track_artist.push({ track_id: r.album_track_id, artist_id: r.artist_id, position: pos });
  }

  const mirror_performance: Row[] = [];
  for (const p of [...rows("song_performances")].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))) {
    if (!songIds.has(p.song_id)) {
      skipped.performancesOfSkipped++;
      continue;
    }
    const url = clean(p.url);
    const { youtubeId, startS } = parsePerformanceUrl(url);
    mirror_performance.push({
      id: p.id, song_id: p.song_id, description: clean(p.description), url, display_order: p.display_order ?? 0,
      is_highlighted: bool(p.is_highlighted), youtube_id: youtubeId, start_s: startS,
    });
  }

  return { mirror_artist, mirror_album, mirror_album_credit, mirror_song, mirror_version, mirror_track, mirror_track_artist, mirror_performance, skipped, hiddenSongs };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a backup directory
// ---------------------------------------------------------------------------------------------------------------

/** Reads the tables the import needs. A backup that predates migration 126 is refused with a message that says so. */
export function readBackup(dir: string): RawBackup {
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new BackupError(`backup directory not found: ${abs}`);
  const need = (t: string) => {
    const p = join(abs, `${t}.json`);
    if (!existsSync(p)) {
      if (t === "album_track_artists")
        throw new BackupError(
          `${basename(abs)} predates archive migration 126 (no album_track_artists.json). Only post-126 backups are supported, ` +
            `and the 2026-10-07 backup or newer is expected. Take a fresh backup of the archive and try again.`,
        );
      throw new BackupError(`${basename(abs)} is missing ${t}.json`);
    }
    try {
      const v = JSON.parse(readFileSync(p, "utf8"));
      if (!Array.isArray(v)) throw new Error("not an array");
      return v as Row[];
    } catch (e) {
      throw new BackupError(`${t}.json is not a JSON array: ${e}`);
    }
  };
  const raw: RawBackup = {};
  for (const t of TABLES) raw[t] = need(t);
  // Shape check by columns, not by date: a pre-126 albums table has band_id and no artist_id.
  if (raw.albums!.length && !("artist_id" in raw.albums![0]!))
    throw new BackupError(`${basename(abs)} predates archive migration 126 (albums have no artist_id). The 2026-10-07 backup or newer is expected.`);
  if (raw.album_artists!.length && !("artist_id" in raw.album_artists![0]!))
    throw new BackupError(`${basename(abs)} predates archive migration 126 (album_artists have no artist_id). The 2026-10-07 backup or newer is expected.`);
  return raw;
}

// ---------------------------------------------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------------------------------------------

export interface DanglingBreakdown {
  videoSong: number;
  videoVersion: number;
  chapterSong: number;
  chapterVersion: number;
  studioTrackSong: number;
  artist: number;
  total: number;
}

export function countDanglingRefs(db: Db): DanglingBreakdown {
  const n = (sql: string) => (db.query(sql).get() as { n: number }).n;
  const d = {
    videoSong: n("SELECT COUNT(*) n FROM video WHERE song_id IS NOT NULL AND song_id NOT IN (SELECT id FROM song_all)"),
    videoVersion: n("SELECT COUNT(*) n FROM video WHERE version_id IS NOT NULL AND version_id NOT IN (SELECT id FROM version_all)"),
    chapterSong: n("SELECT COUNT(*) n FROM chapter WHERE song_id IS NOT NULL AND song_id NOT IN (SELECT id FROM song_all)"),
    chapterVersion: n("SELECT COUNT(*) n FROM chapter WHERE version_id IS NOT NULL AND version_id NOT IN (SELECT id FROM version_all)"),
    studioTrackSong: n("SELECT COUNT(*) n FROM studio_track WHERE song_id NOT IN (SELECT id FROM song_all)"),
    artist: n("SELECT COUNT(*) n FROM artist WHERE mirror_id IS NOT NULL AND mirror_id NOT IN (SELECT id FROM mirror_artist)"),
    total: 0,
  };
  d.total = d.videoSong + d.videoVersion + d.chapterSong + d.chapterVersion + d.studioTrackSong + d.artist;
  return d;
}

export interface MirrorImportResult {
  importId: number;
  backupName: string;
  counts: Record<string, number>;
  dangling: DanglingBreakdown;
  skipped: MappedBackup["skipped"];
  ms: number;
}

const COLS: Record<(typeof MIRROR_TABLES)[number], string[]> = {
  mirror_song: ["id", "name", "slug", "english_name", "alternate_titles", "alternate_spellings", "country", "notes", "is_hidden"],
  mirror_version: ["id", "song_id", "label", "display_order", "cyrillic", "transliteration", "translation", "footnotes_cyrillic", "footnotes_transliteration", "footnotes_translation"],
  mirror_artist: ["id", "name", "is_hidden", "is_various_artists", "country", "bio", "picture_url", "picture_file"],
  mirror_album: ["id", "name", "artist_id", "release_year", "cover_url", "cover_file", "notes"],
  mirror_album_credit: ["album_id", "artist_id", "position"],
  mirror_track: ["id", "album_id", "track_number", "name", "duration_s", "song_id", "version_id"],
  mirror_track_artist: ["track_id", "artist_id", "position"],
  mirror_performance: ["id", "song_id", "description", "url", "display_order", "is_highlighted", "youtube_id", "start_s"],
};

/**
 * One transaction: delete every `mirror_*` row, insert the mapped set, upsert `artist` rows by `mirror_id` (the
 * Various Artists sentinel is a plain-text credit and gets no `artist` row), write the `mirror_import` row with the
 * dangling-ref count. Local tables are untouched. Throws (and rolls back) on any failure.
 */
export function importMirror(db: Db, backupDir: string, now: () => Date = () => new Date()): MirrorImportResult {
  const t0 = performance.now();
  const mapped = mapBackup(readBackup(backupDir));
  const backupName = basename(resolve(backupDir));
  let result!: MirrorImportResult;
  db.transaction(() => {
    for (const t of MIRROR_TABLES) db.exec(`DELETE FROM ${t}`);
    const counts: Record<string, number> = {};
    for (const t of MIRROR_TABLES) {
      const cols = COLS[t];
      const ins = db.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
      for (const r of mapped[t]) ins.run(...cols.map((c) => r[c] ?? null));
      counts[t] = mapped[t].length;
    }
    const up = db.prepare("INSERT INTO artist (mirror_id, name) VALUES (?, ?) ON CONFLICT(mirror_id) DO UPDATE SET name = excluded.name");
    let upserted = 0;
    for (const a of mapped.mirror_artist) {
      if (a.id === VARIOUS_ARTISTS_ID) continue;
      up.run(a.id, a.name);
      upserted++;
    }
    counts.artist_upserted = upserted;
    const dangling = countDanglingRefs(db);
    const id = Number(
      db.prepare("INSERT INTO mirror_import (backup_name, imported_at, row_counts, dangling_refs) VALUES (?, ?, ?, ?)").run(backupName, now().toISOString(), JSON.stringify(counts), dangling.total).lastInsertRowid,
    );
    result = { importId: id, backupName, counts, dangling, skipped: mapped.skipped, ms: 0 };
  })();
  result.ms = Math.round(performance.now() - t0);
  return result;
}
