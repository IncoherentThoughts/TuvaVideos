// The companion's read side of the client write seam (docs/sharing-spec.md §4.3, §4.5, §4.9; ticket #145). The
// companion never writes a Shared row itself (only Sync and `/api/cache/apply` do); these reads give the browser what
// its `writeLink` needs: the kind of each effective id (the pointer pairs), the matchers' Suggested values for Shared
// Videos on a Video Editor's machine, and the scan warning for files of a soft-deleted Shared Video.
import { join } from "node:path";
import type { Db } from "./db";
import { applyPerformanceDefaults } from "./defaults";
import { artistKind, songKind, versionKind, type RowKind } from "./localCopy/rows";
import type { Roots } from "./roots";
import { suggestSongsFromTitles, type SongSuggestRow } from "./songSuggest";

const ids = (raw: string | null) => [...new Set((raw ?? "").split(",").map((s) => s.trim()).filter((s) => /^[0-9a-zA-Z_-]{8,64}$/.test(s)))].slice(0, 200);

/** `GET /api/kinds?songs=&versions=&artists=`: archive, Proposed or Local, per id (unknown ids are left out). */
export function kindsOf(db: Db, q: URLSearchParams) {
  const map = (list: string[], kind: (db: Db, id: string) => RowKind | null) => Object.fromEntries(list.flatMap((id) => (kind(db, id) ? [[id, kind(db, id)!]] : [])));
  return { songs: map(ids(q.get("songs")), songKind), versions: map(ids(q.get("versions")), versionKind), artists: map(ids(q.get("artists")), artistKind) };
}

/** One matcher result for a Shared Video, in writeOps.ts's `SuggestPatch` shape. */
export interface SharedSuggestion {
  videoId: string;
  updatedAt: string;
  title: string;
  patch: { type?: "song" | "concert"; songId?: string; source: "performance" | "title" };
}

/**
 * `GET /api/suggestions/shared` (§4.3): the scan defaults and the title Song matcher run against Shared Videos, writing
 * nothing. Only where no Song and no manual value was ever set (`suggestion_source IS NULL`); never a Local Song.
 */
export function sharedSuggestions(db: Db): SharedSuggestion[] {
  const defaults: { videoId: string; songIds: string[] }[] = [];
  applyPerformanceDefaults(db, { scope: "shared", report: defaults });
  const titles: SongSuggestRow[] = [];
  suggestSongsFromTitles(db, { scope: "shared", report: titles });
  const video = db.prepare("SELECT updated_at, title, type, type_suggested FROM video_full WHERE id = ?");
  const out: SharedSuggestion[] = [];
  const seen = new Set<string>();
  for (const d of defaults) {
    const v = video.get(d.videoId) as { updated_at: string; title: string } | null;
    if (!v) continue;
    seen.add(d.videoId);
    out.push({
      videoId: d.videoId, updatedAt: v.updated_at, title: v.title,
      patch: d.songIds.length === 1 ? { type: "song", songId: d.songIds[0]!, source: "performance" } : { type: "concert", source: "performance" },
    });
  }
  for (const t of titles) {
    if (seen.has(t.videoId) || songKind(db, t.songId) === "local") continue;
    const v = video.get(t.videoId) as { updated_at: string; title: string; type: string; type_suggested: number } | null;
    if (!v) continue;
    out.push({ videoId: t.videoId, updatedAt: v.updated_at, title: v.title, patch: { songId: t.songId, source: "title", ...(v.type === "other" && !v.type_suggested ? { type: "song" as const } : {}) } });
  }
  return out;
}

/** One entry of the scan warning (§4.5). */
export interface DeletedMatch {
  id: string;
  title: string;
  updatedAt: string;
  deletedAt: string;
  deletedBy: string | null;
  reason: string | null;
  files: string[];
}

