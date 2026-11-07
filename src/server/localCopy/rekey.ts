// Moving this machine's rows to another id (docs/audit/02-sync-shared-data.md SYNC-1). Migration 0015 gave every
// pre-#112 integer row the same deterministic uuid on every machine (`legacyUuid`), and the owner's ids went into the
// archive with the one-time migration. On any other machine those ids name different Videos, Chapters and Local Artists,
// so an id alone is not identity: a held row that is not Shared and whose content disagrees with the incoming Shared
// row of the same id is moved out of the way (to a fresh uuid) before the Shared row lands. The owner's rows, and a
// drained insert coming back under its own id, agree in content and stay where they are.
//
// SQL only; every function runs inside the caller's transaction (foreign keys are deferred to its commit).
import type { Db } from "../db";
import { indexArtist, reindexChapter, reindexVideo } from "../search";
import type { SharedChanges } from "../../shared/sharedRows";
import { newUuid } from "./ids";

/** Every (table, column) that points at `videos(id)`, from the schema itself. */
export function videoRefs(db: Db, except: readonly string[] = []): { table: string; column: string }[] {
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  const out: { table: string; column: string }[] = [];
  for (const t of tables) {
    if (except.includes(t)) continue;
    for (const fk of db.query(`SELECT "table" AS parent, "from" AS col FROM pragma_foreign_key_list(?)`).all(t) as { parent: string; col: string }[]) {
      if (fk.parent === "videos") out.push({ table: t, column: fk.col });
    }
  }
  return out;
}

/**
 * Two Videos are the same Video when their identity keys agree (§3.2): the same YouTube id when both have one, else
 * the same content hash. Provenance (Instagram, Rutube) is not identity.
 */
export function sameIdentity(a: { youtube_id: string | null; content_hash: string | null }, b: { youtube_id: string | null; content_hash: string | null }): boolean {
  if (a.youtube_id && b.youtube_id) return a.youtube_id === b.youtube_id;
  if (a.content_hash && b.content_hash) return a.content_hash === b.content_hash;
  return false;
}

/** Marks a Video `applyPlan` re-keyed into a Shared id (its keys are freed for the apply): never moved away again. */
export const RECONCILED_HASH_PREFIX = "reconcile:";

export interface MoveOptions {
  /**
   * The caller renames the thumbnail files (`<id>.poster.webp`, `<id>.strip.webp`) after its commit
   * (`renameThumbnails`); else the thumbnail facts are cleared and the Thumbnailer makes them again.
   */
  keepThumbnails?: boolean;
}

/** Moves a Video to a new id (that no row holds): the row, every row pointing at it, its search entry. */
export function moveVideo(db: Db, from: string, to: string = newUuid(), opts: MoveOptions = {}): string {
  db.exec("PRAGMA defer_foreign_keys = ON");
  db.query("UPDATE videos SET id = ? WHERE id = ?").run(to, from);
  for (const r of videoRefs(db)) db.query(`UPDATE ${r.table} SET ${r.column} = ? WHERE ${r.column} = ?`).run(to, from);
  if (!opts.keepThumbnails) {
    db.query(`UPDATE video_local SET thumbnail_generated_at = NULL, strip_frames = NULL, strip_columns = NULL, strip_rows = NULL,
      strip_frame_w = NULL, strip_frame_h = NULL, poster_hash = NULL WHERE video_id = ?`).run(to);
  }
  reindexVideo(db, from);
  reindexVideo(db, to);
  return to;
}

/** The guard's floor: a row stamped with it loses to any incoming row. */
const EPOCH = "1970-01-01T00:00:00.000Z";
const LINK_CHILDREN = ["video_chapters", "video_artists", "video_chapter_rejections", "video_artist_rejections"];

/**
 * A held Shared Video the archive no longer has (SYNC-4: purged in the console) whose YouTube id or content hash an
 * incoming Shared Video now holds: this machine's rows (Copies, Favorite, resume point, …) join the incoming id, its
 * stale link data goes (the incoming row brings its own), and it is stamped with the epoch so the apply overwrites it.
 */
export function mergeStaleVideoInto(db: Db, from: string, to: string) {
  db.exec("PRAGMA defer_foreign_keys = ON");
  for (const t of LINK_CHILDREN) db.query(`DELETE FROM ${t} WHERE video_id = ?`).run(from);
  db.query("DELETE FROM shelved_edit WHERE video_id = ?").run(from);
  if (!db.query("SELECT 1 FROM videos WHERE id = ?").get(to)) {
    moveVideo(db, from, to);
  } else {
    // This machine's own columns join the incoming row: the Favorite and the view count add up, the Resume position
    // comes from whichever row was played last, and the A-B loop is kept when the incoming row has none.
    db.query(`UPDATE video_local AS t SET
        favorited_at = COALESCE(t.favorited_at, f.favorited_at),
        view_count = t.view_count + f.view_count,
        resume_s = CASE WHEN COALESCE(f.last_played_at, '') > COALESCE(t.last_played_at, '') THEN f.resume_s ELSE COALESCE(t.resume_s, f.resume_s) END,
        last_played_at = CASE WHEN COALESCE(f.last_played_at, '') > COALESCE(t.last_played_at, '') THEN f.last_played_at ELSE t.last_played_at END,
        loop_a_s = CASE WHEN t.loop_a_s IS NULL AND t.loop_b_s IS NULL THEN f.loop_a_s ELSE t.loop_a_s END,
        loop_b_s = CASE WHEN t.loop_a_s IS NULL AND t.loop_b_s IS NULL THEN f.loop_b_s ELSE t.loop_b_s END
      FROM (SELECT * FROM video_local WHERE video_id = ?) AS f WHERE t.video_id = ?`).run(from, to);
    for (const r of videoRefs(db, LINK_CHILDREN)) {
      db.query(`UPDATE OR IGNORE ${r.table} SET ${r.column} = ? WHERE ${r.column} = ?`).run(to, from);
      db.query(`DELETE FROM ${r.table} WHERE ${r.column} = ?`).run(from);
    }
    db.query("DELETE FROM videos WHERE id = ?").run(from);
    reindexVideo(db, from);
  }
  db.query("UPDATE videos SET updated_at = ? WHERE id = ?").run(EPOCH, to);
}

