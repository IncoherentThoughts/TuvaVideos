// Songs for the lyrics drawer and the Song row (spec 5.3, 5.4). SQL and shaping only; availability is api.ts's.
import type { Db } from "./db";
import { splitAlternates } from "./search";
import { SCRIPTS, parseFootnotes } from "../shared/lyrics/scripts";
import { sanitizeFootnoteHtml, sanitizeLine } from "../shared/lyrics/sanitize";
import type { ScriptKey, VersionDto } from "../shared/lyrics/types";
import type { SongRef } from "../shared/types";

export interface SongRow {
  id: string;
  name: string;
  english_name: string | null;
  alternate_titles: string | null;
}

export function getSongRow(db: Db, id: string): SongRow | null {
  return db.query("SELECT id, name, english_name, alternate_titles FROM mirror_song WHERE id = ?").get(id) as SongRow | null;
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
  return { id: s.id, name: s.name, englishName: s.english_name, alternateTitles: splitAlternates(s.alternate_titles), versions: versionsOf(db, id) };
}

/** What the header needs of a Song: its name and Version labels. A uuid with no row is returned with `name: null` (dangling). */
export function songRef(db: Db, id: string | null): SongRef | null {
  if (!id) return null;
  const s = getSongRow(db, id);
  const versions = s ? (db.query("SELECT id, label FROM mirror_version WHERE song_id = ? ORDER BY display_order, label").all(id) as { id: string; label: string }[]) : [];
  return { id, name: s?.name ?? null, englishName: s?.english_name ?? null, versions };
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
