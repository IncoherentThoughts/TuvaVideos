// Seeding a Local copy in tests (migration 0015's shape). A Video's columns are split between `videos` (the Shared
// columns) and `video_local` (this machine's), a Chapter's Favorite lives in `chapter_local`, Artists are archive rows
// (`archive_artist`) or this machine's (`local_artist`). Numeric ids map through the migration's deterministic
// uuids (`legacyUuid`), so a test can keep saying "Video 2" as V(2).
import type { Db } from "../../src/server/db";
import { legacyUuid, newUuid } from "../../src/server/localCopy/ids";

export const V = (n: number) => legacyUuid("video", n);
export const C = (n: number) => legacyUuid("chapter", n);
/** A Local Artist's uuid. */
export const LA = (n: number) => legacyUuid("artist", n);
/** An archive row's uuid for tests (the fixture's style). */
export const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Id = string | number;
type Row = Record<string, unknown>;
const vid = (x: Id) => (typeof x === "number" ? V(x) : x);
const cid = (x: Id) => (typeof x === "number" ? C(x) : x);

/** `video_local`'s columns; everything else of a Video row goes to `videos`. */
const VIDEO_LOCAL = new Set([
  "favorited_at", "resume_s", "last_played_at", "view_count", "loop_a_s", "loop_b_s", "thumbnail_generated_at", "thumbnail_copy_id",
  "strip_frames", "strip_columns", "strip_rows", "strip_frame_w", "strip_frame_h", "poster_hash", "pending_share", "shared",
]);

const now = () => new Date().toISOString();

function insert(db: Db, table: string, row: Row) {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  db.query(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(keys.map((k) => row[k]) as any[]));
}

/** Inserts a Video (and its `video_local` row). Returns its uuid. */
export function insertVideo(db: Db, row: Row & { id?: Id; title: string }): string {
  const id = row.id == null ? newUuid() : vid(row.id as Id);
  const shared: Row = { created_at: now(), updated_at: now() };
  const local: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "id") continue;
    (VIDEO_LOCAL.has(k) ? local : shared)[k] = v;
  }
  insert(db, "videos", { id, ...shared });
  insert(db, "video_local", { video_id: id, ...local });
  return id;
}

/** Updates a Video's columns wherever they live. */
export function updateVideo(db: Db, id: Id, cols: Row) {
  const v = vid(id);
  const shared = Object.entries(cols).filter(([k]) => !VIDEO_LOCAL.has(k));
  const local = Object.entries(cols).filter(([k]) => VIDEO_LOCAL.has(k));
  if (shared.length) db.query(`UPDATE videos SET ${shared.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(shared.map(([, x]) => x) as any[]), v);
  if (local.length) {
    db.query("INSERT OR IGNORE INTO video_local (video_id) VALUES (?)").run(v);
    db.query(`UPDATE video_local SET ${local.map(([k]) => `${k} = ?`).join(", ")} WHERE video_id = ?`).run(...(local.map(([, x]) => x) as any[]), v);
  }
}

/** Inserts a Chapter (`favorited_at` goes to `chapter_local`). Returns its uuid. */
export function insertChapter(db: Db, row: Row & { id?: Id; video_id: Id; start_s: number }): string {
  const id = row.id == null ? newUuid() : cid(row.id as Id);
  const { favorited_at, id: _, video_id, ...rest } = row;
  insert(db, "video_chapters", { id, video_id: vid(video_id), title: "", source: "manual", updated_at: now(), ...rest });
  if (favorited_at) insert(db, "chapter_local", { chapter_id: id, favorited_at });
  return id;
}

/** An archive Artist (`archive_artist`), with an optional derived Latin name. */
export function insertArchiveArtist(db: Db, row: { id: string; name: string; name_latin?: string | null; is_hidden?: number; is_various_artists?: number }) {
  insert(db, "archive_artist", { id: row.id, name: row.name, is_hidden: row.is_hidden ?? 0, is_various_artists: row.is_various_artists ?? 0 });
  if (row.name_latin) insert(db, "artist_latin", { artist_id: row.id, name_latin: row.name_latin, name_latin_source: "table" });
  return row.id;
}

/** A Local Artist (`local_artist`). Numeric ids map to LA(n). */
export function insertLocalArtist(db: Db, row: { id?: Id; name: string; name_latin?: string | null }) {
  const id = row.id == null ? newUuid() : typeof row.id === "number" ? LA(row.id) : row.id;
  insert(db, "local_artist", { id, name: row.name, created_at: now() });
  if (row.name_latin) insert(db, "artist_latin", { artist_id: id, name_latin: row.name_latin, name_latin_source: "table" });
  return id;
}

/** Links an Artist (archive or local, by uuid) to a Video. */
export function linkArtist(db: Db, videoId: Id, artistId: string, position: number, suggested = 0) {
  insert(db, "video_artists", { id: newUuid(), video_id: vid(videoId), artist_id: artistId, position, suggested, updated_at: now() });
}

/** Inserts a Copy. Returns its integer id. */
export function insertCopy(db: Db, row: Row & { video_id: Id; root_id: number; rel_path: string }): number {
  const r = { size: 1, mtime: now(), playback: "native", ...row, video_id: vid(row.video_id) };
  const keys = Object.keys(r).filter((k) => (r as Row)[k] !== undefined);
  return Number(db.query(`INSERT INTO copy (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(keys.map((k) => (r as Row)[k]) as any[])).lastInsertRowid);
}

/** A rejected Chapter suggestion's tombstone (`video_chapter_rejections`). */
export function insertChapterRejection(db: Db, row: { video_id: Id; source: string; start_s: number; rejected_at?: string }) {
  insert(db, "video_chapter_rejections", { id: newUuid(), video_id: vid(row.video_id), source: row.source, start_s: row.start_s, rejected_at: row.rejected_at, updated_at: now() });
}
