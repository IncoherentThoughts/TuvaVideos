// Scan defaults from Performances (spec 2.3). A Video still at its starting Type (`song` since 2026-10-12, `other` before), with no Song, never edited by the user
// (`suggestion_source IS NULL`: any PATCH of the Type or the Song stamps `manual`), whose YouTube id or Rutube id
// (sharing-spec §4.3, ADR 0008) is on:
//   - exactly one Song's Performances -> Type `song`, that Song Suggested (source `performance`);
//   - two or more Songs' Performances -> Type `concert` (the Type is Suggested, no Song).
// "Exactly one Performance" counts Songs, not rows: the archive links one id twice to the same Song seven times, and
// that is still a one-song Video. Run for a new Video at scan time, and after every scan. Unshared Videos only: a
// Shared Video's defaults are the Shared data's (on a Video Editor's machine written through the archive, #116).
import type { Db } from "./db";

export interface DefaultsStats {
  song: number;
  concert: number;
}

/**
 * `scope: "shared"` (a Video Editor's machine, §4.3) reads the Shared Videos instead and writes nothing: the matches
 * go to `report` for the browser to write through `write_videos`.
 */
export function applyPerformanceDefaults(db: Db, opts: { videoId?: string; scope?: "unshared" | "shared"; report?: { videoId: string; songIds: string[] }[] } = {}): DefaultsStats {
  const stats: DefaultsStats = { song: 0, concert: 0 };
  const rows = db
    .query(
      `SELECT v.id AS id, p.song_id AS song_id
         FROM video_full v JOIN archive_performance p
           ON (v.youtube_id IS NOT NULL AND p.youtube_id = v.youtube_id) OR (v.rutube_id IS NOT NULL AND p.rutube_id = v.rutube_id)
        WHERE v.type IN ('song', 'other') AND v.type_suggested = 0 AND v.song_id IS NULL AND v.suggestion_source IS NULL AND v.shared = ${opts.scope === "shared" ? 1 : 0}
          ${opts.videoId != null ? "AND v.id = ?" : ""}
        GROUP BY v.id, p.song_id ORDER BY v.created_at, v.id`,
    )
    .all(...(opts.videoId != null ? [opts.videoId] : [])) as { id: string; song_id: string }[];
  const songs = new Map<string, string[]>();
  for (const r of rows) (songs.get(r.id) ?? songs.set(r.id, []).get(r.id)!).push(r.song_id);
  if (opts.scope === "shared") {
    for (const [videoId, songIds] of songs) {
      opts.report?.push({ videoId, songIds });
      if (songIds.length === 1) stats.song++;
      else stats.concert++;
    }
    return stats;
  }
  // Performances belong to archive Songs: the plain pointer column.
  const asSong = db.prepare("UPDATE videos SET type = 'song', type_suggested = 1, song_id = ?, proposed_song_id = NULL, song_suggested = 1, suggestion_source = 'performance' WHERE id = ?");
  const asConcert = db.prepare("UPDATE videos SET type = 'concert', type_suggested = 1, suggestion_source = 'performance' WHERE id = ?");
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
