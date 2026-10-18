// The session layer's pure parts (docs/sharing-spec.md §2.1, §5.2–§5.4; ticket #130): the Session record's shape, the
// `/api/session` and `/api/sync` bodies, the browser's session state and its reducer, the edit-control enablement
// rule (the one rule later tickets ask), the multi-tab messages, and the readings of supabase-js outcomes (a sign-in
// error, a revocation probe, a SIGNED_OUT event). No I/O; src/web/session.ts wires them to supabase-js and the companion.
import type { ArchiveEndpoint } from "./archive";
import type { PosterDownloadResult } from "./posters";
import type { ApplySharedResult } from "./sharedRows";

export type GrantLevel = "member" | "editor";

/** Who this machine is signed in as (§5.2). Holds no token. `grantLevel` null = an account without the video grant. */
export interface SessionRecord {
  userId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  grantLevel: GrantLevel | null;
  archiveRole: string | null;
  lastVerifiedAt: string | null;
  lastSyncAt: string | null;
  /** Max `updated_at` seen by the last successful pull, from the server; null before the first Sync. */
  watermark: string | null;
}

/** `GET /api/session`: the record, where the archive is (the companion's `TUVA_ARCHIVE_*` reach the browser this way). */
export interface SessionResponse {
  record: SessionRecord | null;
  archive: ArchiveEndpoint;
  /** A Sync is running in the companion (some tab asked for it). */
  syncing: boolean;
}

/**
 * `POST /api/sync` takes `{access_token}` and nothing else (never the refresh token), plus `full: true` for Settings'
 * "Refresh all Shared data" (§6.4): the Shared rows are wiped and pulled whole.
 */
export interface SyncRequest {
  access_token: string;
  full?: boolean;
}

/** `POST /api/sync`'s answer. The stub (#130) runs `video_whoami()` only; the pull and posters are #115's. */
export interface SyncResponse {
  /** The record after the Sync: written on success, untouched otherwise. */
  record: SessionRecord | null;
  ok: boolean;
  /** The archive answered (an HTTP answer, even a refusal). */
  reachable: boolean;
  /** PostgREST refused the token itself (401): expired or not this project's. */
  unauthorized: boolean;
  /** The schema gate (§6.4): this checkout's `SHARED_SCHEMA` and the archive's, null when it was not reached. */
  schema: { client: number; archive: number | null };
  /** `video_whoami().must_change_password` (not kept in the record); false when the archive was not reached. */
  mustChangePassword: boolean;
  /** Whether a pull was applied to the Local copy (§6.2). */
  pulled: boolean;
  /** One line for the chip's "last Sync error"; null on success. */
  error: string | null;
  /** This Sync was (or was to be) a full refetch, one of §6.4's repair cases. */
  full?: boolean;
  /** What `applyShared` did, when a pull was applied. */
  applied?: ApplySharedResult | null;
  /** The poster download, the second half of the job (§6.5); absent when the pull failed or no thumbs folder is set. */
  posters?: PosterDownloadResult | null;
}

// ---------------------------------------------------------------------------------------------------------------
// The browser's session state
// ---------------------------------------------------------------------------------------------------------------

/** What this browser's supabase-js holds, token-free: whose session and when its access token expires (seconds). */
export interface BrowserSession {
  userId: string;
  expiresAt: number | null;
}

/** Why a session ended without Sign out (§5.4): a dead refresh, or the probe found the session revoked. */
export type EndedReason = "session-ended" | "revoked";

export interface SessionState {
  /** The companion's Session record: what the grid and the chip render from at once (§5.3). */
  record: SessionRecord | null;
  /** `/api/session` has answered at least once. */
  recordLoaded: boolean;
  /** supabase-js reported its initial session, or the 2.5 s wait ran out. */
  authSettled: boolean;
  browser: BrowserSession | null;
  /** The last probe or Sync reached the archive; null before either ran. */
  reachable: boolean | null;
  syncing: boolean;
  lastSyncError: string | null;
  /** Set when the session dropped (§5.4); the record is already cleared. The UI's banner reads it and dismisses it. */
  ended: EndedReason | null;
  /** Where the running Sync is, for the chip's Sync row; null when none runs. */
  progress: SyncProgress | null;
  /** The schema gate's mismatch (§6.4) from the last Sync that reached whoami; cleared by the next successful one. */
  schemaMismatch: SchemaMismatch | null;
  /** Failed Syncs in a row (the focus trigger's back-off, §6.2), and when the last one ended (ms). */
  failures: number;
  lastFailureAt: number | null;
}

