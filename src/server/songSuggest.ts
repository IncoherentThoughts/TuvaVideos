// The Song matcher on Video titles, server pass (spec 2.3): a Suggested Song (source `title`) for a Video nobody has
// edited and that no Performance gave a Song. A Video still at Type `other` becomes a Suggested `song` with it.
// Re-runs replace the Video's own `title` suggestion, or clear it when the title no longer matches. Clearing the Song
// by hand stamps the Video `manual` (edit.ts), so a rejected suggestion never returns. Runs for a new Video at scan
// time, after every scan, after archive rows change, when a Local Song is added or renamed, and from `bun run suggest-songs`.
// Unshared Videos only (sharing-spec §4.3): a Shared Video's suggestions are the Shared data's.
import type { Db } from "./db";
import { foldForMatch, prepareSongs } from "../shared/songMatch";
import { matchSongInTitle, prepareArtistNames, type TitleSong } from "../shared/titleSongMatch";
import { songPointers } from "./localCopy/rows";

export interface SongSuggestStats {
  videos: number;
  suggested: number;
  changed: number;
  cleared: number;
}

export interface SongSuggestRow {
  videoId: string;
  title: string;
  songId: string;
  song: string;
  score: number;
  window: string;
}

export function suggestSongsFromTitles(db: Db, opts: { videoId?: string; dryRun?: boolean; report?: SongSuggestRow[]; touched?: string[] } = {}): SongSuggestStats {
  const stats: SongSuggestStats = { videos: 0, suggested: 0, changed: 0, cleared: 0 };
  const rows = db.query("SELECT id, name, english_name, alternate_titles, alternate_spellings FROM song_all WHERE is_hidden = 0").all() as {
    id: string;
    name: string;
    english_name: string | null;
    alternate_titles: string | null;
    alternate_spellings: string | null;
  }[];
  const english = new Map(rows.map((r) => [r.id, r.english_name ? foldForMatch(r.english_name) : null]));
  const songs: TitleSong[] = prepareSongs(rows).map((s) => ({ ...s, english: english.get(s.id) }));
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const artists = prepareArtistNames((db.query("SELECT name, name_latin FROM artist_all").all() as { name: string; name_latin: string | null }[]).flatMap((a) => [a.name, a.name_latin ?? ""]));

  const videos = db
    .query(
      `SELECT id, title, song_id, suggestion_source FROM video_full
        WHERE shared = 0 AND ((song_id IS NULL AND suggestion_source IS NULL) OR suggestion_source = 'title') ${opts.videoId != null ? "AND id = ?" : ""}
        ORDER BY created_at, id`,
    )
    .all(...(opts.videoId != null ? [opts.videoId] : [])) as { id: string; title: string; song_id: string | null; suggestion_source: string | null }[];

  // Every SET expression reads the row as it was, so the Type test sees the old Type.
  const set = db.prepare(
    `UPDATE videos SET song_id = ?, proposed_song_id = ?, version_id = NULL, proposed_version_id = NULL, song_suggested = 1, suggestion_source = 'title',
       type = CASE WHEN type = 'other' AND type_suggested = 0 THEN 'song' ELSE type END,
       type_suggested = CASE WHEN type = 'other' AND type_suggested = 0 THEN 1 ELSE type_suggested END
     WHERE id = ?`,
  );
  const clear = db.prepare(
    `UPDATE videos SET song_id = NULL, proposed_song_id = NULL, version_id = NULL, proposed_version_id = NULL, song_suggested = 0, suggestion_source = NULL,
       type = CASE WHEN type = 'song' AND type_suggested = 1 THEN 'other' ELSE type END,
       type_suggested = CASE WHEN type = 'song' AND type_suggested = 1 THEN 0 ELSE type_suggested END
     WHERE id = ?`,
  );
  db.transaction(() => {
    for (const v of videos) {
      stats.videos++;
      const m = matchSongInTitle(v.title, songs, artists);
      if (m) {
        stats.suggested++;
        opts.report?.push({ videoId: v.id, title: v.title, songId: m.songId, song: names.get(m.songId) ?? "", score: Math.round(m.score * 1000) / 1000, window: m.window });
        if (m.songId === v.song_id) continue;
        stats.changed++;
        opts.touched?.push(v.id);
        if (!opts.dryRun) {
          const p = songPointers(db, m.songId, null);
          set.run(p.song_id, p.proposed_song_id, v.id);
        }
      } else if (v.suggestion_source === "title") {
        stats.cleared++;
        opts.touched?.push(v.id);
        if (!opts.dryRun) clear.run(v.id);
      }
    }
  })();
  return stats;
}
