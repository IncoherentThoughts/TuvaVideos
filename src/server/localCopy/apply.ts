// applyShared (docs/sharing-spec.md §6.2): one batch of Shared rows into the Local copy, in one SQLite transaction.
// Sync (ticket #115) calls it with what `shared_changes_since` returned; `POST /api/cache/apply` calls it with what a
// write function returned to the browser (§4.9). The rules:
//   - every upsert is skipped when the incoming `updated_at` is not newer than the row held (the pull-vs-push guard);
//   - a Video's children (Chapters, Artist links, both rejection lists) that arrive with an applied Video replace the
//     ones held for it (the write functions bump the parent whenever a child changes); children of a skipped Video are
//     skipped; children arriving without their Video are upserted one by one under the same guard;
//   - Proposed rows deleted or elevated arrive as tombstones and leave the Local copy (§6.3);
//   - the tables `replace_whole` names arrive complete: held rows the batch lacks go (§6.2, migration 130);
//   - `archive_ids` lists every archive Song, Version, Artist, Performance and Album the caller can read: held ones
//     missing from it go (the ids-only reconcile of hard deletes, §6.3);
//   - a batch whose `shared_schema` is not this checkout's is refused whole (§6.4);
//   - afterwards each changed Video, Chapter, Artist, Song and Version is reindexed, a changed Song also reindexes its
//     Videos and Chapters, and above 200 changed rows the whole index is rebuilt once.
// Any failure rolls the whole batch back and throws; the caller's watermark stays where it was.
import type { Db } from "../db";
import { fillArtistLatin } from "../latin";
import { indexArtist, indexSong, indexVersion, rebuildSearchIndex, reindexChapter, reindexVideo } from "../search";
import type { ApplySharedResult, ArchiveIds, ReplaceWholeTable, SharedChanges, SharedTombstoneRow } from "../../shared/sharedRows";
import { SHARED_SCHEMA } from "./meta";
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
  video_exposed_songs: [["song_id"], ["artist_id"]],
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
const TOMBSTONE_TABLES = new Set(["video_proposed_songs", "video_proposed_versions", "video_proposed_artists"]);
/** The Local copy table each `replace_whole` table lands in. */
const WHOLE_TABLE: Record<ReplaceWholeTable, string> = {
  video_exposed_songs: "video_exposed_songs",
  album_tracks: "archive_track",
  album_track_artists: "archive_track_artist",
  album_artists: "archive_album_credit",
};
/** The Local copy table each `archive_ids` list reconciles. */
const IDS_TABLE: Record<keyof ArchiveIds, string> = {
  songs: "archive_song",
  song_lyrics: "archive_version",
  artists: "archive_artist",
  song_performances: "archive_performance",
  albums: "archive_album",
};

/** A table's whole content as one string, to tell whether a wholesale replace changed anything (no rebuild if not). */
function fingerprint(db: Db, table: string): string {
  return JSON.stringify(db.query(`SELECT * FROM ${table} ORDER BY 1, 2`).all().map((r) => ({ ...(r as Row), updated_at: undefined })));
}

interface Changed {
  videos: Set<string>;
  chapters: Set<string>;
  artists: Set<string>;
  songs: Set<string>;
  versions: Set<string>;
  tracks: boolean;
}