/** The running Sync: checking the session (the revocation probe), then the companion's whoami + pull + apply. */
export interface SyncProgress {
  phase: "checking" | "pulling";
  /** A full refetch ("Refresh all Shared data"). */
  full: boolean;
  /** When this Sync started (ms). */
  startedAt: number;
}

/** §6.4's schema gate: `behind` = this checkout is older than the archive ("Update TuvaVideos ..."). */
export interface SchemaMismatch {
  client: number;
  archive: number;
  behind: boolean;
  /** The banner's line. */
  line: string;
}

export const INITIAL_SESSION_STATE: SessionState = {
  record: null, recordLoaded: false, authSettled: false, browser: null, reachable: null, syncing: false, lastSyncError: null, ended: null,
  progress: null, schemaMismatch: null, failures: 0, lastFailureAt: null,
};

export type SessionAction =
  | { type: "record"; record: SessionRecord | null }
  | { type: "auth"; session: BrowserSession | null }
  | { type: "settled" }
  | { type: "reach"; reachable: boolean }
  /**
   * The browser's own `offline`/`online` events (#158, MO1). Offline is an answer: unreachable at once, no probe
   * needed. Online is not: the archive may still be down, so the reading stays until the next probe or Sync (and
   * §6.4 has no network-return Sync).
   */
  | { type: "network"; online: boolean }
  | { type: "sync-start"; full?: boolean; at?: number }
  | { type: "sync-phase"; phase: SyncProgress["phase"] }
  | {
      type: "sync-end"; record?: SessionRecord | null; reachable: boolean; error: string | null;
      /** The response's schema pair, when whoami answered: sets or clears `schemaMismatch`. */
      schema?: { client: number; archive: number | null };
      at?: number;
    }
  | { type: "ended"; reason: EndedReason }
  | { type: "dismiss-ended" }
  | { type: "signed-out" };

