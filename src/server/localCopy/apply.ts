// applyShared (docs/sharing-spec.md §6.2): one batch of Shared rows into the Local copy, in one SQLite transaction.
// Sync (ticket #115) calls it with what `shared_changes_since` returned; `POST /api/cache/apply` calls it with what a
// write function returned to the browser (§4.9). The rules:
//   - every upsert is skipped when the incoming `updated_at` is not newer than the row held (the pull-vs-push guard);
//   - a Video's children (Chapters, Artist links, both rejection lists) that arrive with an applied Video replace the
//     ones held for it (the write functions bump the parent whenever a child changes); children of a skipped Video are
//     skipped; children arriving without their Video are upserted one by one under the same guard;
//   - Proposed rows deleted or elevated arrive as tombstones and leave the Local copy (§6.3);
//   - afterwards each changed Video, Chapter, Artist, Song and Version is reindexed, a changed Song also reindexes its
//     Videos and Chapters, and above 200 changed rows the whole index is rebuilt once.
// Any failure rolls the whole batch back and throws; the caller's watermark stays where it was.
import type { Db } from "../db";
import { fillArtistLatin } from "../latin";
import { indexArtist, indexSong, indexVersion, rebuildSearchIndex, reindexChapter, reindexVideo } from "../search";
import type { ApplySharedResult, SharedChanges, SharedTombstoneRow } from "../../shared/sharedRows";
import {
  mapAlbum, mapAlbumCredits, mapArtist, mapPerformance, mapSong, mapTrack, mapTrackArtists, mapVersion, isArchiveTestSong, type Row,
} from "./archiveRows";

/** Above this many changed rows the search index is rebuilt once instead of row by row (§6.2). */
export const REBUILD_THRESHOLD = 200;

// ---------------------------------------------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------------------------------------------

/**
 * Microseconds since the epoch for an ISO or Postgres timestamp (`2026-10-17T12:34:56.123456+00:00`,
 * `2026-10-17 12:34:56.1+00`, `…Z`), or null when it cannot be read. Compares timestamps written by Postgres
 * (microseconds, offsets) with ones written here (milliseconds, Z) without string tricks.
 */
export function tsMicros(s: string | null | undefined): number | null {
  if (s == null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(String(s).trim());
  if (!m) {
    const t = Date.parse(String(s));
    return Number.isNaN(t) ? null : t * 1000;
  }
  let tz = (m[4] ?? "Z").toUpperCase();
  if (tz !== "Z") tz = /^[+-]\d{2}$/.test(tz) ? `${tz}:00` : tz.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const base = Date.parse(`${m[1]}T${m[2]!.length === 5 ? `${m[2]}:00` : m[2]}${tz}`);
  if (Number.isNaN(base)) return null;
  return base * 1000 + Number((m[3] ?? "").padEnd(6, "0").slice(0, 6));
}

/** The guard: true when the incoming row must be skipped because the held one is as new or newer. Unknown times apply. */
export function heldIsNewer(incoming: string | null | undefined, held: string | null | undefined): boolean {
  const a = tsMicros(incoming);
  const b = tsMicros(held);
  return a != null && b != null && a <= b;
}

// ---------------------------------------------------------------------------------------------------------------
// Generic upsert
// ---------------------------------------------------------------------------------------------------------------

const colCache = new WeakMap<Db, Map<string, Set<string>>>();
function columnsOf(db: Db, table: string): Set<string> {
  let byTable = colCache.get(db);
  if (!byTable) colCache.set(db, (byTable = new Map()));
  let cols = byTable.get(table);
  if (!cols) byTable.set(table, (cols = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))));
  return cols;
}

/** A Supabase value as SQLite stores it: booleans 0/1, jsonb objects and arrays as JSON text. */
export function sqlValue(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return Number(v);
  return JSON.stringify(v);
}

