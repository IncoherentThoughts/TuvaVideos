// Songs for the lyrics drawer and the Song row (spec 5.3, 5.4). SQL and shaping only; availability is api.ts's.
// Songs and Versions are read through song_all / version_all (migration 0015): archive, Proposed and local rows.
import type { Db } from "./db";
import { allSongNames, splitAlternates } from "../shared/songNames";
import { SCRIPTS, parseFootnotes } from "../shared/lyrics/scripts";
import { sanitizeFootnoteHtml, sanitizeLine } from "../shared/lyrics/sanitize";
import type { ScriptKey, VersionDto } from "../shared/lyrics/types";
import type { SongListDto, SongRef } from "../shared/types";
import type { RowKind } from "./localCopy/rows";

export interface SongRow {
  id: string;
  name: string;
  english_name: string | null;
  alternate_titles: string | null;
  alternate_spellings: string | null;
  is_hidden: number;
  kind: RowKind;
}

export function getSongRow(db: Db, id: string): SongRow | null {
  return db.query("SELECT id, name, english_name, alternate_titles, alternate_spellings, is_hidden, kind FROM song_all WHERE id = ?").get(id) as SongRow | null;
}

/** The Versions of a Song in display order: the archive's first, then Proposed, then local ones. */
const VERSION_ORDER = "ORDER BY CASE kind WHEN 'archive' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END, display_order, label";

/** A Version with its three Scripts as sanitized HTML (LINE profile) and sanitized Footnote bodies (FOOTNOTE profile). */
export function versionsOf(db: Db, songId: string): VersionDto[] {
  const rows = db.query(`SELECT * FROM version_all WHERE song_id = ? ${VERSION_ORDER}`).all(songId) as any[];
  return rows.map((r) => {
    const scripts = {} as VersionDto["scripts"];
    for (const s of SCRIPTS) {
      scripts[s.key as ScriptKey] = {
        html: sanitizeLine(r[s.column] ?? ""),
        footnotes: parseFootnotes(r[s.footnoteColumn]).map((f) => ({ id: f.id, text: sanitizeFootnoteHtml(f.text) })),
      };
    }
    return { id: r.id, label: r.label, displayOrder: r.display_order, local: r.kind === "local", proposed: r.kind === "proposed", scripts };
  });
}

export function songDto(db: Db, id: string) {
  const s = getSongRow(db, id);
  if (!s) return null;
  return {
    id: s.id, name: s.name, englishName: s.english_name, hidden: !!s.is_hidden, local: s.kind === "local", proposed: s.kind === "proposed",
    alternateTitles: splitAlternates(s.alternate_titles), alternateSpellings: splitAlternates(s.alternate_spellings), names: allSongNames(s), versions: versionsOf(db, id),
  };
}

/** What the header needs of a Song: its name and Version labels. A uuid with no row is returned with `name: null` (dangling). */
export function songRef(db: Db, id: string | null): SongRef | null {
  if (!id) return null;
  const s = getSongRow(db, id);
  const versions = s
    ? (db.query(`SELECT id, label, kind FROM version_all WHERE song_id = ? ${VERSION_ORDER}`).all(id) as { id: string; label: string; kind: RowKind }[]).map((v) => ({
        id: v.id, label: v.label, local: v.kind === "local", proposed: v.kind === "proposed",
      }))
    : [];
  return { id, name: s?.name ?? null, englishName: s?.english_name ?? null, hidden: !!s?.is_hidden, local: s?.kind === "local", proposed: s?.kind === "proposed", versions };
}

/**
 * Video ids that perform a Song: the Video's Song pointer, or a Performance of the Song carrying the Video's YouTube
 * or Rutube id (§4.3).
 */
export function videosPerforming(db: Db, songId: string): { videoId: string; startS: number | null; pointed: boolean }[] {
  const rows = db
    .query(
      `SELECT v.id AS videoId, MIN(p.start_s) AS startS, MAX(v.song_id = ?) AS pointed
         FROM video_full v LEFT JOIN archive_performance p
           ON p.song_id = ? AND ((v.youtube_id IS NOT NULL AND p.youtube_id = v.youtube_id) OR (v.rutube_id IS NOT NULL AND p.rutube_id = v.rutube_id))
        WHERE v.song_id = ? OR p.id IS NOT NULL
        GROUP BY v.id ORDER BY v.created_at, v.id`,
    )
    .all(songId, songId, songId) as { videoId: string; startS: number | null; pointed: number | null }[];
  return rows.map((r) => ({ videoId: r.videoId, startS: r.startS, pointed: !!r.pointed }));
}

/** Songs with at least one Video or Chapter pointing at them (confirmed or Suggested), plus every Local Song: counts,
 *  lyrics presence and the poster Video (the newest by Copy mtime among its Videos, else the Video of its newest Chapter). */
export function listSongs(db: Db): SongListDto[] {
  const rows = db
    .query(
      `WITH used AS (
         SELECT song_id, MAX(COALESCE((SELECT MAX(c.mtime) FROM copy c WHERE c.video_id = v.id), v.created_at)) AS newest
           FROM video_full v WHERE song_id IS NOT NULL GROUP BY song_id
         UNION ALL
         SELECT ch.song_id, MAX(COALESCE((SELECT MAX(c.mtime) FROM copy c WHERE c.video_id = v.id), v.created_at))
           FROM chapter_full ch JOIN video_full v ON v.id = ch.video_id WHERE ch.song_id IS NOT NULL GROUP BY ch.song_id
       )
       SELECT s.id, s.name, s.english_name, s.kind,
         (SELECT COUNT(*) FROM video_full v WHERE v.song_id = s.id) AS videos,
         (SELECT COUNT(*) FROM chapter_full ch WHERE ch.song_id = s.id) AS chapters,
         (SELECT COUNT(*) FROM version_all mv WHERE mv.song_id = s.id) AS versions,
         (SELECT COUNT(*) FROM local_version lv WHERE lv.song_id = s.id) AS localVersions,
         (SELECT v.id FROM video_full v WHERE v.song_id = s.id
            ORDER BY (SELECT MAX(c.mtime) FROM copy c WHERE c.video_id = v.id) DESC, v.created_at DESC, v.id DESC LIMIT 1) AS posterVideo,
         (SELECT ch.video_id FROM chapter_full ch WHERE ch.song_id = s.id
            ORDER BY (SELECT MAX(c.mtime) FROM copy c WHERE c.video_id = ch.video_id) DESC, ch.id DESC LIMIT 1) AS posterChapterVideo,
         (SELECT MAX(newest) FROM used WHERE used.song_id = s.id) AS addedAt
       FROM song_all s WHERE s.kind = 'local' OR s.id IN (SELECT song_id FROM used)
       ORDER BY s.name COLLATE NOCASE`,
    )
    .all() as { id: string; name: string; english_name: string | null; kind: RowKind; videos: number; chapters: number; versions: number; localVersions: number; posterVideo: string | null; posterChapterVideo: string | null; addedAt: string | null }[];
  return rows.map((r) => ({
    id: r.id, name: r.name, englishName: r.english_name, local: r.kind === "local", proposed: r.kind === "proposed", videoCount: r.videos, chapterCount: r.chapters,
    versionCount: r.versions, localVersionCount: r.localVersions, posterVideoId: r.posterVideo ?? r.posterChapterVideo, addedAt: r.addedAt || null,
  }));
}
