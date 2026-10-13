// Scan defaults from Performances (spec 2.3). A Video still at its starting Type (`song` since 2026-10-12, `other` before), with no Song, never edited by the user
// (`suggestion_source IS NULL`: any PATCH of the Type or the Song stamps `manual`), whose YouTube id is on:
//   - exactly one Song's Performances -> Type `song`, that Song Suggested (source `performance`);
//   - two or more Songs' Performances -> Type `concert` (the Type is Suggested, no Song).
// "Exactly one Performance" counts Songs, not rows: the archive links one id twice to the same Song seven times, and
// that is still a one-song Video. Run for a new Video at scan time, and for every Video once after a Mirror import.
import type { Db } from "./db";
import { hasTable } from "./search";

export interface DefaultsStats {
  song: number;
  concert: number;
}

export function applyPerformanceDefaults(db: Db, opts: { videoId?: number } = {}): DefaultsStats {
  const stats: DefaultsStats = { song: 0, concert: 0 };
  if (!hasTable(db, "mirror_performance")) return stats;
  const rows = db
    .query(
      `SELECT v.id AS id, p.song_id AS song_id
         FROM video v JOIN mirror_performance p ON p.youtube_id = v.youtube_id
        WHERE v.type IN ('song', 'other') AND v.type_suggested = 0 AND v.song_id IS NULL AND v.suggestion_source IS NULL
          ${opts.videoId != null ? "AND v.id = ?" : ""}
        GROUP BY v.id, p.song_id ORDER BY v.id`,
    )
    .all(...(opts.videoId != null ? [opts.videoId] : [])) as { id: number; song_id: string }[];
  const songs = new Map<number, string[]>();
  for (const r of rows) (songs.get(r.id) ?? songs.set(r.id, []).get(r.id)!).push(r.song_id);
  const asSong = db.prepare("UPDATE video SET type = 'song', type_suggested = 1, song_id = ?, song_suggested = 1, suggestion_source = 'performance' WHERE id = ?");
  const asConcert = db.prepare("UPDATE video SET type = 'concert', type_suggested = 1, suggestion_source = 'performance' WHERE id = ?");
  db.transaction(() => {
    for (const [id, ids] of songs) {
      if (ids.length === 1) {
        asSong.run(ids[0]!, id);
        stats.song++;
      } else {
        asConcert.run(id);
        stats.concert++;
      }
    }
  })();
  return stats;
}