/** Moves a Chapter to a new id: the row, its star, its search entry. */
export function moveChapter(db: Db, from: string, to: string = newUuid()): string {
  db.exec("PRAGMA defer_foreign_keys = ON");
  db.query("UPDATE video_chapters SET id = ? WHERE id = ?").run(to, from);
  db.query("UPDATE chapter_local SET chapter_id = ? WHERE chapter_id = ?").run(to, from);
  reindexChapter(db, from);
  reindexChapter(db, to);
  return to;
}

/** Moves a Local Artist to a new id: the row, the links and rejections naming it, its Latin name, Shelved Artists. */
export function moveLocalArtist(db: Db, from: string, to: string = newUuid()): string {
  db.query("UPDATE local_artist SET id = ? WHERE id = ?").run(to, from);
  db.query("UPDATE video_artists SET artist_id = ? WHERE artist_id = ?").run(to, from);
  db.query("UPDATE video_artist_rejections SET artist_id = ? WHERE artist_id = ?").run(to, from);
  // The Latin row is keyed by the id alone and may also serve the Proposed Artist that shares it: copy, don't move.
  db.query("INSERT OR IGNORE INTO artist_latin (artist_id, name_latin, name_latin_source) SELECT ?, name_latin, name_latin_source FROM artist_latin WHERE artist_id = ?").run(to, from);
  db.query(`UPDATE shelved_edit SET payload = replace(payload, '"' || ? || '"', '"' || ? || '"') WHERE kind = 'artists' AND instr(payload, ?) > 0`).run(from, to, from);
  indexArtist(db, from);
  indexArtist(db, to);
  return to;
}

export interface FreedIds {
  videos: { from: string; to: string }[];
  chapters: { from: string; to: string }[];
  artists: { from: string; to: string }[];
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Moves this machine's rows that hold the id of an incoming Shared row but are not that row (SYNC-1):
 *   - an Unshared Video whose identity keys disagree with the Shared Video of its id;
 *   - a Chapter of an Unshared Video, or of another Video, whose id a Shared Chapter of a different Video brings;
 *   - a Local Artist whose id a Proposed Artist of another name brings.
 * Runs before matching (`reconcileBatch`) and before every apply; does nothing when nothing collides.
 */
export function freeCollidingIds(db: Db, batch: SharedChanges, opts: MoveOptions = {}): FreedIds {
  const out: FreedIds = { videos: [], chapters: [], artists: [] };
  const t = batch.tables ?? {};
  const heldVideo = db.prepare(`SELECT v.id, v.youtube_id, v.content_hash, COALESCE(l.shared, 0) AS shared
    FROM videos v LEFT JOIN video_local l ON l.video_id = v.id WHERE v.id = ?`);
  for (const v of t.videos ?? []) {
    const h = heldVideo.get(v.id) as { id: string; youtube_id: string | null; content_hash: string | null; shared: number } | null;
    if (!h || h.shared) continue;
    if (h.content_hash?.startsWith(RECONCILED_HASH_PREFIX)) continue;
    if (sameIdentity(h, v)) continue;
    out.videos.push({ from: h.id, to: moveVideo(db, h.id, newUuid(), opts) });
  }
  const heldChapter = db.prepare(`SELECT c.id, c.video_id, COALESCE(l.shared, 0) AS shared
    FROM video_chapters c LEFT JOIN video_local l ON l.video_id = c.video_id WHERE c.id = ?`);
  for (const c of t.video_chapters ?? []) {
    const h = heldChapter.get(c.id) as { id: string; video_id: string; shared: number } | null;
    if (!h || h.video_id === c.video_id) continue;
    // A Shared Chapter that moved between Shared Videos upstream is the same Chapter: the apply moves it.
    if (h.shared) continue;
    out.chapters.push({ from: h.id, to: moveChapter(db, h.id) });
  }
  const heldArtist = db.prepare("SELECT id, name FROM local_artist WHERE id = ?");
  for (const a of t.video_proposed_artists ?? []) {
    const h = heldArtist.get(a.id) as { id: string; name: string } | null;
    if (!h || sameName(h.name, a.name ?? "")) continue;
    out.artists.push({ from: h.id, to: moveLocalArtist(db, h.id) });
  }
  return out;
}
