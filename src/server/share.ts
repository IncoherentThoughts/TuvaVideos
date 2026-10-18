// The `pending_share` queue as the browser drains it (docs/sharing-spec.md §4.3, §6.6; ticket #140). The scan sets
// the flag on a Video Editor's machine (scan.ts); this file reports the queue (`GET /api/share`), hands the browser one
// `write_videos insert` payload per queued Video plus the `local_*` rows they point at (`GET /api/share/pending`), and
// keeps the machine's "Share once, then automatic" answer in `meta`. The companion never calls the archive for it.
import type { PendingShareBatch, PendingShareItem, PendingShareSummary } from "../shared/share";
import type { Db } from "./db";
import { getMeta, machineMode, pendingShareIds, readSessionRecord, setMeta } from "./localCopy/meta";

/** `meta` key: "1" once this machine answered "Share" (§6.6's one question per machine). */
export const SHARE_AUTO_KEY = "share_auto";

export const shareAuto = (db: Db) => getMeta(db, SHARE_AUTO_KEY) === "1";
export const setShareAuto = (db: Db, on: boolean) => setMeta(db, SHARE_AUTO_KEY, on ? "1" : null);

/** The queue, empty on a machine that is not a Video Editor's (its flags wait for the role to come back). */
function queue(db: Db): string[] {
  return machineMode(readSessionRecord(db)) === "editor" ? pendingShareIds(db) : [];
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

export function pendingShareSummary(db: Db): PendingShareSummary {
  const ids = queue(db);
  const auto = shareAuto(db);
  if (!ids.length) return { count: 0, noProvenance: 0, folders: [], newestAt: null, auto };
  const q = marks(ids.length);
  const facts = db
    .query(`SELECT SUM(youtube_id IS NULL AND instagram_id IS NULL AND rutube_id IS NULL) AS bare, MAX(created_at) AS newest FROM videos WHERE id IN (${q})`)
    .get(...ids) as { bare: number | null; newest: string | null };
  const folders = db
    .query(`SELECT r.path, COUNT(DISTINCT c.video_id) AS count FROM copy c JOIN root r ON r.id = c.root_id WHERE c.video_id IN (${q}) GROUP BY r.path ORDER BY count DESC, r.path`)
    .all(...ids) as { path: string; count: number }[];
  return { count: ids.length, noProvenance: facts.bare ?? 0, folders, newestAt: facts.newest, auto };
}

type Row = Record<string, any>;
const flag = (v: unknown) => v === 1 || v === true;
const json = (v: unknown) => {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

/** Each queued Video's insert (defaults, Chapters, Artists in order; `local_*` ids left in place) and the local rows. */
export function pendingShareBatch(db: Db): PendingShareBatch {
  const ids = queue(db);
  const chapters = db.prepare("SELECT * FROM video_chapters WHERE video_id = ? ORDER BY start_s, id");
  const artists = db.prepare("SELECT * FROM video_artists WHERE video_id = ? ORDER BY position, id");
  const items: PendingShareItem[] = [];
  for (const id of ids) {
    const v = db.query("SELECT * FROM videos WHERE id = ?").get(id) as Row | null;
    if (!v || v.deleted_at) continue;
    items.push({
      videoId: id,
      insert: {
        title: v.title,
        type: v.type,
        type_suggested: flag(v.type_suggested),
        song_id: v.song_id,
        proposed_song_id: v.proposed_song_id,
        version_id: v.version_id,
        proposed_version_id: v.proposed_version_id,
        song_suggested: flag(v.song_suggested),
        suggestion_source: v.suggestion_source,
        title_latin: v.title_latin,
        title_latin_source: v.title_latin_source,
        instagram_id: v.instagram_id,
        rutube_id: v.rutube_id,
        youtube_id: v.youtube_id,
        content_hash: v.content_hash,
        chapters: (chapters.all(id) as Row[]).map((c) => ({
          id: c.id, start_s: c.start_s, title: c.title, title_latin: c.title_latin, song_id: c.song_id, proposed_song_id: c.proposed_song_id,
          version_id: c.version_id, proposed_version_id: c.proposed_version_id, suggested: flag(c.suggested), source: c.source,
        })),
        artists: (artists.all(id) as Row[]).map((a) =>
          a.proposed_artist_id ? { proposed_artist_id: a.proposed_artist_id, suggested: flag(a.suggested) } : { artist_id: a.artist_id, suggested: flag(a.suggested) },
        ),
      },
    });
  }
  // The `local_*` rows these Videos point at (a Version's local parent Song included).
  const pointed = (col: string, table: string) => {
    const out = new Set<string>();
    for (const it of items) {
      const vals: unknown[] = col === "artist_id" ? (it.insert.artists ?? []).map((a) => a.artist_id) : [(it.insert as Row)[col], ...(it.insert.chapters ?? []).map((c) => (c as Row)[col])];
      for (const x of vals) if (typeof x === "string") out.add(x);
    }
    if (!out.size) return [] as Row[];
    return db.query(`SELECT * FROM ${table} WHERE id IN (${marks(out.size)}) ORDER BY created_at, id`).all(...out) as Row[];
  };
  const versions = pointed("version_id", "local_version");
  const songIds = new Set(pointed("song_id", "local_song").map((s) => s.id as string));
  for (const v of versions) songIds.add(v.song_id);
  const songs = songIds.size ? (db.query(`SELECT * FROM local_song WHERE id IN (${marks(songIds.size)}) ORDER BY created_at, id`).all(...songIds) as Row[]) : [];
  return {
    items,
    locals: {
      songs: songs.map((s) => ({ id: s.id, create: { name: s.name, english_name: s.english_name ?? null, alternate_titles: s.alternate_titles ?? null } })),
      versions: versions.map((v) => ({
        id: v.id, songId: v.song_id,
        create: {
          label: v.label, lyrics_cyrillic: v.cyrillic ?? null, lyrics_transliteration: v.transliteration ?? null, lyrics_translation: v.translation ?? null,
          footnotes_cyrillic: json(v.footnotes_cyrillic), footnotes_transliteration: json(v.footnotes_transliteration), footnotes_translation: json(v.footnotes_translation),
        },
      })),
      artists: pointed("artist_id", "local_artist").map((a) => ({ id: a.id, create: { name: a.name } })),
    },
  };
}
