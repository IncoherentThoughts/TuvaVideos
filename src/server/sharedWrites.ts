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
