// Posters (docs/sharing-spec.md §6.5; ticket #140): the pure parts both halves share. The companion downloads Shared
// posters as the second half of the Sync job (src/server/posters.ts); the browser uploads a Video Editor's local
// posters (src/web/sharing.ts). Paths are immutable and content-addressed: `<video uuid>/<sha256 prefix>.webp`, so the
// prefix is the poster's hash and `video_local.poster_hash` records which Shared object a machine holds.
import type { EditInput } from "./archiveWire";

/** The private bucket (§6.5). */
export const POSTER_BUCKET = "posters";
/** Downloads and uploads run this many at a time (§6.5). */
export const POSTER_CONCURRENCY = 4;
/** Hex digits of the sha256 a path carries (the bucket's check allows 8 to 64). */
export const POSTER_HASH_LEN = 16;
/** `cacheControl` of an upload: paths never change their bytes. */
export const POSTER_CACHE_SECONDS = "31536000";

const PATH_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8,64})\.webp$/;

/** The hash part of a `poster_path`, or null when the path is not the bucket's shape. */
export function posterHashOf(path: string | null | undefined): string | null {
  const m = path ? PATH_RE.exec(path) : null;
  return m ? m[2]! : null;
}

/** The path an upload uses: the Video's id and the first `POSTER_HASH_LEN` hex digits of the bytes' sha256. */
export function posterPathFor(videoId: string, sha256Hex: string): string {
  return `${videoId.toLowerCase()}/${sha256Hex.toLowerCase().slice(0, POSTER_HASH_LEN)}.webp`;
}

/** True when the local file's sha256 is the one the path names (a prefix match: the path keeps only a prefix). */
export function hashMatches(path: string | null | undefined, sha256Hex: string): boolean {
  const h = posterHashOf(path);
  return !!h && sha256Hex.toLowerCase().startsWith(h);
}

export type PosterAction = "none" | "download" | "adopt-or-download" | "drop";

/**
 * What Sync does with one Video's poster (§6.5). `posterHash` is `video_local.poster_hash` (null: whatever file is
 * there was generated here). A held hash that matches with its file present is done; a local file with no recorded
 * hash may already be the Shared poster (this machine uploaded it), so its bytes are checked before downloading; a
 * poster path cleared upstream drops the downloaded file so the thumbnail pool generates one again.
 */
export function posterAction(o: { posterPath: string | null; posterHash: string | null; fileExists: boolean }): PosterAction {
  const want = posterHashOf(o.posterPath);
  if (!want) return o.posterHash ? "drop" : "none";
  if (o.posterHash === want && o.fileExists) return "none";
  if (o.posterHash == null && o.fileExists) return "adopt-or-download";
  return "download";
}

/** What the download half of a Sync did (in `SyncResponse.posters`). */
export interface PosterDownloadResult {
  /** Fetched and written. */
  downloaded: number;
  /** A local file whose bytes were already the Shared poster (this machine uploaded it): recorded, not fetched. */
  adopted: number;
  /** Downloaded files dropped because their `poster_path` was cleared. */
  dropped: number;
  failed: number;
  /** Not started before the token's `exp` (or another stop): the next Sync picks them up. */
  remaining: number;
}

/** The history row of a poster upload (`write_videos update` with `poster_path`). */
export function posterEdit(path: string, old: string | null = null): EditInput {
  return { event_type: "video.poster_changed", field_name: "poster_path", old_value: old, new_value: path, description: "Poster uploaded" };
}

/**
 * Runs `fn` over the items `n` at a time, in order of start. `keepGoing` is asked before each item starts (the token's
 * lifetime); items never started count as `skipped`. A throwing `fn` counts as failed and the pool goes on.
 */
export async function runPool<T>(
  items: readonly T[], n: number, fn: (x: T, i: number) => Promise<boolean>, keepGoing: () => boolean = () => true,
): Promise<{ done: number; failed: number; skipped: number }> {
  let i = 0;
  const out = { done: 0, failed: 0, skipped: 0 };
  const worker = async () => {
    while (i < items.length) {
      if (!keepGoing()) {
        out.skipped += items.length - i;
        i = items.length;
        return;
      }
      const k = i++;
      let ok = false;
      try {
        ok = await fn(items[k]!, k);
      } catch {
        ok = false;
      }
      if (ok) out.done++;
      else out.failed++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

/** Hex sha256 of some bytes (WebCrypto: the browser and Bun alike). */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------------------------------------------
// The browser's upload (§6.5), over injected calls (src/web/sharing.ts binds them to supabase-js and the companion)
// ---------------------------------------------------------------------------------------------------------------

export interface PosterUploadItem {
  videoId: string;
  /** The Video's stamp for `write_videos update`. */
  updatedAt: string;
}

export interface PosterUploadDeps {
  /** The local poster's bytes (the companion's thumbs route), or null when it is gone. */
  readPoster(videoId: string): Promise<ArrayBuffer | null>;
  /** supabase-js `storage.from('posters').upload(path, bytes, {contentType, cacheControl, upsert: false})`. */
  upload(path: string, bytes: ArrayBuffer): Promise<{ ok: true } | { ok: false; exists: boolean; error: string }>;
  /** `write_videos update {poster_path}` with the stamp and one `video.poster_changed` Edit. */
  setPosterPath(videoId: string, path: string, updatedAt: string, edit: EditInput): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
  /** `POST /api/cache/apply` with the write's result. */
  apply(result: unknown): Promise<boolean>;
  onProgress?(done: number, total: number): void;
}

export interface PosterUploadResult {
  uploaded: number;
  failed: number;
  errors: string[];
}

/** Uploads the local posters 4 at a time: bytes, sha256 path, Storage, `poster_path` through `write_videos`, apply. */
export async function uploadPosters(items: readonly PosterUploadItem[], d: PosterUploadDeps): Promise<PosterUploadResult> {
  const errors: string[] = [];
  let finished = 0;
  const r = await runPool(items, POSTER_CONCURRENCY, async (it) => {
    try {
      const bytes = await d.readPoster(it.videoId);
      if (!bytes || !bytes.byteLength) return false;
      const path = posterPathFor(it.videoId, await sha256Hex(bytes));
      const up = await d.upload(path, bytes);
      // The same bytes under the same path (an earlier try stopped before the write): already there, go on.
      if (!up.ok && !up.exists) {
        errors.push(`poster ${it.videoId}: ${up.error}`);
        return false;
      }
      const w = await d.setPosterPath(it.videoId, path, it.updatedAt, posterEdit(path));
      if (!w.ok) {
        errors.push(`poster ${it.videoId}: ${w.error}`);
        return false;
      }
      return await d.apply(w.value);
    } finally {
      d.onProgress?.(++finished, items.length);
    }
  });
  return { uploaded: r.done, failed: r.failed, errors };
}
