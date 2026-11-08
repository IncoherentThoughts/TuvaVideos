// Reference size candidates (docs/downloader-spec.md §3.3): the Shared Videos a Video Editor's browser may fill from a
// Copy held here. The companion only reads; the browser writes through `write_videos` (never this process).
import { chooseReferenceCopy, referenceSizeOf, type ReferenceSizeCandidate } from "../shared/referenceSize";
import type { Db } from "./db";

/** Shared, not soft-deleted, all three fields null, and a non-Missing Copy that can fill them. Newest first, like posters. */
export function referenceSizeCandidates(db: Db): ReferenceSizeCandidate[] {
  const videos = db
    .query(
      `SELECT v.id, v.updated_at FROM videos v JOIN video_local l ON l.video_id = v.id
       WHERE l.shared = 1 AND v.deleted_at IS NULL AND v.size_bytes IS NULL AND v.duration_s IS NULL AND v.height IS NULL
       ORDER BY v.updated_at DESC, v.id`,
    )
    .all() as { id: string; updated_at: string }[];
  const copies = db.query("SELECT size, duration_s, height FROM copy WHERE video_id = ? AND missing_since IS NULL ORDER BY id");
  const out: ReferenceSizeCandidate[] = [];
  for (const v of videos) {
    const c = chooseReferenceCopy(copies.all(v.id) as { size: number; duration_s: number | null; height: number | null }[]);
    if (c) out.push({ videoId: v.id, updatedAt: v.updated_at, ...referenceSizeOf(c) });
  }
  return out;
}
