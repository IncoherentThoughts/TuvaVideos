import type { Db } from "./db";
import { log } from "./log";
import { splitAlternates } from "../shared/songNames";
import { foldQuery, foldSegments, foldText } from "../shared/fold";
import {
  effectiveGroups, hasVideoFilters, parseQuery, rowCap, type Group, type ParsedQuery,
} from "../shared/filters";
import { LYRICS_ONLY_SCORE, lyricsSearchable, scoreSegments, songPenalty, videoPenalty } from "../shared/score";
import type { SearchGroup, SearchResponse, SearchRow } from "../shared/types";

export { foldText };

// ---------------------------------------------------------------------------------------------------------------
// Index (spec 6.1, data-model.md Search). One FTS5 table, rebuilt after every scan, import or Latin-title run.
// `text` holds the original and the Latin title (or a Song's alternates) joined with " | "; `text_folded` holds
// the folded form of each, same order, same separator. `kind` is one of video | chapter | artist | song | lyric,
// plus track | album (added by #23 so the Tracks and Albums groups have rows once the Mirror exists).
// ---------------------------------------------------------------------------------------------------------------

export const SEP = " | ";

export function hasTable(db: Db, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Lyric HTML to plain lines: one `<p>` (or `<br>`) is one line, blank paragraphs are dropped, tags and markers stripped. */
export function htmlToLines(html: string | null | undefined): string[] {
  if (!html) return [];
  return html
    .replace(/<\/p\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<sup\b[^>]*>.*?<\/sup>/gis, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? (/^#\d+$/.test(e) ? String.fromCodePoint(Number(e.slice(1))) : m))
    .replace(/[\u200b\u2028\u2029]/g, " ")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export { splitAlternates };

export interface IndexStats {
  video: number; chapter: number; artist: number; song: number; lyric: number; track: number; album: number;
  total: number; ms: number;
}

/** Rebuilds the whole `search` table in one transaction. Mirror sections are skipped when their tables are absent. */
export function rebuildSearchIndex(db: Db): IndexStats {
  const t0 = performance.now();
  const stats: IndexStats = { video: 0, chapter: 0, artist: 0, song: 0, lyric: 0, track: 0, album: 0, total: 0, ms: 0 };
  const ins = db.prepare("INSERT INTO search (kind, ref_id, text, text_folded) VALUES (?, ?, ?, ?)");
  const add = (kind: keyof Omit<IndexStats, "total" | "ms">, ref: string | number, parts: (string | null | undefined)[]) => {
    const p = parts.filter((x): x is string => !!x && x.trim() !== "");
    if (!p.length) return;
    ins.run(kind, String(ref), p.join(SEP), foldSegments(p));
    stats[kind]++;
  };
  db.transaction(() => {
    db.exec("DELETE FROM search");
    // A Video's row carries its linked Song's names (confirmed or Suggested) after the titles, so a Song search finds its Videos.
    for (const r of db.query(VIDEO_INDEX_SQL).all() as VideoIndexRow[]) add("video", r.id, videoSegments(r));
    for (const r of db.query("SELECT id, title, title_latin FROM chapter").all() as { id: number; title: string; title_latin: string | null }[])
      add("chapter", r.id, [r.title, r.title_latin]);
    for (const r of db.query("SELECT id, name, name_latin FROM artist").all() as { id: number; name: string; name_latin: string | null }[])
      add("artist", r.id, [r.name, r.name_latin]);

    // Mirror sections: tables exist only after the import (#25). A schema mismatch skips the section, never the scan.
    const section = (table: string, fn: () => void) => {
      if (!hasTable(db, table)) return;
      try {
        fn();
      } catch (e) {
        log(`search index: skipping ${table}: ${e}`);
      }
    };
    section("mirror_song", () => {
      for (const s of db.query("SELECT id, name, english_name, alternate_titles, alternate_spellings FROM mirror_song").all() as any[])
        // Positional segments for songPenalty: 0 name, 1 English (the name again when absent, so alternates stay at 2+), then
      // one folded segment per alternate title and per alternate spelling.
      add("song", s.id, [s.name, s.english_name ?? s.name, ...splitAlternates(s.alternate_titles), ...splitAlternates(s.alternate_spellings)]);
    });
    section("mirror_version", () => {
      for (const v of db.query("SELECT id, cyrillic, transliteration, translation FROM mirror_version").all() as any[]) {
        for (const script of ["cyrillic", "transliteration", "translation"] as const) {
          htmlToLines(v[script]).forEach((line, i) => add("lyric", `${v.id}:${script}:${i + 1}`, [line]));
        }
      }
    });
    section("mirror_track", () => {
      for (const t of db.query("SELECT id, name FROM mirror_track").all() as any[]) add("track", t.id, [t.name]);
    });
    section("mirror_album", () => {
      for (const a of db.query("SELECT id, name FROM mirror_album").all() as any[]) add("album", a.id, [a.name]);
    });
  })();
  stats.total = stats.video + stats.chapter + stats.artist + stats.song + stats.lyric + stats.track + stats.album;
  stats.ms = Math.round(performance.now() - t0);
  return stats;
}

/** One Video's index row, replaced in place (a title edit does not need a rebuild of the lyrics). */
interface VideoIndexRow { id: number; title: string; title_latin: string | null; song_name: string | null; song_en: string | null }
const VIDEO_INDEX_SQL = `SELECT v.id, v.title, v.title_latin, s.name AS song_name, s.english_name AS song_en
  FROM video v LEFT JOIN mirror_song s ON s.id = v.song_id`;
const videoSegments = (r: VideoIndexRow) => [r.title, r.title_latin ?? "", r.song_name, r.song_en];

export function reindexVideo(db: Db, id: number) {
  db.query("DELETE FROM search WHERE kind = 'video' AND ref_id = ?").run(String(id));
  let r: VideoIndexRow | null = null;
  try {
    r = db.query(`${VIDEO_INDEX_SQL} WHERE v.id = ?`).get(id) as VideoIndexRow | null;
  } catch {
    const v = db.query("SELECT id, title, title_latin FROM video WHERE id = ?").get(id) as VideoIndexRow | null; // no Mirror tables yet
    r = v && { ...v, song_name: null, song_en: null };
  }
  if (!r) return;
  const p = videoSegments(r).filter((x): x is string => !!x && x.trim() !== "");
  db.query("INSERT INTO search (kind, ref_id, text, text_folded) VALUES ('video', ?, ?, ?)").run(String(r.id), p.join(SEP), foldSegments(p));
}

/** One Chapter's index row, replaced in place (or removed when the Chapter is gone). */
export function reindexChapter(db: Db, id: number) {
  db.query("DELETE FROM search WHERE kind = 'chapter' AND ref_id = ?").run(String(id));
  const r = db.query("SELECT id, title, title_latin FROM chapter WHERE id = ?").get(id) as { id: number; title: string; title_latin: string | null } | null;
  if (!r) return;
  const p = [r.title, r.title_latin].filter((x): x is string => !!x && x.trim() !== "");
  if (!p.length) return;
  db.query("INSERT INTO search (kind, ref_id, text, text_folded) VALUES ('chapter', ?, ?, ?)").run(String(r.id), p.join(SEP), foldSegments(p));
}

/** One Artist's index row (a Local Artist created from the chip editor). */
export function indexArtist(db: Db, id: number) {
  db.query("DELETE FROM search WHERE kind = 'artist' AND ref_id = ?").run(String(id));
  const r = db.query("SELECT id, name, name_latin FROM artist WHERE id = ?").get(id) as { id: number; name: string; name_latin: string | null } | null;
  if (!r) return;
  const p = [r.name, r.name_latin].filter((x): x is string => !!x && x.trim() !== "");
  db.query("INSERT INTO search (kind, ref_id, text, text_folded) VALUES ('artist', ?, ?, ?)").run(String(r.id), p.join(SEP), foldSegments(p));
}

/** Kept for ticket #22's callers. */
export const rebuildVideoSearch = rebuildSearchIndex;

// ---------------------------------------------------------------------------------------------------------------
// Query (spec 6.2). FTS5 supplies lyric candidates and prefix candidates; an instr() scan over the short rows adds
// "contains" candidates (an FTS token can only match from its start); the #12 scorer orders them per group.
// ---------------------------------------------------------------------------------------------------------------

export interface SearchEnv {
  /** True when the Root is mounted and answering. */
  isRootAvailable(rootId: number): boolean;
}

interface Cand {
  kind: string;
  ref: string;
  text: string;
  folded: string;
}

interface VideoFacts {
  id: number;
  title: string;
  type: string;
  fav: boolean;
  songId: string | null;
  songSuggested: boolean;
  durationS: number | null;
  available: boolean;
  artistKeys: string[];
}

function loadVideoFacts(db: Db, env: SearchEnv, needArtists: boolean): Map<number, VideoFacts> {
  const out = new Map<number, VideoFacts>();
  for (const v of db.query("SELECT id, title, type, favorited_at, song_id, song_suggested FROM video").all() as any[])
    out.set(v.id, { id: v.id, title: v.title, type: v.type, fav: !!v.favorited_at, songId: v.song_id, songSuggested: !!v.song_suggested, durationS: null, available: false, artistKeys: [] });
  for (const c of db.query("SELECT video_id, root_id, missing_since, duration_s FROM copy").all() as any[]) {
    const f = out.get(c.video_id);
    if (!f) continue;
    const ok = !c.missing_since && env.isRootAvailable(c.root_id);
    if (ok) f.available = true;
    if (c.duration_s != null && (f.durationS == null || ok)) f.durationS = c.duration_s;
  }
  if (needArtists) {
    for (const r of db.query("SELECT va.video_id, a.name, a.name_latin FROM video_artist va JOIN artist a ON a.id = va.artist_id").all() as any[]) {
      const f = out.get(r.video_id);
      if (!f) continue;
      f.artistKeys.push(foldQuery(r.name));
      if (r.name_latin) f.artistKeys.push(foldQuery(r.name_latin));
    }
  }
  return out;
}

const nameOf = (text: string) => text.split(SEP)[0] ?? text;

export type SearchResult = SearchResponse & { parsed: ParsedQuery };

export function runSearch(db: Db, env: SearchEnv, q: string, opts: { cap?: number } = {}): SearchResult {
  const t0 = performance.now();
  const parsed = parseQuery(q);
  const needle = foldQuery(parsed.text);
  const groups = effectiveGroups(parsed);
  // `opts.cap` lets the results page (/search) ask for more rows than the dropdown shows.
  const cap = opts.cap && opts.cap > 0 ? opts.cap : rowCap(parsed);
  const bare = needle === "";
  if (bare && !(parsed.groups.length || hasVideoFilters(parsed) || parsed.lyricsOnly)) return { needle, groups: [], ms: 0, parsed };

  const wantVideos = groups.includes("videos");
  const needFacts = wantVideos || groups.includes("artists");
  const facts = needFacts ? loadVideoFacts(db, env, parsed.artists.length > 0) : new Map<number, VideoFacts>();
  const artistWanted = parsed.artists.map(foldQuery);
  const videoOk = (f: VideoFacts | undefined) =>
    !!f &&
    (!parsed.available || f.available) &&
    (!parsed.fav || f.fav) &&
    (!parsed.types.length || (parsed.types as string[]).includes(f.type)) &&
    (!artistWanted.length || artistWanted.every((a) => f.artistKeys.includes(a)));

  // ---- candidates
  const cands: Cand[] = [];
  const seen = new Set<string>();
  const take = (r: { kind: string; ref_id: string; text: string; text_folded: string }) => {
    const key = `${r.kind}\0${r.ref_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    cands.push({ kind: r.kind, ref: r.ref_id, text: r.text, folded: r.text_folded });
  };
  if (bare) {
    const kinds: string[] = [];
    if (groups.includes("videos")) kinds.push("video", ...(parsed.fav ? ["chapter"] : []));
    if (groups.includes("songs")) kinds.push("song");
    if (groups.includes("artists")) kinds.push("artist");
    if (groups.includes("tracks")) kinds.push("track");
    if (groups.includes("albums")) kinds.push("album");
    for (const k of kinds) for (const r of db.query("SELECT kind, ref_id, text, text_folded FROM search WHERE kind = ?").all(k) as any[]) take(r);
  } else {
    const tokens = needle.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length) {
      const match = `text_folded : (${tokens.map((t) => `"${t}"*`).join(" AND ")})`;
      const lyricsOk = lyricsSearchable(needle);
      for (const r of db.query("SELECT kind, ref_id, text, text_folded FROM search WHERE search MATCH ? LIMIT 5000").all(match) as any[]) {
        if (r.kind === "lyric" && !lyricsOk) continue;
        take(r);
      }
    }
    for (const r of db.query("SELECT kind, ref_id, text, text_folded FROM search WHERE kind <> 'lyric' AND instr(text_folded, ?) > 0").all(needle) as any[]) take(r);
  }

  // ---- score and bucket
  interface Scored { c: Cand; score: number; name: string }
  const buckets: Record<Group, Scored[]> = { songs: [], videos: [], artists: [], tracks: [], albums: [] };
  const lyricHit = new Map<string, string>(); // song id -> first matching line
  const lyricOnlySongs = new Set<string>();
  const scoreOf = (c: Cand, penalty?: (i: number) => number) => (bare ? 2 : scoreSegments(c.folded, needle, penalty));

  const versionSong = new Map<string, string>();
  const lyricCands = cands.filter((c) => c.kind === "lyric");
  if (lyricCands.length && groups.includes("songs")) {
    try {
      const vs = new Set(lyricCands.map((c) => c.ref.split(":")[0]!));
      for (const r of db.query("SELECT id, song_id FROM mirror_version").all() as any[]) if (vs.has(r.id)) versionSong.set(r.id, r.song_id);
    } catch {}
  }

  for (const c of cands) {
    if (c.kind === "video" && wantVideos && !parsed.lyricsOnly) {
      const s = scoreOf(c, videoPenalty);
      if (s !== null && videoOk(facts.get(Number(c.ref)))) buckets.videos.push({ c, score: s, name: nameOf(c.text) });
    } else if (c.kind === "chapter" && wantVideos && !parsed.lyricsOnly) {
      const s = scoreOf(c);
      if (s === null) continue;
      const ch = db.query("SELECT video_id, favorited_at FROM chapter WHERE id = ?").get(Number(c.ref)) as { video_id: number; favorited_at: string | null } | null;
      if (!ch) continue;
      const f = facts.get(ch.video_id);
      // #fav on a Chapter row means the Chapter itself is a Favorite
      if (!videoOk(f && { ...f, fav: parsed.fav ? !!ch.favorited_at : f.fav })) continue;
      buckets.videos.push({ c, score: s, name: `${f!.title} ${nameOf(c.text)}` });
    } else if (c.kind === "artist" && groups.includes("artists") && !parsed.lyricsOnly) {
      const s = scoreOf(c);
      if (s !== null) buckets.artists.push({ c, score: s, name: nameOf(c.text) });
    } else if (c.kind === "song" && groups.includes("songs") && !parsed.lyricsOnly) {
      const s = scoreOf(c, songPenalty);
      if (s !== null) buckets.songs.push({ c, score: s, name: nameOf(c.text) });
    } else if (c.kind === "track" && groups.includes("tracks") && !parsed.lyricsOnly) {
      const s = scoreOf(c);
      if (s !== null) buckets.tracks.push({ c, score: s, name: nameOf(c.text) });
    } else if (c.kind === "album" && groups.includes("albums") && !parsed.lyricsOnly) {
      const s = scoreOf(c);
      if (s !== null) buckets.albums.push({ c, score: s, name: nameOf(c.text) });
    } else if (c.kind === "lyric" && groups.includes("songs") && !bare && c.folded.includes(needle)) {
      const songId = versionSong.get(c.ref.split(":")[0]!);
      if (songId && !lyricHit.has(songId)) lyricHit.set(songId, c.text);
    }
  }
  // Songs found by lyrics only (score 5); a Song found by name keeps its name score and also shows the line.
  const songIds = new Set(buckets.songs.map((b) => b.c.ref));
  for (const songId of lyricHit.keys()) {
    if (songIds.has(songId)) continue;
    lyricOnlySongs.add(songId);
    buckets.songs.push({ c: { kind: "song", ref: songId, text: "", folded: "" }, score: LYRICS_ONLY_SCORE, name: "" });
  }

  // ---- row builders (only for the rows that survive the cap)
  const one = <T>(sql: string, ...p: any[]): T | null => {
    try {
      return db.query(sql).get(...p) as T | null;
    } catch {
      return null;
    }
  };
  const many = <T>(sql: string, ...p: any[]): T[] => {
    try {
      return db.query(sql).all(...p) as T[];
    } catch {
      return [];
    }
  };
  /** Videos performing a Song: by their Song pointer (startS null) or through a Chapter (its first start). */
  const songVideos = (songId: string) =>
    many<{ id: number; startS: number | null }>(
      `SELECT id, NULL AS startS FROM video WHERE song_id = ?
       UNION ALL SELECT video_id AS id, MIN(start_s) AS startS FROM chapter WHERE song_id = ? AND video_id NOT IN (SELECT id FROM video WHERE song_id = ?) GROUP BY video_id
       ORDER BY id`, songId, songId, songId);
  const build = (g: Group, b: Scored): SearchRow | null => {
    const c = b.c;
    if (g === "videos") {
      if (c.kind === "video") {
        const f = facts.get(Number(c.ref))!;
        const songs = f.songId ? many<{ name: string }>("SELECT name FROM mirror_song WHERE id = ?", f.songId).map((s) => s.name) : [];
        return { kind: "video", id: f.id, title: f.title, type: f.type as any, durationS: f.durationS, available: f.available, songs, songSuggested: f.songSuggested };
      }
      const ch = one<{ id: number; video_id: number; start_s: number; title: string }>("SELECT id, video_id, start_s, title FROM chapter WHERE id = ?", Number(c.ref));
      if (!ch) return null;
      const f = facts.get(ch.video_id)!;
      return { kind: "chapter", id: ch.id, videoId: ch.video_id, videoTitle: f.title, title: ch.title, startS: ch.start_s, available: f.available };
    }
    if (g === "artists") {
      const a = one<{ id: number; name: string; mirror_id: string | null; n: number }>(
        "SELECT a.id, a.name, a.mirror_id, (SELECT COUNT(*) FROM video_artist WHERE artist_id = a.id) n FROM artist a WHERE a.id = ?", Number(c.ref));
      return a ? { kind: "artist", id: a.id, name: a.name, local: a.mirror_id == null, videoCount: a.n } : null;
    }
    if (g === "songs") {
      const s = one<{ id: string; name: string; english_name: string | null; is_hidden: number }>("SELECT id, name, english_name, is_hidden FROM mirror_song WHERE id = ?", c.ref);
      if (!s) return null;
      return { kind: "song", id: s.id, name: s.name, englishName: s.english_name, hidden: !!s.is_hidden, viaLyrics: lyricOnlySongs.has(s.id), lyric: lyricHit.get(s.id) ?? null, videos: songVideos(s.id) };
    }
    if (g === "tracks") {
      const t = one<{ id: string; name: string; album_id: string; song_id: string | null; version_id: string | null }>("SELECT id, name, album_id, song_id, version_id FROM mirror_track WHERE id = ?", c.ref);
      if (!t) return null;
      const album = one<{ name: string; artist_id: string }>("SELECT name, artist_id FROM mirror_album WHERE id = ?", t.album_id);
      let by = many<{ name: string }>(
        "SELECT ar.name FROM mirror_track_artist ta JOIN mirror_artist ar ON ar.id = ta.artist_id WHERE ta.track_id = ? ORDER BY ta.position", t.id).map((x) => x.name);
      if (!by.length && album) by = many<{ name: string }>("SELECT name FROM mirror_artist WHERE id = ?", album.artist_id).map((x) => x.name);
      return { kind: "track", id: t.id, name: t.name, album: album?.name ?? null, by, songId: t.song_id, versionId: t.version_id };
    }
    const a = one<{ id: string; name: string; release_year: number | null; artist_id: string }>("SELECT id, name, release_year, artist_id FROM mirror_album WHERE id = ?", c.ref);
    if (!a) return null;
    const by = one<{ name: string }>("SELECT name FROM mirror_artist WHERE id = ?", a.artist_id);
    return { kind: "album", id: a.id, name: a.name, year: a.release_year, by: by?.name ?? null };
  };

  const labels: Record<Group, string> = { songs: "Songs", videos: "Videos", artists: "Artists", tracks: "Tracks", albums: "Albums" };
  const out: SearchGroup[] = [];
  for (const g of groups) {
    let list = buckets[g];
    if (g === "artists" && hasVideoFilters(parsed)) {
      // Artists narrowed by Video filters: only those with a Video that passes them.
      const ok = new Set<number>();
      for (const r of db.query("SELECT video_id, artist_id FROM video_artist").all() as { video_id: number; artist_id: number }[])
        if (videoOk(facts.get(r.video_id))) ok.add(r.artist_id);
      list = list.filter((b) => ok.has(Number(b.c.ref)));
    }
    if (!list.length) continue;
    list.sort((x, y) => x.score - y.score || x.name.localeCompare(y.name));
    const rows: SearchRow[] = [];
    for (const b of list) {
      if (rows.length >= cap) break;
      const row = build(g, b);
      if (row) rows.push(row);
    }
    out.push({ key: g, label: labels[g], total: list.length, rows });
  }
  return { needle, groups: out, ms: Math.round((performance.now() - t0) * 100) / 100, parsed };
}