export function applyShared(db: Db, batch: SharedChanges): ApplySharedResult {
  const t0 = performance.now();
  if (batch.shared_schema != null && batch.shared_schema !== SHARED_SCHEMA) {
    throw new Error(`the batch is Shared schema ${batch.shared_schema}, this checkout speaks ${SHARED_SCHEMA}`);
  }
  const changes = batch.tables ?? {};
  const whole = new Set<ReplaceWholeTable>();
  for (const t of batch.replace_whole ?? []) {
    if (!Object.hasOwn(WHOLE_TABLE, t)) throw new Error(`replace_whole names an unknown table: ${t}`);
    if (changes[t]) whole.add(t); // a whole table that did not come is not emptied
  }
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
    // Tracks and credits have no updated_at and arrive whole at every pull: rebuild the index only if they differ.
    const trackTables = ["archive_album_credit", "archive_track", "archive_track_artist"];
    const trackRowsCame = !!(changes.album_artists || changes.album_tracks || changes.album_track_artists);
    const before = trackRowsCame ? trackTables.map((t) => fingerprint(db, t)).join("\n") : "";
    const credits = mapAlbumCredits(changes.album_artists ?? []);
    if (whole.has("album_artists")) removed += dropMissing(db, "archive_album_credit", "album_id", new Set(credits.keys()));
    for (const [albumId, rows] of credits) {
      removed += db.query("DELETE FROM archive_album_credit WHERE album_id = ?").run(albumId).changes;
      for (const r of rows) put("archive_album_credit", r, { guard: false }, ["album_id", "artist_id"]);
    }
    const tracks = (changes.album_tracks ?? []).map(mapTrack);
    if (whole.has("album_tracks")) removed += dropMissing(db, "archive_track", "id", new Set(tracks.map((t) => String(t.id))));
    for (const t of tracks) put("archive_track", t);
    const trackArtists = mapTrackArtists(changes.album_track_artists ?? []);
    if (whole.has("album_track_artists")) removed += dropMissing(db, "archive_track_artist", "track_id", new Set(trackArtists.keys()));
    for (const [trackId, rows] of trackArtists) {
      removed += db.query("DELETE FROM archive_track_artist WHERE track_id = ?").run(trackId).changes;
      for (const r of rows) put("archive_track_artist", r, { guard: false }, ["track_id", "artist_id"]);
    }
    if (trackRowsCame && trackTables.map((t) => fingerprint(db, t)).join("\n") !== before) changed.tracks = true;
    for (const p of changes.song_performances ?? []) {
      if (testSongs.has(String(p.song_id))) continue;
      put("archive_performance", mapPerformance(p));
    }

    // ---- Proposed rows and the exposure list, before the Videos that point at them
    for (const s of changes.video_proposed_songs ?? []) if (put("video_proposed_songs", s as Row)) changed.songs.add(s.id);
    for (const v of changes.video_proposed_versions ?? []) if (put("video_proposed_versions", proposedVersion(v as Row))) changed.versions.add(v.id);
    for (const a of changes.video_proposed_artists ?? []) if (put("video_proposed_artists", a as Row)) changed.artists.add(a.id);
    const exposed = changes.video_exposed_songs ?? [];
    if (whole.has("video_exposed_songs")) {
      const keep = new Set(exposed.map((e) => e.id));
      for (const h of db.query("SELECT id, song_id, artist_id FROM video_exposed_songs").all() as Row[]) {
        if (keep.has(h.id)) continue;
        db.query("DELETE FROM video_exposed_songs WHERE id = ?").run(h.id);
        removed++;
        if (h.song_id) changed.songs.add(h.song_id);
        if (h.artist_id) changed.artists.add(h.artist_id);
      }
    }
    for (const e of exposed) {
      if (!put("video_exposed_songs", e as Row)) continue;
      if (e.song_id) changed.songs.add(e.song_id);
      if (e.artist_id) changed.artists.add(e.artist_id);
    }

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
    const clashing = db.prepare("DELETE FROM shared_tombstone WHERE table_name = ? AND row_id = ? AND id <> ?");
    const tomb = db.prepare(
      `INSERT INTO shared_tombstone (id, table_name, row_id, kind, replaced_by, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET table_name = excluded.table_name, row_id = excluded.row_id, kind = excluded.kind,
         replaced_by = excluded.replaced_by, at = excluded.at`,
    );
    for (const t of batch.tombstones ?? []) {
      const table = tombstoneTable(t);
      if (!table) throw new Error(`tombstone for an unknown table: ${t.table_name}`);
      if (!t.id) throw new Error(`tombstone without an id for ${table} ${t.row_id}`);
      clashing.run(table, t.row_id, t.id);
      tomb.run(t.id, table, t.row_id, t.kind, t.replaced_by ?? null, t.at);
      seen(t.at);
      const gone = db.query(`DELETE FROM ${table} WHERE id = ?`).run(t.row_id).changes;
      tombstones++;
      if (!gone) continue;
      if (table === "video_proposed_songs") changed.songs.add(t.row_id);
      if (table === "video_proposed_versions") changed.versions.add(t.row_id);
      if (table === "video_proposed_artists") changed.artists.add(t.row_id);
    }

    // ---- the ids-only reconcile (§6.3): archive rows no longer readable, or hard-deleted, go
    for (const [key, ids] of Object.entries(batch.archive_ids ?? {}) as [keyof ArchiveIds, string[] | undefined][]) {
      const table = IDS_TABLE[key];
      if (!table) throw new Error(`archive_ids names an unknown table: ${key}`);
      if (!Array.isArray(ids)) continue;
      const keep = new Set(ids.map(String));
      for (const { id } of db.query(`SELECT id FROM ${table}`).all() as { id: string }[]) {
        if (keep.has(id)) continue;
        db.query(`DELETE FROM ${table} WHERE id = ?`).run(id);
        removed++;
        if (table === "archive_song") changed.songs.add(id);
        else if (table === "archive_version") changed.versions.add(id);
        else if (table === "archive_artist") changed.artists.add(id);
        else if (table === "archive_album") changed.tracks = true;
      }
    }

    reindex(db, changed);
  })();

  const total = changed.videos.size + changed.chapters.size + changed.artists.size + changed.songs.size + changed.versions.size;
  return {
    applied, skipped, removed, tombstones,
    watermark: batch.watermark !== undefined ? batch.watermark : watermark,
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
  return t.table_name && TOMBSTONE_TABLES.has(t.table_name) ? t.table_name : null;
}

/** Deletes the held rows of a whole table whose `key` the batch does not carry; returns how many went. */
function dropMissing(db: Db, table: string, key: string, keep: Set<string>): number {
  let n = 0;
  for (const r of db.query(`SELECT DISTINCT ${key} AS k FROM ${table}`).all() as { k: string }[]) {
    if (keep.has(String(r.k))) continue;
    n += db.query(`DELETE FROM ${table} WHERE ${key} = ?`).run(r.k).changes;
  }
  return n;
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
