// Artists, Favorites and the writes behind them (spec 5.1, 5.5, 2.3). SQL only; JSON shaping stays in api.ts.
import type { Db } from "./db";
import { storedResume } from "../shared/resume";
import type { ArtistDto } from "../shared/types";

/** Artists with at least one Video: count, and the Video whose poster stands for them (the newest by Copy mtime). */
export function listArtists(db: Db): ArtistDto[] {
  const rows = db
    .query(
      `SELECT a.id, a.mirror_id, a.name, a.name_latin, COUNT(va.video_id) AS n,
        (SELECT v2.id FROM video_artist va2 JOIN video v2 ON v2.id = va2.video_id
          WHERE va2.artist_id = a.id
          ORDER BY (SELECT MAX(c.mtime) FROM copy c WHERE c.video_id = v2.id) DESC, v2.id DESC LIMIT 1) AS poster
       FROM artist a JOIN video_artist va ON va.artist_id = a.id
       GROUP BY a.id ORDER BY a.name COLLATE NOCASE`,
    )
    .all() as { id: number; mirror_id: string | null; name: string; name_latin: string | null; n: number; poster: number | null }[];
  return rows.map((r) => ({
    id: r.id, mirrorId: r.mirror_id, name: r.name, nameLatin: r.name_latin, local: r.mirror_id == null,
    videoCount: r.n, posterVideoId: r.poster,
  }));
}

export interface FavoriteRow {
  kind: "video" | "chapter";
  favorited_at: string;
  video_id: number;
  chapter_id: number | null;
}

/** Favorite Videos and Chapters, newest starred first. */
export function listFavoriteRows(db: Db): FavoriteRow[] {
  return db
    .query(
      `SELECT 'video' AS kind, favorited_at, id AS video_id, NULL AS chapter_id FROM video WHERE favorited_at IS NOT NULL
       UNION ALL
       SELECT 'chapter', favorited_at, video_id, id FROM chapter WHERE favorited_at IS NOT NULL
       ORDER BY favorited_at DESC, video_id DESC, chapter_id DESC`,
    )
    .all() as FavoriteRow[];
}

/**
 * Sets or clears `favorited_at`. `want` undefined toggles. Returns the new value (ISO string, or null when cleared),
 * or undefined when the row does not exist.
 */
export function setFavorite(db: Db, table: "video" | "chapter", id: number, want?: boolean): string | null | undefined {
  const row = db.query(`SELECT favorited_at FROM ${table} WHERE id = ?`).get(id) as { favorited_at: string | null } | null;
  if (!row) return undefined;
  const on = want ?? !row.favorited_at;
  if (on && row.favorited_at) return row.favorited_at; // already a Favorite: keep its place in the order
  const next = on ? new Date().toISOString() : null;
  db.query(`UPDATE ${table} SET favorited_at = ? WHERE id = ?`).run(next, id);
  return next;
}

export type MergeResult = { ok: true; moved: number } | { ok: false; status: number; error: string };

/**
 * Merges a Local Artist into a Mirror Artist: its `video_artist` rows move to the target (a Video that already has
 * the target keeps one row), then the Local Artist is deleted (spec 2.3). Only Local -> Mirror is allowed.
 */
export function mergeArtist(db: Db, sourceId: number, targetId: number): MergeResult {
  if (sourceId === targetId) return { ok: false, status: 400, error: "cannot merge an Artist into itself" };
  const get = (id: number) => db.query("SELECT id, mirror_id FROM artist WHERE id = ?").get(id) as { id: number; mirror_id: string | null } | null;
  const src = get(sourceId);
  const dst = get(targetId);
  if (!src || !dst) return { ok: false, status: 404, error: "no such artist" };
  if (src.mirror_id != null) return { ok: false, status: 409, error: "only a Local Artist can be merged" };
  if (dst.mirror_id == null) return { ok: false, status: 409, error: "the target must be a Mirror Artist" };
  let moved = 0;
  db.transaction(() => {
    const links = db.query("SELECT video_id, position FROM video_artist WHERE artist_id = ?").all(sourceId) as { video_id: number; position: number }[];
    for (const l of links) {
      const has = db.query("SELECT 1 FROM video_artist WHERE video_id = ? AND artist_id = ?").get(l.video_id, targetId);
      if (has) db.query("DELETE FROM video_artist WHERE video_id = ? AND artist_id = ?").run(l.video_id, sourceId);
      else {
        db.query("UPDATE video_artist SET artist_id = ? WHERE video_id = ? AND artist_id = ?").run(targetId, l.video_id, sourceId);
        moved++;
      }
    }
    db.query("DELETE FROM artist WHERE id = ?").run(sourceId);
  })();
  return { ok: true, moved };
}

/**
 * Resume position (spec 4.3). A position within 30 s of the end is stored as finished (0). `copyId` picks whose
 * duration decides "the end"; otherwise the longest known Copy does. Returns what was stored, or undefined for no such Video.
 */
export function recordResume(db: Db, videoId: number, positionS: number, copyId?: number | null): { resumeS: number; finished: boolean } | undefined {
  if (!db.query("SELECT 1 FROM video WHERE id = ?").get(videoId)) return undefined;
  let duration: number | null = null;
  if (copyId != null) {
    duration = (db.query("SELECT duration_s d FROM copy WHERE id = ? AND video_id = ?").get(copyId, videoId) as { d: number | null } | null)?.d ?? null;
  }
  if (duration == null) {
    duration = (db.query("SELECT MAX(duration_s) d FROM copy WHERE video_id = ?").get(videoId) as { d: number | null }).d;
  }
  const resumeS = storedResume(positionS, duration);
  db.prepare("UPDATE video SET resume_s = ?, last_played_at = ? WHERE id = ?").run(resumeS, new Date().toISOString(), videoId);
  return { resumeS, finished: resumeS === 0 && positionS > 0 };
}
