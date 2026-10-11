// Songs for the lyrics drawer and the Song row (spec 5.3, 5.4). SQL and shaping only; availability is api.ts's.
import type { Db } from "./db";
import { allSongNames, splitAlternates } from "../shared/songNames";
import { SCRIPTS, parseFootnotes } from "../shared/lyrics/scripts";
import { sanitizeFootnoteHtml, sanitizeLine } from "../shared/lyrics/sanitize";
import type { ScriptKey, VersionDto } from "../shared/lyrics/types";
import type { SongListDto, SongRef } from "../shared/types";

export interface SongRow {
  id: string;
  name: string;
  english_name: string | null;
  alternate_titles: string | null;
  alternate_spellings: string | null;
  is_hidden: number;
}

export function getSongRow(db: Db, id: string): SongRow | null {
  return db.query("SELECT id, name, english_name, alternate_titles, alternate_spellings, is_hidden FROM mirror_song WHERE id = ?").get(id) as SongRow | null;
}

/** A Version with its three Scripts as sanitized HTML (LINE profile) and sanitized Footnote bodies (FOOTNOTE profile). */
export function versionsOf(db: Db, songId: string): VersionDto[] {
  const rows = db.query("SELECT * FROM mirror_version WHERE song_id = ? ORDER BY display_order, label").all(songId) as any[];
  return rows.map((r) => {
    const scripts = {} as VersionDto["scripts"];
    for (const s of SCRIPTS) {
      scripts[s.key as ScriptKey] = {
        html: sanitizeLine(r[s.column] ?? ""),
        footnotes: parseFootnotes(r[s.footnoteColumn]).map((f) => ({ id: f.id, text: sanitizeFootnoteHtml(f.text) })),
      };
    }
    return { id: r.id, label: r.label, displayOrder: r.display_order, scripts };
  });
}

export function songDto(db: Db, id: string) {
  const s = getSongRow(db, id);
  if (!s) return null;
  return { id: s.id, name: s.name, englishName: s.english_name, hidden: !!s.is_hidden, alternateTitles: splitAlternates(s.alternate_titles), alternateSpellings: splitAlternates(s.alternate_spellings), names: allSongNames(s), versions: versionsOf(db, id) };
}

/** What the header needs of a Song: its name and Version labels. A uuid with no row is returned with `name: null` (dangling). */
export function songRef(db: Db, id: string | null): SongRef | null {
  if (!id) return null;
  const s = getSongRow(db, id);
  const versions = s ? (db.query("SELECT id, label FROM mirror_version WHERE song_id = ? ORDER BY display_order, label").all(id) as { id: string; label: string }[]) : [];
  return { id, name: s?.name ?? null, englishName: s?.english_name ?? null, hidden: !!s?.is_hidden, versions };
}

/** Video ids that perform a Song: the Video's Song pointer, or a Performance of the Song carrying the Video's YouTube id. */
export function videosPerforming(db: Db, songId: string): { videoId: number; startS: number | null; pointed: boolean }[] {
  const rows = db
    .query(
      `SELECT v.id AS videoId, MIN(p.start_s) AS startS, MAX(v.song_id = ?) AS pointed
         FROM video v LEFT JOIN mirror_performance p ON p.youtube_id = v.youtube_id AND p.song_id = ?
        WHERE v.song_id = ? OR p.id IS NOT NULL
        GROUP BY v.id ORDER BY v.id`,
    )
    .all(songId, songId, songId) as { videoId: number; startS: number | null; pointed: number | null }[];
  return rows.map((r) => ({ videoId: r.videoId, startS: r.startS, pointed: !!r.pointed }));
}

/** Songs with at least one Video or Chapter pointing at them (confirmed or Suggested): counts, lyrics presence and the
 *  poster Video (the newest by Copy mtime among its Videos, else the Video of its newest Chapter). Empty without a Mirror. */
export function listSongs(db: Db): SongListDto[] {
  const has = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mirror_song'").get();
  if (!has) return [];
  const rows = db
    .query(
      `WITH used AS (
         SELECT song_id, MAX(COALESCE((SELECT MAX(c.mtime) FROM copy c WHERE c.video_id = v.id), v.created_at)) AS newest
           FROM video v WHERE song_id IS NOT NULL GROUP BY song_id
         UNION ALL
         SELECT ch.song_id, MAX(COALESCE((SELECT MAX(c.mtime) FROM copy c WHERE c.video_id = v.id), v.created_at))
           FROM chapter ch JOIN video v ON v.id = ch.video_id WHERE ch.song_id IS NOT NULL GROUP BY ch.song_id
       )
       SELECT s.id, s.name, s.english_name,
         (SELECT COUNT(*) FROM video v WHERE v.song_id = s.id) AS videos,
         (SELECT COUNT(*) FROM chapter ch WHERE ch.song_id = s.id) AS chapters,
         (SELECT COUNT(*) FROM mirror_version mv WHERE mv.song_id = s.id) AS versions,
         (SELECT v.id FROM video v WHERE v.song_id = s.id
            ORDER BY (SELECT MAX(c.mtime) FROM copy c WHERE c.video_id = v.id) DESC, v.id DESC LIMIT 1) AS posterVideo,
         (SELECT ch.video_id FROM chapter ch WHERE ch.song_id = s.id
            ORDER BY (SELECT MAX(c.mtime) FROM copy c WHERE c.video_id = ch.video_id) DESC, ch.id DESC LIMIT 1) AS posterChapterVideo,
         (SELECT MAX(newest) FROM used WHERE used.song_id = s.id) AS addedAt
       FROM mirror_song s WHERE s.id IN (SELECT song_id FROM used)
       ORDER BY s.name COLLATE NOCASE`,
    )
    .all() as { id: string; name: string; english_name: string | null; videos: number; chapters: number; versions: number; posterVideo: number | null; posterChapterVideo: number | null; addedAt: string | null }[];
  return rows.map((r) => ({
    id: r.id, name: r.name, englishName: r.english_name, videoCount: r.videos, chapterCount: r.chapters, versionCount: r.versions,
    posterVideoId: r.posterVideo ?? r.posterChapterVideo, addedAt: r.addedAt || null,
  }));
}
