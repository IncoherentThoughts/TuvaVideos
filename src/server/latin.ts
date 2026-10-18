// Latin titles (spec 2.5, data-model.md "Latin titles"). Fills `title_latin` on Videos and Chapters and `name_latin` on
// Artists. Source `archive` when the row is tied to a Mirror Song whose Cyrillic spelling the title is: the Song's own
// Latin name field (never `english_name`, which is a translation). Otherwise `table`. A title with no Cyrillic stays
// NULL. `manual` is never touched.
import type { Db } from "./db";
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
  for (const s of db.query("SELECT id, name, english_name, alternate_titles, alternate_spellings FROM song_all").all() as any[]) out.set(s.id, songNames(s));
  return out;
}

type Cur = { id: string; text: string; latin: string | null; source: string | null; song: string | null };

/**
 * Recomputes every Latin title whose source is not `manual`. Only changed rows are written. `videoId` limits the pass to
 * one Video (after its title was edited), `chapterId` to one Chapter; Chapters and Artists are skipped then.
 * Shared Videos and Chapters are left alone: their Latin titles are Shared (§4.3), computed by whoever wrote them.
 */
export function fillLatinTitles(db: Db, opts: { videoId?: string; chapterId?: string } = {}): LatinFillStats {
  const stats: LatinFillStats = { videos: 0, chapters: 0, artists: 0, archive: 0, table: 0, cleared: 0 };
  const songs = loadSongs(db);
  const apply = (table: "videos" | "video_chapters" | "artist", cur: Cur) => {
    if (cur.source === "manual") return;
    const next = latinFor(cur.text, cur.song ? songs.get(cur.song) : null);
    if (next.latin === cur.latin && next.source === cur.source) return;
    if (table === "artist") setArtistLatin(db, cur.id, next.latin, next.source);
    else db.prepare(`UPDATE ${table} SET title_latin = ?, title_latin_source = ? WHERE id = ?`).run(next.latin, next.source, cur.id);
    if (table === "videos") stats.videos++;
    else if (table === "video_chapters") stats.chapters++;
    else stats.artists++;
    if (next.source === "archive") stats.archive++;
    else if (next.source === "table") stats.table++;
    else stats.cleared++;
  };
  const CH = "SELECT id, title, title_latin, title_latin_source, song_id FROM chapter_full WHERE video_id IN (SELECT id FROM video_full WHERE shared = 0)";
  const VQ = "SELECT id, title, title_latin, title_latin_source, song_id FROM video_full WHERE shared = 0";
  db.transaction(() => {
    if (opts.chapterId != null) {
      for (const r of db.query(`${CH} AND id = ?`).all(opts.chapterId) as any[])
        apply("video_chapters", { id: r.id, text: r.title, latin: r.title_latin, source: r.title_latin_source, song: r.song_id });
      return;
    }
    const vq = opts.videoId != null ? `${VQ} AND id = ?` : VQ;
    for (const r of db.query(vq).all(...(opts.videoId != null ? [opts.videoId] : [])) as any[])
      apply("videos", { id: r.id, text: r.title, latin: r.title_latin, source: r.title_latin_source, song: r.song_id });
    if (opts.videoId != null) return;
    for (const r of db.query(CH).all() as any[])
      apply("video_chapters", { id: r.id, text: r.title, latin: r.title_latin, source: r.title_latin_source, song: r.song_id });
    stats.artists += fillArtistLatin(db, undefined, stats);
  })();
  return stats;
}

function setArtistLatin(db: Db, id: string, latin: string | null, source: string | null) {
  if (latin == null && source == null) db.prepare("DELETE FROM artist_latin WHERE artist_id = ?").run(id);
  else
    db.prepare("INSERT INTO artist_latin (artist_id, name_latin, name_latin_source) VALUES (?, ?, ?) ON CONFLICT(artist_id) DO UPDATE SET name_latin = excluded.name_latin, name_latin_source = excluded.name_latin_source")
      .run(id, latin, source);
}

/** The derived Latin names of Artists of every kind (`artist_latin`), all or the given ones; `manual` is kept. Returns how many changed. */
export function fillArtistLatin(db: Db, ids?: string[], stats?: LatinFillStats): number {
  let n = 0;
  const rows = (ids ? ids.flatMap((id) => db.query("SELECT id, name, name_latin, name_latin_source FROM artist_all WHERE id = ?").all(id)) : db.query("SELECT id, name, name_latin, name_latin_source FROM artist_all").all()) as any[];
  for (const r of rows) {
    if (r.name_latin_source === "manual") continue;
    const next = latinFor(r.name, null);
    if (next.latin === r.name_latin && next.source === r.name_latin_source) continue;
    setArtistLatin(db, r.id, next.latin, next.source);
    n++;
    if (stats) {
      if (next.source === "archive") stats.archive++;
      else if (next.source === "table") stats.table++;
      else stats.cleared++;
    }
  }
  // a gone Artist leaves no Latin row behind
  if (!ids) db.prepare("DELETE FROM artist_latin WHERE artist_id NOT IN (SELECT id FROM artist_all) AND name_latin_source IS NOT 'manual'").run();
  return n;
}
