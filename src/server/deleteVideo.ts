// Deleting a Video from the library (the Now playing page's Delete button, the grid's right-click menu). Two kinds:
// the entry only (every Copy's file stays on disk), or the entry with its media (each Copy's file moved to the
// Trash; a Copy on an unmounted Root or already Missing cannot be). Either way the Video's own rows go: Copies,
// Chapters, Artists, rejections, audio settings, search rows, Thumbnails and Fallbacks. While any file stays on disk
// the Video's identity is kept in `deleted_video` so the scanner never brings it back (migration 0011).
// This is the hard local delete of a Standalone or Unshared Video (sharing-spec §4.5); a Shared Video is soft-deleted
// through the archive (`write_videos` op delete, ticket #116) and is refused here.
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { run } from "./proc";
import type { Roots } from "./roots";

export interface DeleteResult {
  deleted: true;
  /** Files moved to the Trash. */
  trashed: string[];
  /** Files left on disk (entry-only delete, an unmounted Root, a Missing Copy, or `trash` failed), with why. */
  kept: { path: string; reason: string }[];
  /** True when the identity was recorded so a scan skips the files left behind. */
  tombstoned: boolean;
}

interface CopyRow {
  id: number;
  root_id: number;
  rel_path: string;
  fallback_file: string | null;
  missing_since: string | null;
}

export async function deleteVideo(
  db: Db,
  cfg: Pick<Config, "thumbsDir" | "remuxDir" | "trash">,
  roots: Roots,
  videoId: string,
  opts: { media: boolean },
): Promise<DeleteResult | { refused: string } | null> {
  const v = db.query("SELECT id, youtube_id, content_hash, title, shared FROM video_full WHERE id = ?").get(videoId) as
    | { id: string; youtube_id: string | null; content_hash: string | null; title: string; shared: number }
    | null;
  if (!v) return null;
  if (v.shared) return { refused: "a Shared Video is deleted through the archive, not here" };
  const copies = db.query("SELECT id, root_id, rel_path, fallback_file, missing_since FROM copy WHERE video_id = ?").all(videoId) as CopyRow[];

  const trashed: string[] = [];
  const kept: DeleteResult["kept"] = [];
  for (const c of copies) {
    const root = roots.get(c.root_id);
    const path = join(root?.path ?? "", c.rel_path);
    if (!opts.media) kept.push({ path, reason: "kept" });
    else if (c.missing_since) continue; // nothing on disk to keep or trash
    else if (!root || !roots.isAvailable(c.root_id)) kept.push({ path, reason: "drive not mounted" });
    else {
      const r = await run(cfg.trash, [path], { timeout: 30_000 });
      if (r.code === 0) trashed.push(path);
      else kept.push({ path, reason: r.err.trim() || `trash exited ${r.code}` });
    }
  }

  // Caches only: removed outright.
  const caches = [
    ...copies.filter((c) => c.fallback_file).map((c) => join(cfg.remuxDir, c.fallback_file!)),
    join(cfg.thumbsDir, `${videoId}.poster.webp`),
    join(cfg.thumbsDir, `${videoId}.strip.webp`),
  ];
  await Promise.all(caches.map((f) => unlink(f).catch(() => {})));

  const tombstoned = kept.length > 0;
  db.transaction(() => {
    if (tombstoned) {
      db.prepare("INSERT OR REPLACE INTO deleted_video (youtube_id, content_hash, title, deleted_at) VALUES (?, ?, ?, ?)").run(
        v.youtube_id, v.youtube_id ? null : v.content_hash, v.title, new Date().toISOString(),
      );
    }
    db.prepare("DELETE FROM search WHERE kind = 'chapter' AND ref_id IN (SELECT id FROM video_chapters WHERE video_id = ?)").run(videoId);
    db.prepare("DELETE FROM search WHERE kind = 'video' AND ref_id = ?").run(videoId);
    db.prepare("DELETE FROM copy WHERE video_id = ?").run(videoId);
    // Chapters, Artist links, rejections, the side tables, audio settings and Shelved edits go with the row (ON DELETE CASCADE).
    db.prepare("DELETE FROM videos WHERE id = ?").run(videoId);
  })();
  return { deleted: true, trashed, kept, tombstoned };
}

/** The scanner's check: a file with this identity belongs to a deleted Video. */
export function isDeleted(db: Db, id: { youtubeId: string | null; contentHash: string | null }): boolean {
  if (id.youtubeId) return !!db.query("SELECT 1 FROM deleted_video WHERE youtube_id = ?").get(id.youtubeId);
  if (id.contentHash) return !!db.query("SELECT 1 FROM deleted_video WHERE content_hash = ?").get(id.contentHash);
  return false;
}
