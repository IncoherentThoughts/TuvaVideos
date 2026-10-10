// Latin titles (spec 2.5, data-model.md "Latin titles"). Fills `title_latin` on Videos and Chapters and `name_latin` on
// Artists. Source `archive` when the row is tied to a Mirror Song whose Cyrillic spelling the title is: the Song's own
// Latin name field (never `english_name`, which is a translation). Otherwise `table`. A title with no Cyrillic stays
// NULL. `manual` is never touched.
import type { Db } from "./db";
import { hasTable } from "./search";
import { allSongNames, latinSpelling, type SongNameSource } from "../shared/songNames";
import { foldText } from "../shared/fold";
import { hasCyrillic, transliterate } from "../shared/translit";

export type LatinSource = "archive" | "table";
export interface Latin {
  latin: string | null;
  source: LatinSource | null;
}

/** A title reduced to letters and digits through the search fold, so Чаңгыс and Чаньгыс and punctuation do not matter. */
export const looseKey = (s: string) => foldText(s).replace(/[^a-z0-9]/g, "");

export interface SongNames {
  /** The archive Latin spelling to store (Latin name, else first Latin alternate spelling). */
  latin: string | null;
  /** looseKey of the name and of every Cyrillic alternate title and spelling. */
  cyrillicKeys: Set<string>;
}

export function songNames(row: SongNameSource): SongNames {
  const keys = new Set(allSongNames(row).filter((n) => n.kind !== "english" && (hasCyrillic(n.text) || n.kind === "name")).map((n) => looseKey(n.text)));
  keys.delete("");
  return { latin: latinSpelling(row), cyrillicKeys: keys };
}

/** The pure choice. `song` is the Mirror Song the row is tied to, when there is one. */
export function latinFor(title: string, song: SongNames | null | undefined): Latin {
  if (!hasCyrillic(title)) return { latin: null, source: null };
  if (song?.latin && song.cyrillicKeys.has(looseKey(title))) return { latin: song.latin, source: "archive" };
  return { latin: transliterate(title), source: "table" };
}

export interface LatinFillStats {
  videos: number;
  chapters: number;
  artists: number;
  archive: number;
  table: number;
  cleared: number;
}

function loadSongs(db: Db): Map<string, SongNames> {
  const out = new Map<string, SongNames>();
  if (!hasTable(db, "mirror_song")) return out;
  for (const s of db.query("SELECT id, name, english_name, alternate_titles, alternate_spellings FROM mirror_song").all() as any[]) out.set(s.id, songNames(s));
  return out;
}

/**
 * Recomputes every Latin title whose source is not `manual`. Only changed rows are written. `videoId` limits the pass to
 * one Video (after its title was edited); Chapters and Artists are skipped then.
 */
export function fillLatinTitles(db: Db, opts: { videoId?: number } = {}): LatinFillStats {
  const stats: LatinFillStats = { videos: 0, chapters: 0, artists: 0, archive: 0, table: 0, cleared: 0 };
  const songs = loadSongs(db);
  const apply = (table: "video" | "chapter" | "artist", cur: { id: number; text: string; latin: string | null; source: string | null; song: string | null }) => {
    if (cur.source === "manual") return;
    const next = latinFor(cur.text, cur.song ? songs.get(cur.song) : null);
    if (next.latin === cur.latin && next.source === cur.source) return;
    const [latinCol, srcCol] = table === "artist" ? ["name_latin", "name_latin_source"] : ["title_latin", "title_latin_source"];
    db.prepare(`UPDATE ${table} SET ${latinCol} = ?, ${srcCol} = ? WHERE id = ?`).run(next.latin, next.source, cur.id);
    if (table === "video") stats.videos++;
    else if (table === "chapter") stats.chapters++;
    else stats.artists++;
    if (next.source === "archive") stats.archive++;
    else if (next.source === "table") stats.table++;
    else stats.cleared++;
  };
  db.transaction(() => {
    const vq = opts.videoId != null ? "SELECT id, title, title_latin, title_latin_source, song_id FROM video WHERE id = ?" : "SELECT id, title, title_latin, title_latin_source, song_id FROM video";
    for (const r of db.query(vq).all(...(opts.videoId != null ? [opts.videoId] : [])) as any[])
      apply("video", { id: r.id, text: r.title, latin: r.title_latin, source: r.title_latin_source, song: r.song_id });
    if (opts.videoId != null) return;
    for (const r of db.query("SELECT id, title, title_latin, title_latin_source, song_id FROM chapter").all() as any[])
      apply("chapter", { id: r.id, text: r.title, latin: r.title_latin, source: r.title_latin_source, song: r.song_id });
    for (const r of db.query("SELECT id, name, name_latin, name_latin_source FROM artist").all() as any[])
      apply("artist", { id: r.id, text: r.name, latin: r.name_latin, source: r.name_latin_source, song: null });
  })();
  return stats;
}