/** Unique keys other than the primary key, per table: a held row that holds the key under another id gives way. */
const UNIQUES: Record<string, string[][]> = {
  videos: [["youtube_id"], ["content_hash"]],
  video_chapters: [["video_id", "start_s"]],
  video_artists: [["video_id", "artist_id"], ["video_id", "proposed_artist_id"]],
  video_chapter_rejections: [["video_id", "source", "start_s"]],
  video_artist_rejections: [["video_id", "artist_id"], ["video_id", "proposed_artist_id"]],
  archive_song: [["slug"]],
  archive_version: [["song_id", "label"]],
  archive_track: [["album_id", "track_number"]],
};
/** Keys whose clash is a different identity, not a stale row: a Shared Video must be reconciled first (§2.3), never overwritten. */
const NO_GIVE_WAY = new Set(["videos"]);

interface Upserter {
  /** Writes the row unless the guard skips it. Returns "applied" | "skipped". */
  put(row: Row, opts?: { guard?: boolean }): "applied" | "skipped";
}

function upserter(db: Db, table: string, pk: string[] = ["id"]): Upserter {
  const cols = columnsOf(db, table);
  const hasUpdated = cols.has("updated_at");
  const held = hasUpdated ? db.prepare(`SELECT updated_at FROM ${table} WHERE ${pk.map((k) => `${k} = ?`).join(" AND ")}`) : null;
  return {
    put(row, opts = {}) {
      const keys = Object.keys(row).filter((k) => cols.has(k) && row[k] !== undefined);
      for (const k of pk) if (!keys.includes(k)) throw new Error(`${table}: row without ${k}`);
      if (held && opts.guard !== false) {
        const h = held.get(...pk.map((k) => sqlValue(row[k]))) as { updated_at: string | null } | null;
        if (h && heldIsNewer(row.updated_at as string | null, h.updated_at)) return "skipped";
      }
      for (const u of UNIQUES[table] ?? []) {
        if (!u.every((k) => keys.includes(k) && row[k] != null)) continue;
        const clash = db
          .query(`SELECT ${pk.join(", ")} FROM ${table} WHERE ${u.map((k) => `${k} = ?`).join(" AND ")} AND NOT (${pk.map((k) => `${k} = ?`).join(" AND ")})`)
          .get(...u.map((k) => sqlValue(row[k])), ...pk.map((k) => sqlValue(row[k]))) as Row | null;
        if (!clash) continue;
        if (NO_GIVE_WAY.has(table)) throw new Error(`${table}: ${u.join("+")} of ${row.id} is held by ${clash.id}; reconcile before applying`);
        db.query(`DELETE FROM ${table} WHERE ${pk.map((k) => `${k} = ?`).join(" AND ")}`).run(...pk.map((k) => clash[k]));
      }
      const update = keys.filter((k) => !pk.includes(k));
      db.query(
        `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})
         ON CONFLICT(${pk.join(", ")}) DO ${update.length ? `UPDATE SET ${update.map((k) => `${k} = excluded.${k}`).join(", ")}` : "NOTHING"}`,
      ).run(...keys.map((k) => sqlValue(row[k])));
      return "applied";
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The apply
// ---------------------------------------------------------------------------------------------------------------

/** The Video children: table and how a held row is matched to the batch (`id`). */
const CHILDREN = ["video_chapters", "video_artists", "video_chapter_rejections", "video_artist_rejections"] as const;
/** Proposed tables that tombstones may name. */
const TOMBSTONE_TABLES = new Set(["video_proposed_songs", "video_proposed_versions", "video_proposed_artists", "video_exposed_songs"]);

interface Changed {
  videos: Set<string>;
  chapters: Set<string>;
  artists: Set<string>;
  songs: Set<string>;
  versions: Set<string>;
  tracks: boolean;
}

export function applyShared(db: Db, changes: SharedChanges): ApplySharedResult {
  const t0 = performance.now();
  const applied: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const count = (rec: Record<string, number>, t: string) => void (rec[t] = (rec[t] ?? 0) + 1);
  const changed: Changed = { videos: new Set(), chapters: new Set(), artists: new Set(), songs: new Set(), versions: new Set(), tracks: false };
  let removed = 0;
  let tombstones = 0;
  let watermark: string | null = null;
  const seen = (ts: unknown) => {
    if (typeof ts !== "string") return;
    const a = tsMicros(ts);
    if (a != null && (watermark == null || a > tsMicros(watermark)!)) watermark = ts;
  };
  const put = (table: string, row: Row, opts?: { guard?: boolean }, pk?: string[]) => {
    seen(row.updated_at);
    const r = upserter(db, table, pk).put(row, opts);
    count(r === "applied" ? applied : skipped, table);
    return r === "applied";
  };

  db.transaction(() => {
    // ---- the archive's rows (no children rule: credits are replaced per Album / Track)
    for (const a of changes.artists ?? []) if (put("archive_artist", mapArtist(a))) changed.artists.add(String(a.id));
    const testSongs = new Set<string>();
    for (const s of changes.songs ?? []) {
      const row = mapSong(s);
      if (!row) {
        if (isArchiveTestSong(s)) testSongs.add(String(s.id));
        continue;
      }
      if (put("archive_song", row)) changed.songs.add(row.id);
    }
    for (const v of changes.song_lyrics ?? []) {
      if (testSongs.has(String(v.song_id))) continue;
      if (put("archive_version", mapVersion(v))) changed.versions.add(String(v.id));
    }
    for (const a of changes.albums ?? []) if (put("archive_album", mapAlbum(a))) changed.tracks = true;
    for (const [albumId, rows] of mapAlbumCredits(changes.album_artists ?? [])) {
      removed += db.query("DELETE FROM archive_album_credit WHERE album_id = ?").run(albumId).changes;
      for (const r of rows) put("archive_album_credit", r, { guard: false }, ["album_id", "artist_id"]);
      changed.tracks = true;
    }
    for (const t of changes.album_tracks ?? []) if (put("archive_track", mapTrack(t))) changed.tracks = true;
    for (const [trackId, rows] of mapTrackArtists(changes.album_track_artists ?? [])) {
      removed += db.query("DELETE FROM archive_track_artist WHERE track_id = ?").run(trackId).changes;
      for (const r of rows) put("archive_track_artist", r, { guard: false }, ["track_id", "artist_id"]);
      changed.tracks = true;
    }
    for (const p of changes.song_performances ?? []) {
      if (testSongs.has(String(p.song_id))) continue;
      put("archive_performance", mapPerformance(p));
    }

    // ---- Proposed rows and the exposure list, before the Videos that point at them
    for (const s of changes.video_proposed_songs ?? []) if (put("video_proposed_songs", s as Row)) changed.songs.add(s.id);
    for (const v of changes.video_proposed_versions ?? []) if (put("video_proposed_versions", proposedVersion(v as Row))) changed.versions.add(v.id);
    for (const a of changes.video_proposed_artists ?? []) if (put("video_proposed_artists", a as Row)) changed.artists.add(a.id);
    for (const e of changes.video_exposed_songs ?? []) if (put("video_exposed_songs", e as Row) && e.song_id) changed.songs.add(e.song_id);

    // ---- Videos, then their children
    const appliedVideos = new Set<string>();
    const skippedVideos = new Set<string>();
    const markShared = db.prepare("INSERT INTO video_local (video_id, shared) VALUES (?, 1) ON CONFLICT(video_id) DO UPDATE SET shared = 1");
    for (const v of changes.videos ?? []) {
      if (put("videos", v as Row)) {
        appliedVideos.add(v.id);
        markShared.run(v.id);
        changed.videos.add(v.id);
      } else skippedVideos.add(v.id);
    }
    for (const table of CHILDREN) {
      const rows = (changes[table] ?? []) as Row[];
      const byVideo = new Map<string, Row[]>();
      for (const r of rows) (byVideo.get(r.video_id) ?? byVideo.set(r.video_id, []).get(r.video_id)!).push(r);
      // A bumped parent that arrived without any rows of this table has none left.
      for (const id of appliedVideos) if (!byVideo.has(id)) byVideo.set(id, []);
      for (const [videoId, list] of byVideo) {
        if (skippedVideos.has(videoId)) {
          for (const r of list) {
            seen(r.updated_at);
            count(skipped, table);
          }
          continue;
        }
        const replace = appliedVideos.has(videoId);
        if (replace) {
          const keep = new Set(list.map((r) => String(r.id)));
          const held = db.query(`SELECT id FROM ${table} WHERE video_id = ?`).all(videoId) as { id: string }[];
          for (const h of held) {
            if (keep.has(h.id)) continue;
            db.query(`DELETE FROM ${table} WHERE id = ?`).run(h.id);
            removed++;
            if (table === "video_chapters") changed.chapters.add(h.id);
          }
        }
        for (const r of list) {
          if (put(table, r, { guard: !replace })) {
            if (table === "video_chapters") changed.chapters.add(String(r.id));
            else changed.videos.add(videoId); // an Artist link's names are part of the Video's facts
          }
        }
      }
    }
    for (const h of changes.video_edit_history ?? []) put("video_edit_history", h as Row);

    // ---- tombstones (§6.3)
    const tomb = db.prepare(
      "INSERT INTO shared_tombstone (table_name, row_id, kind, at) VALUES (?, ?, ?, ?) ON CONFLICT(table_name, row_id) DO UPDATE SET kind = excluded.kind, at = excluded.at",
    );
    for (const t of changes.tombstones ?? []) {
      const table = tombstoneTable(t);
      if (!table) throw new Error(`tombstone for an unknown table: ${t.table_name ?? t.table}`);
      tomb.run(table, t.row_id, t.kind, t.at);
      const gone = db.query(`DELETE FROM ${table} WHERE id = ?`).run(t.row_id).changes;
      tombstones++;
      if (!gone) continue;
      if (table === "video_proposed_songs") changed.songs.add(t.row_id);
      if (table === "video_proposed_versions") changed.versions.add(t.row_id);
      if (table === "video_proposed_artists") changed.artists.add(t.row_id);
    }

    reindex(db, changed);
  })();

  const total = changed.videos.size + changed.chapters.size + changed.artists.size + changed.songs.size + changed.versions.size;
  return {
    applied, skipped, removed, tombstones, watermark,
    reindex: total > REBUILD_THRESHOLD || changed.tracks ? "rebuild" : total ? "rows" : "none",
    ms: Math.round(performance.now() - t0),
  };
}

/** Footnotes arrive as jsonb (arrays) or not at all; the Local copy holds JSON text, `[]` when there are none. */
function proposedVersion(v: Row): Row {
  const out = { ...v };
  for (const k of ["footnotes_cyrillic", "footnotes_transliteration", "footnotes_translation"]) if (k in out && out[k] == null) out[k] = "[]";
  return out;
}

function tombstoneTable(t: SharedTombstoneRow): string | null {
  const name = t.table_name ?? t.table;
  return name && TOMBSTONE_TABLES.has(name) ? name : null;
}

/** §6.2 indexing: per row, a changed Song also reindexing its Videos and Chapters; above the threshold one rebuild. */
function reindex(db: Db, c: Changed) {
  const total = c.videos.size + c.chapters.size + c.artists.size + c.songs.size + c.versions.size;
  if (!total && !c.tracks) return;
  if (c.artists.size) fillArtistLatin(db, total > REBUILD_THRESHOLD ? undefined : [...c.artists]);
  if (total > REBUILD_THRESHOLD || c.tracks) {
    rebuildSearchIndex(db);
    return;
  }
  for (const s of c.songs) {
    indexSong(db, s);
    for (const v of db.query("SELECT id FROM video_full WHERE song_id = ?").all(s) as { id: string }[]) c.videos.add(v.id);
    for (const ch of db.query("SELECT id FROM chapter_full WHERE song_id = ?").all(s) as { id: string }[]) c.chapters.add(ch.id);
  }
  for (const v of c.versions) indexVersion(db, v);
  for (const a of c.artists) indexArtist(db, a);
  const deletedChapters = db.prepare("SELECT c.id FROM video_chapters c JOIN videos v ON v.id = c.video_id WHERE v.id = ? AND v.deleted_at IS NOT NULL");
  for (const v of c.videos) {
    reindexVideo(db, v); // a soft-deleted Video leaves the index, with its Chapters
    for (const ch of deletedChapters.all(v) as { id: string }[]) c.chapters.add(ch.id);
  }
  for (const ch of c.chapters) reindexChapter(db, ch);
}
