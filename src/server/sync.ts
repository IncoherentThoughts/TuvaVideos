// `POST /api/sync` (docs/sharing-spec.md §5.2, §6.2–§6.4; tickets #130, #139): the browser hands over its access token
// in the body; the companion calls `video_whoami()` with it through PostgREST, writes the Session record from the
// answer, applies the schema gate, then pulls `shared_changes_since(watermark − 5 min)` and applies it with
// `applyShared` in one SQLite transaction (the tombstones and the ids-only reconcile of `archive_ids` ride in the same
// batch). Only a fully applied pull moves the watermark and `last_sync_at`. The repair cases of §6.4 (first Sync of an
// account, a Shared schema change, a watermark older than tombstone retention, Settings' "Refresh all Shared data")
// pull everything instead, after wiping the Shared rows in the same transaction. The posters are #140's.
//
// The token lives in this job's local variables only: never stored, never logged, gone when the job ends. One Sync at
// a time per companion; requests arriving during one are coalesced into a single follow-up run.
import { changesSince, postgrestClient, tokenExp, whoami, type ArchiveCall, type ArchiveEndpoint, type RpcClient } from "../shared/archive";
import { WATERMARK_OVERLAP_MS, type VideoWhoami } from "../shared/archiveWire";
import { schemaGateLine, type SessionRecord, type SyncResponse } from "../shared/session";
import type { ApplySharedResult, Iso, SharedChanges } from "../shared/sharedRows";
import type { Db } from "./db";
import { applyShared, tsMicros } from "./localCopy/apply";
import { runArchiveFollowUps } from "./localCopy/followUps";
import { getMeta, readSessionRecord, SHARED_SCHEMA, setMeta, writeSessionRecord } from "./localCopy/meta";
import { reconcileBatch } from "./reconcile";

/**
 * One run at a time; calls arriving during a run share one follow-up run, made with the newest argument (the newest
 * token), or with `merge(queued, incoming)` when given (a queued full refetch stays full). Pure apart from `run`.
 */
export function coalesce<A, R>(run: (a: A) => Promise<R>, merge?: (queued: A, incoming: A) => A) {
  let current: Promise<R> | null = null;
  let next: { arg: A; promise: Promise<R> } | null = null;
  const start = (a: A): Promise<R> => {
    const p = run(a).finally(() => {
      if (current === p) current = null;
    });
    current = p;
    return p;
  };
  return {
    request(a: A): Promise<R> {
      if (next) {
        next.arg = merge ? merge(next.arg, a) : a;
        return next.promise;
      }
      if (!current) return start(a);
      const slot = { arg: a, promise: null as unknown as Promise<R> };
      const after = current.then(() => {}, () => {});
      slot.promise = after.then(() => {
        next = null;
        return start(slot.arg);
      });
      next = slot;
      return slot.promise;
    },
    busy: () => current != null || next != null,
  };
}

const fail = (db: Db, o: Partial<SyncResponse> & { error: string }): SyncResponse => ({
  record: readSessionRecord(db), ok: false, reachable: false, unauthorized: false, schema: { client: SHARED_SCHEMA, archive: null }, mustChangePassword: false, pulled: false, ...o,
});

/** The schema gate's line (§6.4), or null when the archive and this checkout agree. */
export const schemaGateError = schemaGateLine;

// ---------------------------------------------------------------------------------------------------------------
// Watermark math and the repair cases (pure)
// ---------------------------------------------------------------------------------------------------------------

/** `shared_tombstone` retention (§6.3): a watermark older than this may have missed a purged tombstone. */
export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** `meta` key: the Shared schema the last successful pull was applied under (a change forces a full refetch). */
export const SYNCED_SCHEMA_KEY = "synced_shared_schema";

/**
 * The next pull's `p_since`: the watermark minus the 5-minute `now()` overlap (§6.2), or null (everything) when there
 * is no readable watermark. Rows the overlap pulls again are skipped by the `updated_at` guard.
 */
export function pullSince(watermark: string | null | undefined): Iso | null {
  const us = tsMicros(watermark);
  if (us == null) return null;
  return new Date(Math.floor(us / 1000) - WATERMARK_OVERLAP_MS).toISOString();
}

/** The later of two watermarks (either may be null or unreadable). */
export function laterOf(a: string | null | undefined, b: string | null | undefined): string | null {
  const x = tsMicros(a);
  const y = tsMicros(b);
  if (y == null) return x == null ? null : a!;
  if (x == null) return b!;
  return y > x ? b! : a!;
}

