// `POST /api/sync`, the stub of ticket #130 (docs/sharing-spec.md §5.2, §6.4): the browser hands over its access token
// in the body; the companion calls `video_whoami()` with it through PostgREST, writes the Session record from the
// answer and returns it. The pull, the apply and the posters (#115) slot in after the whoami. The token lives in this
// job's local variables only: never stored, never logged, gone when the job ends. One Sync at a time per companion; a
// request arriving during one is coalesced into a single follow-up run.
import { postgrestClient, tokenExp, whoami, type ArchiveEndpoint } from "../shared/archive";
import type { VideoWhoami } from "../shared/archiveWire";
import type { SyncResponse } from "../shared/session";
import type { Db } from "./db";
import { readSessionRecord, SHARED_SCHEMA, writeSessionRecord } from "./localCopy/meta";

/**
 * One run at a time; calls arriving during a run share one follow-up run, made with the newest argument (the newest
 * token). Pure apart from the `run` it wraps.
 */
export function coalesce<A, R>(run: (a: A) => Promise<R>) {
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
        next.arg = a;
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
export function schemaGateError(client: number, archive: number): string | null {
  if (archive > client) return "Update TuvaVideos: git pull, then restart";
  if (archive < client) return `The archive's Shared schema is ${archive}, this checkout's is ${client}: the archive's migration has not run yet`;
  return null;
}

export function createSync(db: Db, endpoint: ArchiveEndpoint, opts: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const once = async (accessToken: string): Promise<SyncResponse> => {
    const exp = tokenExp(accessToken);
    if (exp != null && exp * 1000 <= now()) return fail(db, { error: "The session's access token has expired", unauthorized: true });
    const r = await whoami(postgrestClient(endpoint, accessToken, opts.fetchImpl));
    if (!r.ok) {
      if (r.unreachable) return fail(db, { error: "The archive can't be reached" });
      return fail(db, { reachable: true, unauthorized: r.unauthorized || r.error.word === "forbidden", error: `The archive refused the Sync (${r.error.code ?? "error"})` });
    }
    const w = r.value as Partial<VideoWhoami> | null;
    if (!w || typeof w.user_id !== "string" || typeof w.shared_schema !== "number")
      return fail(db, { reachable: true, error: "The archive's video_whoami() answered in an unknown shape" });
    const record = writeSessionRecord(db, {
      userId: w.user_id,
      email: w.email ?? null,
      displayName: w.display_name ?? null,
      avatarUrl: w.avatar_url ?? null,
      grantLevel: w.grant_level === "editor" || w.grant_level === "member" ? w.grant_level : null,
      archiveRole: w.archive_role ?? null,
      lastVerifiedAt: w.server_time ?? new Date(now()).toISOString(),
    });
    const gate = schemaGateError(SHARED_SCHEMA, w.shared_schema);
    // #115: the pull (shared_changes_since from the watermark), applyShared, lastSyncAt/watermark, then the posters.
    return { record, ok: gate == null, reachable: true, unauthorized: false, schema: { client: SHARED_SCHEMA, archive: w.shared_schema }, mustChangePassword: w.must_change_password === true, pulled: false, error: gate };
  };
  return coalesce(once);
}

export type SyncRunner = ReturnType<typeof createSync>;
