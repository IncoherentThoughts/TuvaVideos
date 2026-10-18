// Artists, Favorites and the writes behind them (spec 5.1, 5.5, 2.3). SQL only; JSON shaping stays in api.ts.
// Favorites, Resume, view counts and loops are this machine's (video_local / chapter_local, sharing-spec §6.1).
import type { Db } from "./db";
import { storedLoop, type StoredLoop } from "../shared/playerMath";
import { storedResume } from "../shared/resume";
import type { ArtistDto } from "../shared/types";
import { setChapterFavorite, setVideoLocal } from "./localCopy/rows";

/** Artists with at least one Video: count, and the Video whose poster stands for them (the newest by Copy mtime). */
export function listArtists(db: Db): ArtistDto[] {
  const rows = db
    .query(
      `SELECT a.id, a.kind, a.name, a.name_latin, COUNT(va.video_id) AS n,
        (SELECT v2.id FROM video_artist_full va2 JOIN video_full v2 ON v2.id = va2.video_id
          WHERE va2.artist_id = a.id
          ORDER BY (SELECT MAX(c.mtime) FROM copy c WHERE c.video_id = v2.id) DESC, v2.created_at DESC, v2.id DESC LIMIT 1) AS poster
       FROM artist_all a JOIN video_artist_full va ON va.artist_id = a.id
       GROUP BY a.id ORDER BY a.name COLLATE NOCASE`,
    )
    .all() as { id: string; kind: string; name: string; name_latin: string | null; n: number; poster: string | null }[];
  return rows.map((r) => ({
    id: r.id, name: r.name, nameLatin: r.name_latin, local: r.kind === "local", proposed: r.kind === "proposed",
    videoCount: r.n, posterVideoId: r.poster,
  }));
}

export interface FavoriteRow {
  kind: "video" | "chapter";
  favorited_at: string;
  video_id: string;
  chapter_id: string | null;
}

/** Favorite Videos and Chapters, newest starred first. */
export function listFavoriteRows(db: Db): FavoriteRow[] {
  return db
    .query(
      `SELECT 'video' AS kind, favorited_at, id AS video_id, NULL AS chapter_id FROM video_full WHERE favorited_at IS NOT NULL
       UNION ALL
       SELECT 'chapter', favorited_at, video_id, id FROM chapter_full WHERE favorited_at IS NOT NULL
       ORDER BY favorited_at DESC, video_id DESC, chapter_id DESC`,
    )
    .all() as FavoriteRow[];
}

/**
 * Sets or clears `favorited_at`. `want` undefined toggles. Returns the new value (ISO string, or null when cleared),
 * or undefined when the row does not exist.
 */
export function setFavorite(db: Db, table: "video" | "chapter", id: string, want?: boolean): string | null | undefined {
  const row = db.query(`SELECT favorited_at FROM ${table === "video" ? "video_full" : "chapter_full"} WHERE id = ?`).get(id) as { favorited_at: string | null } | null;
  if (!row) return undefined;
  const on = want ?? !row.favorited_at;
  if (on && row.favorited_at) return row.favorited_at; // already a Favorite: keep its place in the order
  const next = on ? new Date().toISOString() : null;
  if (table === "video") setVideoLocal(db, id, { favorited_at: next });
  else setChapterFavorite(db, id, next);
  return next;
}

export type MergeResult = { ok: true; moved: number } | { ok: false; status: number; error: string };

/**
 * Merges a Local Artist into an archive (or Proposed) Artist: its links move to the target (a Video that already has
 * the target keeps one link), then the Local Artist is deleted (spec 2.3). Only Local -> archive is allowed. On the
 * Shared data the same act is a Repoint (sharing-spec §4.6, ticket #116).
 */