export function sessionReducer(s: SessionState, a: SessionAction): SessionState {
  switch (a.type) {
    case "record":
      // A record arriving (a sign-in's first Sync, another tab's) ends any "session ended" notice.
      return { ...s, record: a.record, recordLoaded: true, ended: a.record ? null : s.ended };
    case "auth":
      return { ...s, browser: a.session };
    case "settled":
      return s.authSettled ? s : { ...s, authSettled: true };
    case "reach":
      return { ...s, reachable: a.reachable };
    case "network":
      return a.online || s.reachable === false ? s : { ...s, reachable: false };
    case "sync-start":
      return { ...s, syncing: true, progress: { phase: "checking", full: a.full === true, startedAt: a.at ?? Date.now() } };
    case "sync-phase":
      return s.progress ? { ...s, progress: { ...s.progress, phase: a.phase } } : s;
    case "sync-end": {
      const record = a.record === undefined ? s.record : a.record;
      const failed = a.error != null;
      // The gate's verdict changes only when whoami answered; a successful Sync clears it in any case (§6.4).
      let schemaMismatch = s.schemaMismatch;
      if (a.schema && a.schema.archive != null) schemaMismatch = schemaMismatchOf(a.schema.client, a.schema.archive);
      else if (!failed) schemaMismatch = null;
      return {
        ...s, syncing: false, progress: null, reachable: a.reachable, lastSyncError: a.error, record, ended: record ? null : s.ended, schemaMismatch,
        failures: failed ? s.failures + 1 : 0, lastFailureAt: failed ? (a.at ?? Date.now()) : null,
      };
    }
    case "ended":
      return { ...s, record: null, browser: null, syncing: false, progress: null, lastSyncError: null, ended: a.reason, schemaMismatch: null, failures: 0, lastFailureAt: null };
    case "dismiss-ended":
      return { ...s, ended: null };
    case "signed-out":
      return { ...s, record: null, browser: null, syncing: false, progress: null, lastSyncError: null, ended: null, schemaMismatch: null, failures: 0, lastFailureAt: null };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The edit-control enablement rule (§5.3)
// ---------------------------------------------------------------------------------------------------------------

export interface EditAccess {
  /** Edit controls exist: the record says Video Editor. */
  shown: boolean;
  /** ...and work: a settled, unexpired session of the record's user in this browser, and the archive was reached. */
  enabled: boolean;
}

/**
 * The one rule (§5.3): shown when the record says editor; enabled only when this browser holds a settled, unexpired
 * session of the same user and the last probe or Sync reached the archive. Unsettled counts as offline.
 */
export function editAccess(s: Pick<SessionState, "record" | "authSettled" | "browser" | "reachable">, nowMs: number): EditAccess {
  const shown = s.record?.grantLevel === "editor";
  const live = !!s.browser && s.browser.userId === s.record?.userId && (s.browser.expiresAt == null || s.browser.expiresAt * 1000 > nowMs);
  return { shown, enabled: shown && s.authSettled && live && s.reachable === true };
}

/** §6.4: window focus Syncs when the last successful Sync is older than 10 minutes (or there was none). */
export const FOCUS_SYNC_AFTER_MS = 10 * 60 * 1000;
export function focusWantsSync(record: SessionRecord | null, browser: BrowserSession | null, nowMs: number): boolean {
  if (!record || !browser || browser.userId !== record.userId) return false;
  const last = record.lastSyncAt ? Date.parse(record.lastSyncAt) : NaN;
  return !Number.isFinite(last) || nowMs - last > FOCUS_SYNC_AFTER_MS;
}

/** The schema gate's banner line (§6.4), or null when the archive and this checkout agree. */
export function schemaGateLine(client: number, archive: number): string | null {
  if (archive > client) return "Update TuvaVideos: git pull, then restart";
  if (archive < client) return `The archive's Shared schema is ${archive}, this checkout's is ${client}: the archive's migration has not run yet`;
  return null;
}

export function schemaMismatchOf(client: number, archive: number): SchemaMismatch | null {
  const line = schemaGateLine(client, archive);
  return line ? { client, archive, behind: archive > client, line } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Sync triggers (§6.4): no timer, no network-regained trigger
// ---------------------------------------------------------------------------------------------------------------

/** What can start a Sync. `refresh-all` is Settings' "Refresh all Shared data" (a full refetch). */
export type SyncTrigger = "sign-in" | "launch" | "after-write" | "button" | "focus" | "refresh-all";

/** The focus trigger's back-off after failed Syncs (§6.2 "backs off and retries"): 1, 2, 4, 8, then 10 minutes. */
export const SYNC_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, FOCUS_SYNC_AFTER_MS] as const;
export function syncBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return SYNC_BACKOFF_MS[Math.min(failures, SYNC_BACKOFF_MS.length) - 1]!;
}

/**
 * Whether a trigger starts a Sync (the pure rule). Every trigger but `sign-in` needs this browser's session to be the
 * record's user (`sign-in` runs before the record names anyone); `launch` also waits for a settled session. `focus`
 * Syncs only when the last successful Sync is older than 10 minutes and, after failures, the back-off has passed; the
 * button, an editor's write and Refresh all always run (the button is how a person retries at once).
 */
export function syncWanted(
  t: SyncTrigger,
  s: Pick<SessionState, "record" | "browser" | "authSettled" | "failures" | "lastFailureAt">,
  nowMs: number,
): boolean {
  if (t === "sign-in") return true;
  const mine = !!s.record && !!s.browser && s.browser.userId === s.record.userId;
  if (!mine) return false;
  if (t === "launch") return s.authSettled;
  if (t === "focus") {
    if (!focusWantsSync(s.record, s.browser, nowMs)) return false;
    return s.lastFailureAt == null || nowMs - s.lastFailureAt >= syncBackoffMs(s.failures);
  }
  return true;
}

/** §5.3: how long launch waits for supabase-js's initial session before counting it as unsettled-offline. */
export const AUTH_SETTLE_MS = 2500;

// ---------------------------------------------------------------------------------------------------------------
// Several tabs (§5.3): `localStorage` broadcast
// ---------------------------------------------------------------------------------------------------------------

export const TAB_KEY = "tuva.session.broadcast";

export type TabMessage =
  | { kind: "record"; record: SessionRecord | null }
  | { kind: "ended"; reason: EndedReason }
  | { kind: "dismiss-ended" }
  | { kind: "signed-out" };

export interface TabEnvelope {
  from: string;
  seq: number;
  msg: TabMessage;
}

export const encodeTab = (from: string, seq: number, msg: TabMessage) => JSON.stringify({ from, seq, msg } satisfies TabEnvelope);

/** Reads a `storage` event's new value: null for junk, for this tab's own writes, and for unknown kinds. */
export function decodeTab(raw: string | null, self: string): TabMessage | null {
  if (!raw) return null;
  let env: TabEnvelope;
  try {
    env = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!env || typeof env !== "object" || env.from === self || !env.msg || typeof env.msg !== "object") return null;
  const m = env.msg;
  if (m.kind === "record") return m.record === null || (typeof m.record === "object" && typeof m.record.userId === "string") ? m : null;
  if (m.kind === "ended") return m.reason === "session-ended" || m.reason === "revoked" ? m : null;
  if (m.kind === "dismiss-ended" || m.kind === "signed-out") return m;
  return null;
}

/** What another tab's message does to this tab's state. */
export function tabAction(m: TabMessage): SessionAction {
  switch (m.kind) {
    case "record":
      return { type: "record", record: m.record };
    case "ended":
      return { type: "ended", reason: m.reason };
    case "dismiss-ended":
      return { type: "dismiss-ended" };
    case "signed-out":
      return { type: "signed-out" };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading supabase-js outcomes
// ---------------------------------------------------------------------------------------------------------------

/** An auth error as supabase-js throws or returns it (AuthApiError, AuthRetryableFetchError, ...). */
export interface AuthErrorLike {
  name?: string;
  status?: number;
  code?: string;
  message?: string;
}

export type SignInFailure = "wrong" | "rate-limited" | "unreachable";

/** §5.1's three one-line errors; the dialog never says which of email or password was wrong. */
export const SIGN_IN_ERRORS: Record<SignInFailure, string> = {
  wrong: "Email or password is wrong",
  "rate-limited": "Too many attempts, wait a minute",
  unreachable: "The archive can't be reached",
};

export function signInFailure(e: AuthErrorLike): SignInFailure {
  if (e.status === 429 || e.code === "over_request_rate_limit" || e.code === "over_email_send_rate_limit") return "rate-limited";
  if (e.name === "AuthRetryableFetchError" || !e.status || e.status >= 500) return "unreachable";
  return "wrong";
}

export type ProbeOutcome = "ok" | "unreachable" | "revoked" | "no-session";

/**
 * The revocation probe (`getUser`, §5.3): a network failure is "unreachable" (nothing changes but the reach flag); an
 * auth answer refusing the session or user (401/403/404: session_not_found, user_not_found, user_banned, bad_jwt) is
 * "revoked". supabase-js turns the archive's `session_not_found` into AuthSessionMissingError (and drops the stored
 * session, firing SIGNED_OUT); the same error with no session held beforehand just means there was nothing to probe.
 */
export function probeOutcome(e: AuthErrorLike | null, hadSession = true): ProbeOutcome {
  if (!e) return "ok";
  if (e.name === "AuthSessionMissingError") return hadSession ? "revoked" : "no-session";
  if (e.name === "AuthRetryableFetchError" || !e.status || e.status >= 500) return "unreachable";
  if (e.status === 401 || e.status === 403 || e.status === 404) return "revoked";
  return "unreachable";
}

/**
 * A SIGNED_OUT event (§2.4, §5.4). This tab's own Sign out (or cancelled sign-in) is "user"; one this tab did not
 * start, while the companion still holds a record, is a dropped session (supabase-js removed it after a dead
 * refresh). With the record already gone, another tab signed out (it clears the record before its signOut): "user".
 * A tab with no stored session never sees SIGNED_OUT, so cleared site data leaves the record alone (§5.3).
 */
export function classifySignedOut(o: { initiatedHere: boolean; recordPresent: boolean }): "user" | "dropped" {
  return !o.initiatedHere && o.recordPresent ? "dropped" : "user";
}
