// Writing the Local copy from the companion's own routes (an Unshared or Standalone Video, §4.9): pointer pairs and the
// machine's side tables. Readers use the views `video_full`, `chapter_full`, `video_artist_full`, `song_all`,
// `version_all` and `artist_all` (migration 0015), where each pointer pair reads as one effective id.
import type { Db } from "../db";

export type RowKind = "archive" | "proposed" | "local";

export const songKind = (db: Db, id: string): RowKind | null => (db.query("SELECT kind FROM song_all WHERE id = ?").get(id) as { kind: RowKind } | null)?.kind ?? null;
export const versionKind = (db: Db, id: string): RowKind | null => (db.query("SELECT kind FROM version_all WHERE id = ?").get(id) as { kind: RowKind } | null)?.kind ?? null;
export const artistKind = (db: Db, id: string): RowKind | null => (db.query("SELECT kind FROM artist_all WHERE id = ?").get(id) as { kind: RowKind } | null)?.kind ?? null;

/**
 * The pointer-pair columns for one effective Song and Version (§3.3): a Proposed row goes to `proposed_*`, an archive
 * or local row (or a dangling uuid) to the plain column.
 */
export function songPointers(db: Db, songId: string | null, versionId: string | null) {
  const sp = songId != null && songKind(db, songId) === "proposed";
  const vp = versionId != null && versionKind(db, versionId) === "proposed";
  return {
    song_id: sp ? null : songId,
    proposed_song_id: sp ? songId : null,
    version_id: vp ? null : versionId,
    proposed_version_id: vp ? versionId : null,
  };
}

/** The Artist-link columns for one effective Artist id. */
export function artistPointer(db: Db, artistId: string) {
  return artistKind(db, artistId) === "proposed" ? { artist_id: null, proposed_artist_id: artistId } : { artist_id: artistId, proposed_artist_id: null };
}

type Value = string | number | null;

/** Sets this machine's columns of a Video (`video_local`), creating its row when needed. */
export function setVideoLocal(db: Db, videoId: string, cols: Record<string, Value>) {
  const keys = Object.keys(cols);
  if (!keys.length) return;
  db.query(
    `INSERT INTO video_local (video_id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})
     ON CONFLICT(video_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(", ")}`,
  ).run(videoId, ...keys.map((k) => cols[k]!));
}

/** Sets a Chapter's Favorite (`chapter_local`). */
export function setChapterFavorite(db: Db, chapterId: string, at: string | null) {
  if (at == null) db.query("DELETE FROM chapter_local WHERE chapter_id = ?").run(chapterId);
  else db.query("INSERT INTO chapter_local (chapter_id, favorited_at) VALUES (?, ?) ON CONFLICT(chapter_id) DO UPDATE SET favorited_at = excluded.favorited_at").run(chapterId, at);
}

export const nowIso = () => new Date().toISOString();