/** `GET /api/videos/deleted-matches`: soft-deleted Videos this machine holds a present Copy of. */
export function deletedMatches(db: Db, roots: Roots): DeletedMatch[] {
  const rows = db
    .query(
      `SELECT v.id, v.title, v.updated_at, v.deleted_at, v.deleted_by, v.delete_reason, c.root_id, c.rel_path
         FROM videos v JOIN copy c ON c.video_id = v.id
        WHERE v.deleted_at IS NOT NULL AND c.missing_since IS NULL ORDER BY v.deleted_at DESC, v.id, c.rel_path`,
    )
    .all() as { id: string; title: string; updated_at: string; deleted_at: string; deleted_by: string | null; delete_reason: string | null; root_id: number; rel_path: string }[];
  const out = new Map<string, DeletedMatch>();
  for (const r of rows) {
    let m = out.get(r.id);
    if (!m) out.set(r.id, (m = { id: r.id, title: r.title, updatedAt: r.updated_at, deletedAt: r.deleted_at, deletedBy: r.deleted_by, reason: r.delete_reason, files: [] }));
    m.files.push(join(roots.get(r.root_id)?.path ?? "", r.rel_path));
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------------------------
// Proposed rows, Elevate, Expose, Repoint (§3.4, §3.5, §4.4, §4.6; ticket #146)
// ---------------------------------------------------------------------------------------------------------------

export type RowTable = "song" | "version" | "artist";

/** A Video pointing at the row (its Song or Version pointer), with what `writeLink` needs to repoint it. */
export interface RowUseVideo {
  id: string;
  shared: boolean;
  updatedAt: string;
  title: string;
  songId: string | null;
  versionId: string | null;
}
/** A Chapter pointing at the row. */
export interface RowUseChapter {
  id: string;
  videoId: string;
  shared: boolean;
  startS: number;
  title: string;
  suggested: boolean;
  updatedAt: string;
  songId: string | null;
  versionId: string | null;
}
/** A Video linking the Artist, with its whole ordered list (a repoint on an Unshared Video is an `artists.set`). */
export interface RowUseArtistLink {
  videoId: string;
  shared: boolean;
  updatedAt: string;
  artistIds: string[];
}

/** `GET /api/rows/:table/:id`: one Song, Version or Artist as the Proposed / Elevate / Expose / Repoint controls need it. */
export interface RowInfo {
  table: RowTable;
  id: string;
  kind: RowKind | null;
  name: string | null;
  /** A Proposed row's stamp (`write_proposed_* update`); null otherwise. */
  updatedAt: string | null;
  /** A Proposed row's columns, in the archive's names (`name`, `english_name`, … / `label`). */
  fields: Record<string, unknown> | null;
  /** An archive Song or Artist hidden on the lyrics website. */
  hidden: boolean;
  /** Has a `video_exposed_songs` row (§3.5). */
  exposed: boolean;
  /** A Version's Song: its id, kind and whether it is hidden (an elevated Version under a public Song is public, §4.4). */
  parent: { id: string; kind: RowKind | null; hidden: boolean } | null;
  uses: { videos: RowUseVideo[]; chapters: RowUseChapter[]; artistLinks: RowUseArtistLink[] };
}

export function rowInfo(db: Db, table: RowTable, id: string): RowInfo | null {
  const kind = table === "song" ? songKind(db, id) : table === "version" ? versionKind(db, id) : artistKind(db, id);
  if (!kind) return null;
  const one = <T>(sql: string, ...a: string[]) => db.query(sql).get(...a) as T | null;
  let name: string | null = null;
  let hidden = false;
  let parent: RowInfo["parent"] = null;
  if (table === "song") {
    const s = one<{ name: string; is_hidden: number }>("SELECT name, is_hidden FROM song_all WHERE id = ?", id);
    name = s?.name ?? null;
    hidden = !!s?.is_hidden;
  } else if (table === "version") {
    const v = one<{ label: string; song_id: string | null }>("SELECT label, song_id FROM version_all WHERE id = ?", id);
    name = v?.label ?? null;
    if (v?.song_id) {
      const s = one<{ is_hidden: number }>("SELECT is_hidden FROM song_all WHERE id = ?", v.song_id);
      parent = { id: v.song_id, kind: songKind(db, v.song_id), hidden: !!s?.is_hidden };
    }
  } else {
    const a = one<{ name: string; is_hidden: number }>("SELECT name, is_hidden FROM artist_all WHERE id = ?", id);
    name = a?.name ?? null;
    hidden = !!a?.is_hidden;
  }
  let updatedAt: string | null = null;
  let fields: Record<string, unknown> | null = null;
  if (kind === "proposed") {
    const r = one<Record<string, unknown>>(`SELECT * FROM video_proposed_${table}s WHERE id = ?`, id);
    if (r) {
      updatedAt = (r.updated_at as string) ?? null;
      const keep = table === "song" ? ["name", "english_name", "alternate_titles", "notes"] : table === "version" ? ["label", "song_id", "proposed_song_id", "source"] : ["name"];
      fields = Object.fromEntries(keep.map((k) => [k, r[k] ?? null]));
    }
  }
  const exposed = table !== "version" && !!one(`SELECT 1 FROM video_exposed_songs WHERE ${table === "song" ? "song_id" : "artist_id"} = ?`, id);

  const col = table === "song" ? "song_id" : "version_id";
  const videos: RowUseVideo[] =
    table === "artist"
      ? []
      : (db.query(`SELECT id, shared, updated_at, title, song_id, version_id FROM video_full WHERE ${col} = ? ORDER BY created_at, id`).all(id) as {
          id: string; shared: number; updated_at: string; title: string; song_id: string | null; version_id: string | null;
        }[]).map((v) => ({ id: v.id, shared: !!v.shared, updatedAt: v.updated_at, title: v.title, songId: v.song_id, versionId: v.version_id }));
  const chapters: RowUseChapter[] =
    table === "artist"
      ? []
      : (db.query(
          `SELECT c.id, c.video_id, v.shared, c.start_s, c.title, c.suggested, c.updated_at, c.song_id, c.version_id
             FROM chapter_full c JOIN video_full v ON v.id = c.video_id WHERE c.${col} = ? ORDER BY c.video_id, c.start_s`,
        ).all(id) as { id: string; video_id: string; shared: number; start_s: number; title: string | null; suggested: number; updated_at: string; song_id: string | null; version_id: string | null }[]).map((c) => ({
          id: c.id, videoId: c.video_id, shared: !!c.shared, startS: Number(c.start_s), title: c.title ?? "", suggested: !!c.suggested, updatedAt: c.updated_at, songId: c.song_id, versionId: c.version_id,
        }));
  const artistLinks: RowUseArtistLink[] = [];
  if (table === "artist") {
    const vids = db.query("SELECT DISTINCT a.video_id, v.shared, v.updated_at FROM video_artist_full a JOIN video_full v ON v.id = a.video_id WHERE a.artist_id = ? ORDER BY a.video_id").all(id) as {
      video_id: string; shared: number; updated_at: string;
    }[];
    const list = db.prepare("SELECT artist_id FROM video_artist_full WHERE video_id = ? ORDER BY position");
    for (const v of vids) artistLinks.push({ videoId: v.video_id, shared: !!v.shared, updatedAt: v.updated_at, artistIds: (list.all(v.video_id) as { artist_id: string }[]).map((r) => r.artist_id) });
  }
  return { table, id, kind, name, updatedAt, fields, hidden, exposed, parent, uses: { videos, chapters, artistLinks } };
}