export function mergeArtist(db: Db, sourceId: string, targetId: string): MergeResult {
  if (sourceId === targetId) return { ok: false, status: 400, error: "cannot merge an Artist into itself" };
  const get = (id: string) => db.query("SELECT id, kind FROM artist_all WHERE id = ?").get(id) as { id: string; kind: string } | null;
  const src = get(sourceId);
  const dst = get(targetId);
  if (!src || !dst) return { ok: false, status: 404, error: "no such artist" };
  if (src.kind !== "local") return { ok: false, status: 409, error: "only a Local Artist can be merged" };
  if (dst.kind === "local") return { ok: false, status: 409, error: "the target must be an archive Artist" };
  const target = dst.kind === "proposed" ? { col: "proposed_artist_id", other: "artist_id" } : { col: "artist_id", other: "proposed_artist_id" };
  let moved = 0;
  db.transaction(() => {
    const links = db.query("SELECT id, video_id FROM video_artists WHERE artist_id = ?").all(sourceId) as { id: string; video_id: string }[];
    for (const l of links) {
      const has = db.query(`SELECT 1 FROM video_artists WHERE video_id = ? AND ${target.col} = ?`).get(l.video_id, targetId);
      if (has) db.query("DELETE FROM video_artists WHERE id = ?").run(l.id);
      else {
        db.query(`UPDATE video_artists SET ${target.col} = ?, ${target.other} = NULL WHERE id = ?`).run(targetId, l.id);
        moved++;
      }
    }
    db.query("DELETE FROM video_artist_rejections WHERE artist_id = ?").run(sourceId);
    db.query("DELETE FROM artist_latin WHERE artist_id = ?").run(sourceId);
    db.query("DELETE FROM local_artist WHERE id = ?").run(sourceId);
  })();
  return { ok: true, moved };
}

const videoExists = (db: Db, id: string) => !!db.query("SELECT 1 FROM video_full WHERE id = ?").get(id);

/**
 * Resume position (spec 4.3). A position within 30 s of the end is stored as finished (0). `copyId` picks whose
 * duration decides "the end"; otherwise the longest known Copy does. Returns what was stored, or undefined for no such Video.
 */
export function recordResume(db: Db, videoId: string, positionS: number, copyId?: number | null): { resumeS: number; finished: boolean } | undefined {
  if (!videoExists(db, videoId)) return undefined;
  let duration: number | null = null;
  if (copyId != null) {
    duration = (db.query("SELECT duration_s d FROM copy WHERE id = ? AND video_id = ?").get(copyId, videoId) as { d: number | null } | null)?.d ?? null;
  }
  if (duration == null) {
    duration = (db.query("SELECT MAX(duration_s) d FROM copy WHERE video_id = ?").get(videoId) as { d: number | null }).d;
  }
  const resumeS = storedResume(positionS, duration);
  setVideoLocal(db, videoId, { resume_s: resumeS, last_played_at: new Date().toISOString() });
  return { resumeS, finished: resumeS === 0 && positionS > 0 };
}

/** One more view of a Video (migration 0009). Returns the new count, or undefined when the Video does not exist. */
export function recordView(db: Db, videoId: string): number | undefined {
  if (!videoExists(db, videoId)) return undefined;
  db.prepare("INSERT INTO video_local (video_id, view_count) VALUES (?, 1) ON CONFLICT(video_id) DO UPDATE SET view_count = view_count + 1").run(videoId);
  return (db.query("SELECT view_count n FROM video_local WHERE video_id = ?").get(videoId) as { n: number }).n;
}

/** Resets a Video's view count to 0. False when the Video does not exist. */
export function resetViews(db: Db, videoId: string): boolean {
  if (!videoExists(db, videoId)) return false;
  setVideoLocal(db, videoId, { view_count: 0 });
  return true;
}

/**
 * A-B loop (spec 4.3). A complete loop is kept per Video until the user turns it off; null clears it. Returns what
 * was stored, or undefined for no such Video.
 */
export function recordLoop(db: Db, videoId: string, loop: StoredLoop | null): { loop: StoredLoop | null } | undefined {
  if (!videoExists(db, videoId)) return undefined;
  const l = storedLoop(loop);
  setVideoLocal(db, videoId, { loop_a_s: l?.a ?? null, loop_b_s: l?.b ?? null });
  return { loop: l };
}