export type FullReason ="requested" | "first" | "schema" | "retention";

/** Which of §6.4's repair cases applies, or null for an incremental pull. */
export function fullRefetchReason(o: {
  requested: boolean;
  watermark: string | null;
  /** `SYNCED_SCHEMA_KEY`, null when no pull was ever applied. */
  syncedSchema: number | null;
  client: number;
  /** The archive's clock (whoami's `server_time`), ms. */
  serverNowMs: number;
}): FullReason | null {
  if (o.requested) return "requested";
  const us = tsMicros(o.watermark);
  if (us == null) return "first";
  if (o.syncedSchema !== o.client) return "schema";
  if (o.serverNowMs - us / 1000 > TOMBSTONE_RETENTION_MS) return "retention";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The wipe of a full refetch
// ---------------------------------------------------------------------------------------------------------------

/** Shared tables a full refetch empties: the archive rows (children first), the Proposed rows and the Shared logs. */
export const WIPED_TABLES = [
  "archive_track_artist", "archive_album_credit", "archive_track", "archive_performance", "archive_version", "archive_song", "archive_artist", "archive_album",
  "video_proposed_versions", "video_proposed_songs", "video_proposed_artists", "video_exposed_songs", "video_edit_history", "shared_tombstone",
] as const;
/** The guard's floor: a held Shared Video stamped with it loses to any pulled row. */
const EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * Empties the Shared rows a full pull brings back whole. Shared Videos are not deleted (their Copies, Favorites,
 * resume points and Chapter Favorites hang off them by cascade); their `updated_at` drops to the epoch instead, so the
 * pull overwrites each one and replaces its children wholesale. Run inside the apply's transaction.
 */
export function wipeShared(db: Db): number {
  let n = 0;
  for (const t of WIPED_TABLES) n += db.query(`DELETE FROM ${t}`).run().changes;
  db.query(`UPDATE videos SET updated_at = ? WHERE id IN (SELECT video_id FROM video_local WHERE shared = 1)`).run(EPOCH);
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------------------------

export interface SyncArgs {
  accessToken: string;
  /** Settings' "Refresh all Shared data". */
  full?: boolean;
}

export interface SyncOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** The yt-dlp info cache the Artist matcher reads after archive rows changed (`Config.ytCacheDir`). */
  cacheDir?: string;
  /** Where a failed follow-up is reported (they never fail the Sync). */
  warn?: (line: string) => void;
}

const refusal = (r: Extract<ArchiveCall<unknown>, { ok: false }>, what: string) => `The archive refused ${what} (${r.error.code ?? r.error.word})`;

function recordFromWhoami(db: Db, w: VideoWhoami, nowMs: number): SessionRecord {
  return writeSessionRecord(db, {
    userId: w.user_id,
    email: w.email ?? null,
    displayName: w.display_name ?? null,
    avatarUrl: w.avatar_url ?? null,
    grantLevel: w.grant_level === "editor" || w.grant_level === "member" ? w.grant_level : null,
    archiveRole: w.archive_role ?? null,
    lastVerifiedAt: w.server_time ?? new Date(nowMs).toISOString(),
  });
}

const isWhoami = (w: unknown): w is VideoWhoami =>
  !!w && typeof w === "object" && typeof (w as VideoWhoami).user_id === "string" && typeof (w as VideoWhoami).shared_schema === "number";

/** Local copy tables of the archive's own rows: a pull that touched them runs the matchers' follow-ups. */
const touchedArchive = (a: ApplySharedResult) => a.removed > 0 || Object.entries(a.applied).some(([t, n]) => n > 0 && t.startsWith("archive_"));

export function createSync(db: Db, endpoint: ArchiveEndpoint, opts: SyncOptions = {}) {
  const now = opts.now ?? Date.now;
  const warn = opts.warn ?? ((l: string) => console.warn(l));
  const once = async ({ accessToken, full = false }: SyncArgs): Promise<SyncResponse> => {
    const exp = tokenExp(accessToken);
    if (exp != null && exp * 1000 <= now()) return fail(db, { error: "The session's access token has expired", unauthorized: true, full });
    const c: RpcClient = postgrestClient(endpoint, accessToken, opts.fetchImpl);
    const r = await whoami(c);
    if (!r.ok) {
      if (r.unreachable) return fail(db, { error: "The archive can't be reached", full });
      return fail(db, { reachable: true, unauthorized: r.unauthorized || r.error.word === "forbidden", error: refusal(r, "the Sync"), full });
    }
    if (!isWhoami(r.value)) return fail(db, { reachable: true, error: "The archive's video_whoami() answered in an unknown shape", full });
    const w = r.value;
    let record = recordFromWhoami(db, w, now());
    const schema = { client: SHARED_SCHEMA, archive: w.shared_schema };
    const mustChangePassword = w.must_change_password === true;
    const base = { reachable: true, unauthorized: false, schema, mustChangePassword };
    const gate = schemaGateError(SHARED_SCHEMA, w.shared_schema);
    if (gate) return { ...base, record, ok: false, pulled: false, error: gate, full };
    // An account without the video grant has nothing to pull (the function answers 42501).
    if (!record.grantLevel) return { ...base, record, ok: false, pulled: false, error: "This account has no access to the shared library", full };

    const synced = getMeta(db, SYNCED_SCHEMA_KEY);
    const serverNow = tsMicros(w.server_time);
    const reason = fullRefetchReason({
      requested: full, watermark: record.watermark, syncedSchema: synced == null ? null : Number(synced), client: SHARED_SCHEMA,
      serverNowMs: serverNow == null ? now() : serverNow / 1000,
    });
    const pull = await changesSince(c, reason ? null : pullSince(record.watermark));
    if (!pull.ok) {
      const out = { ...base, record, ok: false, pulled: false, full: reason != null };
      if (pull.unreachable) return { ...out, reachable: false, error: "The archive can't be reached" };
      if (pull.unauthorized) return { ...out, unauthorized: true, error: refusal(pull, "the pull") };
      if (pull.error.word === "forbidden") {
        // §6.2: a permission error re-reads the grant and updates the Session record.
        const again = await whoami(c);
        if (again.ok && isWhoami(again.value)) record = recordFromWhoami(db, again.value, now());
        return { ...out, record, error: record.grantLevel ? refusal(pull, "the pull") : "This account no longer has access to the shared library" };
      }
      return { ...out, error: refusal(pull, "the pull") };
    }
    const batch = pull.value as SharedChanges | null;
    if (!batch || typeof batch !== "object") return { ...base, record, ok: false, pulled: false, full: reason != null, error: "The archive's shared_changes_since() answered in an unknown shape" };
    if (batch.shared_schema != null && batch.shared_schema !== SHARED_SCHEMA) {
      return { ...base, record, schema: { client: SHARED_SCHEMA, archive: batch.shared_schema }, ok: false, pulled: false, full: reason != null, error: schemaGateError(SHARED_SCHEMA, batch.shared_schema) };
    }

    // One transaction: the wipe (repair cases) and the apply stand or fall together; a failure leaves the watermark.
    let applied: ApplySharedResult;
    try {
      applied = db.transaction(() => {
        if (reason) wipeShared(db);
        reconcileBatch(db, batch); // §2.3: an Unshared Video this batch's Shared Videos match takes the Shared row first (#149)
        return applyShared(db, batch);
      })();
    } catch (e) {
      return { ...base, record, ok: false, pulled: false, full: reason != null, error: `Sync failed, nothing was applied: ${(e as Error)?.message ?? e}` };
    }
    record = writeSessionRecord(db, {
      userId: record.userId,
      // The server's watermark, never moved back: an empty pull answers `p_since` (watermark − 5 min), and keeping
      // that would walk the window back 5 minutes per Sync (a full refetch starts over from the server's).
      watermark: reason ? (applied.watermark ?? null) : laterOf(record.watermark, applied.watermark),
      // This machine's clock, not the archive's: the focus trigger compares it with the browser's clock (§6.4).
      lastSyncAt: new Date(now()).toISOString(),
    });
    setMeta(db, SYNCED_SCHEMA_KEY, String(SHARED_SCHEMA));
    // The retired import's follow-ups (Unshared Videos only) when archive rows changed; a full refetch always runs
    // them, as its wipe left the search index behind. They never fail the Sync: its rows are already in.
    if (reason || touchedArchive(applied)) {
      try {
        await runArchiveFollowUps(db, { cacheDir: opts.cacheDir });
      } catch (e) {
        warn(`sync: follow-ups after the pull failed: ${(e as Error)?.message ?? e}`);
      }
    }
    return { ...base, record, ok: true, pulled: true, error: null, full: reason != null, applied };
  };
  return coalesce(once, (a, b) => ({ accessToken: b.accessToken, full: a.full === true || b.full === true }));
}

export type SyncRunner = ReturnType<typeof createSync>;
