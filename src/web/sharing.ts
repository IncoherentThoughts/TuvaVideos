// The browser's half of posters and `pending_share` (docs/sharing-spec.md §6.5, §6.6; ticket #140): the calls the
// pure drain and upload (src/shared/share.ts, src/shared/posters.ts) make, bound to the one supabase-js client and
// to the companion. No DOM and no store here: src/web/session.ts decides when they run. `base` is the companion's
// origin ("" in the app; the smoke script passes its test port).
import type { SupabaseClient } from "@supabase/supabase-js";
import { callWrite, type RpcClient } from "../shared/archive";
import type { ArchiveError, EditInput, WriteResult } from "../shared/archiveWire";
import { POSTER_BUCKET, POSTER_CACHE_SECONDS, uploadPosters, type PosterUploadItem, type PosterUploadResult } from "../shared/posters";
import { drainPendingShare, type CallOutcome, type DrainDeps, type DrainResult, type PendingShareBatch, type PendingShareSummary } from "../shared/share";

async function getJson<T>(base: string, path: string): Promise<T | null> {
  try {
    const r = await fetch(`${base}${path}`);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** `POST /api/cache/apply`: true when the Local copy took the rows. */
export async function applyToCache(base: string, result: unknown): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/cache/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result) });
    return r.ok;
  } catch {
    return false;
  }
}

export const readShareSummary = (base = "") => getJson<PendingShareSummary>(base, "/api/share");
export const readShareBatch = (base = "") => getJson<PendingShareBatch>(base, "/api/share/pending");

/** A scan is running or queued (§6.6: never drain mid-scan). Unknown counts as scanning. */
export async function scanBusy(base = ""): Promise<boolean> {
  const s = await getJson<{ running: boolean; queued: number[] }>(base, "/api/scan");
  return !s || s.running || (s.queued?.length ?? 0) > 0;
}

export async function setShareAuto(base: string, auto: boolean): Promise<PendingShareSummary | null> {
  try {
    const r = await fetch(`${base}/api/share/auto`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ auto }) });
    return r.ok ? ((await r.json()) as PendingShareSummary) : null;
  } catch {
    return null;
  }
}

const outcome = async (p: ReturnType<typeof callWrite>): Promise<CallOutcome> => {
  const r = await p;
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error as ArchiveError };
};

/** The drain's calls: the archive's write functions through `rpc`, the Local copy through the companion. */
export function drainDeps(rpc: RpcClient, base = ""): DrainDeps {
  const write = (fn: Parameters<typeof callWrite>[1], op: string, target: string, payload: unknown, edits: EditInput[]) =>
    outcome(callWrite(rpc, fn, { p_op: op, p_target: target, p_payload: payload, p_expected_updated_at: null, p_edits: edits } as never));
  return {
    newId: () => crypto.randomUUID(),
    createProposedSong: (id, payload, edits) => write("write_proposed_songs", "create", id, payload, edits),
    createProposedVersion: (id, payload, edits) => write("write_proposed_versions", "create", id, payload, edits),
    createProposedArtist: (id, payload, edits) => write("write_proposed_artists", "create", id, payload, edits),
    insertVideo: (id, payload, edits) => write("write_videos", "insert", id, payload, edits),
    apply: (result: WriteResult) => applyToCache(base, result),
  };
}

/** Reads the queue and drains it (§6.6). Null when the companion did not answer. */
export async function runDrain(rpc: RpcClient, base = ""): Promise<DrainResult | null> {
  const batch = await readShareBatch(base);
  if (!batch) return null;
  return drainPendingShare(batch, drainDeps(rpc, base));
}

/** Storage's "already exists" (a retried upload of the same immutable path). */
const isExists = (e: unknown) => {
  const x = e as { statusCode?: string | number; status?: number; message?: string; error?: string } | null;
  return String(x?.statusCode ?? x?.status ?? "") === "409" || /already exists|duplicate/i.test(`${x?.message ?? ""} ${x?.error ?? ""}`);
};

/** Uploads this machine's local posters of Shared Videos without a `poster_path` (§6.5). */
export async function runPosterUpload(
  client: Pick<SupabaseClient, "storage">, rpc: RpcClient, base = "", onProgress?: (done: number, total: number) => void,
): Promise<PosterUploadResult | null> {
  const list = await getJson<{ candidates: PosterUploadItem[] }>(base, "/api/posters/upload");
  if (!list) return null;
  if (!list.candidates.length) return { uploaded: 0, failed: 0, errors: [] };
  return uploadPosters(list.candidates, {
    async readPoster(videoId) {
      try {
        const r = await fetch(`${base}/thumbs/${videoId}/poster.webp`, { cache: "no-store" });
        return r.ok ? await r.arrayBuffer() : null;
      } catch {
        return null;
      }
    },
    async upload(path, bytes) {
      const { error } = await client.storage.from(POSTER_BUCKET).upload(path, bytes, { contentType: "image/webp", cacheControl: POSTER_CACHE_SECONDS, upsert: false });
      return error ? { ok: false, exists: isExists(error), error: error.message } : { ok: true };
    },
    async setPosterPath(videoId, path, updatedAt, edit) {
      const r = await callWrite(rpc, "write_videos", { p_op: "update", p_target: videoId, p_payload: { poster_path: path }, p_expected_updated_at: updatedAt, p_edits: [edit] });
      return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error.word + (r.error.message ? `: ${r.error.message}` : "") };
    },
    apply: (result) => applyToCache(base, result),
    onProgress,
  });
}
