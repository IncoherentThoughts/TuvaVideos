// Posters on the companion (docs/sharing-spec.md §6.5; ticket #140): the download that is the second half of the Sync
// job, and the list of local posters a Video Editor's browser uploads. The companion never uploads (#85 superseded).
//
// Download: after the pull is applied, every Shared Video whose `poster_path` names an object this machine does not
// hold is fetched from the private `posters` bucket, 4 at a time, with the Sync's access token, until the job ends or
// the token's `exp` (the remainder resumes next Sync). One file per Video, `thumbs/<uuid>.poster.webp`, written to a
// temporary name and renamed; `video_local.poster_hash` records the hash it holds (null: generated here).
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArchiveEndpoint } from "../shared/archive";
import { POSTER_BUCKET, POSTER_CONCURRENCY, hashMatches, posterAction, posterHashOf, runPool, sha256Hex, type PosterDownloadResult } from "../shared/posters";
export type { PosterDownloadResult };
import type { Db } from "./db";

/** A Video's poster facts as Sync reads them. */
interface PosterRow {
  id: string;
  poster_path: string | null;
  poster_hash: string | null;
}

/** Stop starting downloads this long before the token expires (one request's timeout). */
export const TOKEN_MARGIN_MS = 15_000;

const posterFile = (thumbsDir: string, id: string) => join(thumbsDir, `${id}.poster.webp`);
const setHash = (db: Db, id: string, hash: string | null) =>
  db.query("INSERT INTO video_local (video_id, poster_hash) VALUES (?, ?) ON CONFLICT(video_id) DO UPDATE SET poster_hash = excluded.poster_hash").run(id, hash);

/** Shared Videos (soft-deleted ones too: a restore shows their poster) whose poster needs work. */
function candidates(db: Db): PosterRow[] {
  return db
    .query(
      `SELECT v.id, v.poster_path, l.poster_hash FROM videos v JOIN video_local l ON l.video_id = v.id
       WHERE l.shared = 1 AND (v.poster_path IS NOT NULL OR l.poster_hash IS NOT NULL) ORDER BY v.updated_at DESC, v.id`,
    )
    .all() as PosterRow[];
}

/** The storage URL of one object, fetched with the user's token (the bucket is private, §6.5). */
export const posterObjectUrl = (ep: ArchiveEndpoint, path: string) =>
  `${ep.url}/storage/v1/object/authenticated/${POSTER_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;

export async function downloadPosters(
  db: Db,
  ep: ArchiveEndpoint,
  accessToken: string,
  o: { thumbsDir: string; fetchImpl?: typeof fetch; now?: () => number; expMs?: number | null; onProgress?: (done: number, total: number) => void },
): Promise<PosterDownloadResult> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const out: PosterDownloadResult = { downloaded: 0, adopted: 0, dropped: 0, failed: 0, remaining: 0 };
  const todo: { row: PosterRow; adopt: boolean }[] = [];
  for (const row of candidates(db)) {
    const file = posterFile(o.thumbsDir, row.id);
    const a = posterAction({ posterPath: row.poster_path, posterHash: row.poster_hash, fileExists: existsSync(file) });
    if (a === "drop") {
      // The Shared poster went: forget it, and let the thumbnail pool make a local one (§6.5's fallback).
      await rm(file, { force: true });
      setHash(db, row.id, null);
      db.query("UPDATE video_local SET thumbnail_generated_at = NULL WHERE video_id = ?").run(row.id);
      out.dropped++;
    } else if (a !== "none") todo.push({ row, adopt: a === "adopt-or-download" });
  }
  // A local file that already is the Shared poster (uploaded from here) is recorded without a request.
  const fetchList: PosterRow[] = [];
  for (const t of todo) {
    if (t.adopt) {
      try {
        const bytes = await readFile(posterFile(o.thumbsDir, t.row.id));
        if (hashMatches(t.row.poster_path, await sha256Hex(bytes))) {
          setHash(db, t.row.id, posterHashOf(t.row.poster_path));
          out.adopted++;
          continue;
        }
      } catch {}
    }
    fetchList.push(t.row);
  }
  if (!fetchList.length) return out;
  const total = fetchList.length;
  const r = await runPool(
    fetchList,
    POSTER_CONCURRENCY,
    async (row) => {
      const path = row.poster_path!;
      const res = await fetchImpl(posterObjectUrl(ep, path), {
        headers: { apikey: ep.key, authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TOKEN_MARGIN_MS),
      });
      if (!res.ok) return false;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length) return false;
      const file = posterFile(o.thumbsDir, row.id);
      const tmp = `${file}.${posterHashOf(path)}.part`;
      await writeFile(tmp, bytes);
      await rename(tmp, file);
      setHash(db, row.id, posterHashOf(path));
      out.downloaded++;
      o.onProgress?.(out.downloaded, total);
      return true;
    },
    () => o.expMs == null || now() < o.expMs - TOKEN_MARGIN_MS,
  );
  out.failed = r.failed;
  out.remaining = r.skipped;
  return out;
}

/** One local poster a Video Editor's browser may upload (§6.5): Shared, no `poster_path`, a file generated here. */
export interface PosterUploadCandidate {
  videoId: string;
  /** The Video's stamp, for `write_videos update`'s `p_expected_updated_at`. */
  updatedAt: string;
}

export function posterUploadCandidates(db: Db, thumbsDir: string): PosterUploadCandidate[] {
  const rows = db
    .query(
      `SELECT v.id, v.updated_at FROM videos v JOIN video_local l ON l.video_id = v.id
       WHERE l.shared = 1 AND v.poster_path IS NULL AND v.deleted_at IS NULL AND l.thumbnail_generated_at IS NOT NULL ORDER BY v.updated_at DESC, v.id`,
    )
    .all() as { id: string; updated_at: string }[];
  return rows.filter((r) => existsSync(posterFile(thumbsDir, r.id))).map((r) => ({ videoId: r.id, updatedAt: r.updated_at }));
}
