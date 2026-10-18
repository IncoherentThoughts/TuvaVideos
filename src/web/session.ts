// The browser's session layer (docs/sharing-spec.md §5.1–§5.4; ticket #130): the one supabase-js client, the Session
// record from the companion, and `useSession()`, the hook the chip, the dialog, the banners (#131) and the edit
// controls (#116) read. One store per tab, started once (main.tsx); several tabs agree through supabase-js's own
// storage plus a `localStorage` broadcast of record changes. The pure rules are in src/shared/session.ts.
//
// No timers but the one-shot 2.5 s `authSettled` wait: the revocation probe runs on window focus and before each Sync.
import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "preact/hooks";
import type { RpcClient } from "../shared/archive";
import type { ReconcileResponse } from "../shared/reconcile";
import {
  AUTH_SETTLE_MS, classifySignedOut, decodeTab, editAccess, encodeTab, INITIAL_SESSION_STATE, probeOutcome,
  SIGN_IN_ERRORS, signInFailure, sessionReducer, syncWanted, tabAction, TAB_KEY,
  type BrowserSession, type EndedReason, type ProbeOutcome, type SchemaMismatch, type SessionAction, type SessionRecord, type SessionResponse,
  type SessionState, type SyncProgress, type SyncRequest, type SyncResponse, type SyncTrigger, type TabMessage,
} from "../shared/session";
import { shareStep, type DrainResult, type PendingShareSummary, type ShareEvent } from "../shared/share";
import type { PosterUploadResult } from "../shared/posters";
import { readShareSummary, runDrain, runPosterUpload, scanBusy, setShareAuto } from "./sharing";

// ---------------------------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------------------------

let state: SessionState = INITIAL_SESSION_STATE;
const listeners = new Set<() => void>();
const dispatch = (a: SessionAction) => {
  const next = sessionReducer(state, a);
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
};

const TAB = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());
let seq = 0;
function broadcast(msg: TabMessage) {
  try {
    localStorage.setItem(TAB_KEY, encodeTab(TAB, ++seq, msg));
  } catch {}
}

let client: SupabaseClient | null = null;
let clientReady: Promise<SupabaseClient | null> | null = null;
/** This tab started a sign-out: the next SIGNED_OUT is ours, not a dropped session. */
let expectSignedOut = false;
/** A dropped session is being ended here (the probe's or a SIGNED_OUT's); SIGNED_OUTs meanwhile are part of it. */
let ending = false;
let syncInFlight: Promise<SyncResponse | null> | null = null;

const toBrowser = (s: Session | null): BrowserSession | null => (s ? { userId: s.user.id, expiresAt: s.expires_at ?? null } : null);

async function readSession(): Promise<SessionResponse | null> {
  try {
    const r = await fetch("/api/session");
    return r.ok ? ((await r.json()) as SessionResponse) : null;
  } catch {
    return null;
  }
}

async function clearRecord(): Promise<void> {
  await fetch("/api/session", { method: "DELETE" }).catch(() => {});
}

/** Starts the layer once per tab: reads the record at once, then creates the client against the companion's archive. */
export function startSession(): Promise<SupabaseClient | null> {
  if (clientReady) return clientReady;
  const settle = setTimeout(() => dispatch({ type: "settled" }), AUTH_SETTLE_MS);
  clientReady = readSession().then((r) => {
    if (!r) {
      dispatch({ type: "settled" });
      return null;
    }
    dispatch({ type: "record", record: r.record });
    client = createClient(r.archive.url, r.archive.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    // supabase-js warns against awaiting its own calls inside the callback: hand off to a task.
    client.auth.onAuthStateChange((event, session) => {
      setTimeout(() => void onAuth(event, session, settle), 0);
    });
    return client;
  });
  if (typeof window !== "undefined") {
    window.addEventListener("focus", () => void onFocus());
    // #158 (MO1): the slashed dot reacts to the browser's own network flag at once; going back online neither
    // Syncs (§6.4) nor probes (§5.3: focus and Sync only), so the dot clears at the next probe or Sync.
    if (typeof navigator !== "undefined" && navigator.onLine === false) dispatch({ type: "network", online: false });
    window.addEventListener("offline", () => dispatch({ type: "network", online: false }));
    window.addEventListener("online", () => dispatch({ type: "network", online: true }));
    window.addEventListener("storage", (e) => {
      if (e.key !== TAB_KEY) return;
      const m = decodeTab(e.newValue, TAB);
      if (m) dispatch(tabAction(m));
    });
  }
  return clientReady;
}

async function onAuth(event: AuthChangeEvent, session: Session | null, settle: ReturnType<typeof setTimeout>) {
  dispatch({ type: "auth", session: toBrowser(session) });
  if (event === "INITIAL_SESSION") {
    clearTimeout(settle);
    dispatch({ type: "settled" });
    // §6.4: launch while signed in Syncs.
    void trigger("launch");
    return;
  }
  if (event === "SIGNED_IN") return;
  if (event !== "SIGNED_OUT") return;
  if (ending || expectSignedOut) {
    expectSignedOut = false;
    return;
  }
  const r = await readSession();
  if (classifySignedOut({ initiatedHere: false, recordPresent: !!r?.record }) === "dropped") await endSession("session-ended");
  else dispatch({ type: "record", record: r?.record ?? null });
}

/** §5.4: the record goes, the banner's reason is set here and in every tab, the local session is dropped. */
async function endSession(reason: EndedReason) {
  if (ending) return;
  ending = true;
  try {
    await clearRecord();
    if (client) {
      expectSignedOut = true;
      await client.auth.signOut({ scope: "local" }).catch(() => {});
    }
  } finally {
    ending = false;
  }
  dispatch({ type: "ended", reason });
  broadcast({ kind: "ended", reason });
}

/** The revocation probe (§5.3): `getUser()` on window focus and before each Sync, never on a timer. */
export async function probe(): Promise<ProbeOutcome> {
  if (!client || !state.browser) return "no-session";
  const { error } = await client.auth.getUser();
  const outcome = probeOutcome(error, true);
  if (outcome === "ok") dispatch({ type: "reach", reachable: true });
  else if (outcome === "unreachable") dispatch({ type: "reach", reachable: false });
  else if (outcome === "revoked") await endSession("revoked");
  return outcome;
}

async function onFocus() {
  // §5.3: tabs re-read the record and the watermark on window focus.
  const r = await readSession();
  if (r) dispatch({ type: "record", record: r.record });
  if (!state.browser) return;
  // §6.4: focus Syncs when the last successful Sync is older than 10 minutes (after failures, once the back-off passed).
  if (syncWanted("focus", state, Date.now())) void runSync(false);
  else void probe();
}

/**
 * A §6.4 trigger: Syncs when the pure rule (`syncWanted`) says so, else resolves null. No timer ever calls this.
 */
function trigger(t: SyncTrigger): Promise<SyncResponse | null> {
  if (!syncWanted(t, state, Date.now())) return Promise.resolve(null);
  return runSync(t === "refresh-all");
}

/**
 * One Sync from this tab at a time (a second call while one runs gets the same promise; the companion coalesces
 * across tabs). Probes first; hands the access token, and only it, to `POST /api/sync`. Null when nothing ran. A full
 * refetch asked for during an incremental Sync runs after it.
 */
function runSync(full: boolean): Promise<SyncResponse | null> {
  if (syncInFlight) return full ? syncInFlight.then(() => runSync(true)) : syncInFlight;
  syncInFlight = (async () => {
    await clientReady;
    if (!client) return null;
    dispatch({ type: "sync-start", full, at: Date.now() });
    const p = await probe();
    if (p !== "ok") {
      if (p === "revoked") return null;
      dispatch({ type: "sync-end", reachable: p === "unreachable" ? false : state.reachable === true, error: p === "unreachable" ? "The archive can't be reached" : "Not signed in", at: Date.now() });
      return null;
    }
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      dispatch({ type: "sync-end", reachable: true, error: "Not signed in", at: Date.now() });
      return null;
    }
    dispatch({ type: "sync-phase", phase: "pulling" });
    let res: SyncResponse;
    try {
      const body: SyncRequest = full ? { access_token: token, full: true } : { access_token: token };
      const r = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
      res = (await r.json()) as SyncResponse;
    } catch (e) {
      dispatch({ type: "sync-end", reachable: state.reachable === true, error: `Sync failed: ${(e as Error).message}`, at: Date.now() });
      return null;
    }
    dispatch({ type: "sync-end", record: res.record, reachable: res.reachable, error: res.error, schema: res.schema, at: Date.now() });
    broadcast({ kind: "record", record: res.record });
    // §6.2: a 401 runs the revocation probe (a revoked session ends here; an expired token just refreshes).
    if (res.unauthorized) void probe();
    // §6.5, §6.6: at each Sync the queue is drained (or the one question asked) and local posters go up.
    if (res.ok) void afterSyncShare();
    return res;
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

/** The chip's Sync button (§6.4): always runs while a session is held. Also the hook's `requestSync`. */
export function requestSync(): Promise<SyncResponse | null> {
  return runSync(false);
}

/**
 * §6.4: after a Video Editor's own write (already applied to the Local copy through `/api/cache/apply`), Sync to pick
 * up what others changed meanwhile. For the write path (#116); does nothing unless this browser is the record's user.
 */
export function afterWrite(): Promise<SyncResponse | null> {
  return trigger("after-write");
}

/** The chip menu's "Refresh all Shared data" (§6.4): the companion wipes the Shared rows and pulls them whole. */
export function refreshAll(): Promise<SyncResponse | null> {
  return trigger("refresh-all");
}

export interface SignInResult {
  ok: boolean;
  /** One of §5.1's three lines when `ok` is false. */
  error: string | null;
  /** The first Sync after the sign-in; null when it could not run (the record is then unchanged). */
  sync: SyncResponse | null;
  /** `video_whoami().must_change_password`: show the notice linking to songsofthesteppe.org; the session stays. */
  mustChangePassword: boolean;
  /** §2.3: what Continue will shelve (`GET /api/reconcile/preview`); null when no preview ran. */
  reconcile?: ReconcileResponse | null;
}

/**
 * §2.3 (#149): the companion's reconcile routes with this browser's access token. `confirm` is Continue: reconcile
 * and apply, then the Sync of "sign-in completes". The record the companion wrote reaches every tab.
 */
async function reconcileCall(confirm: boolean): Promise<ReconcileResponse | null> {
  const token = client ? (await client.auth.getSession()).data.session?.access_token : null;
  if (!token) return null;
  try {
    const r = await (confirm
      ? fetch("/api/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ access_token: token }) })
      : fetch("/api/reconcile/preview", { headers: { authorization: `Bearer ${token}` } }));
    if (!r.ok) return null;
    const res = (await r.json()) as ReconcileResponse;
    dispatch({ type: "record", record: res.record });
    broadcast({ kind: "record", record: res.record });
    return res;
  } catch {
    return null;
  }
}

/** Continue on the reconciliation confirm (§2.3, §5.1): reconcile, then Sync. */
export async function confirmSignIn(): Promise<{ reconcile: ReconcileResponse | null; sync: SyncResponse | null }> {
  const reconcile = await reconcileCall(true);
  if (!reconcile?.ok) return { reconcile, sync: null };
  firstSyncAfterSignIn = true; // §6.6: the question may ride on the first Sync after the confirmed sign-in
  return { reconcile, sync: await runSync(false) };
}

/** §5.1: `signInWithPassword`, then the reconciliation preview (which writes the record); Continue is `confirmSignIn`. */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const c = await (clientReady ?? startSession());
  if (!c) return { ok: false, error: SIGN_IN_ERRORS.unreachable, sync: null, mustChangePassword: false };
  let result: Awaited<ReturnType<SupabaseClient["auth"]["signInWithPassword"]>>;
  try {
    result = await c.auth.signInWithPassword({ email, password });
  } catch (e) {
    return { ok: false, error: SIGN_IN_ERRORS[signInFailure(e as never)], sync: null, mustChangePassword: false };
  }
  if (result.error) return { ok: false, error: SIGN_IN_ERRORS[signInFailure(result.error)], sync: null, mustChangePassword: false };
  expectSignedOut = false;
  dispatch({ type: "auth", session: toBrowser(result.data.session) });
  dispatch({ type: "reach", reachable: true });
  // §5.1: whoami (the record) and the count of what reconciliation will shelve; the Sync waits for Continue.
  const reconcile = await reconcileCall(false);
  return { ok: true, error: null, sync: null, reconcile, mustChangePassword: reconcile?.mustChangePassword === true };
}

/** Sign out, and Cancel on the reconciliation confirm (§2.4, §5.1): record cleared first, then the local session. */
export async function signOut(): Promise<void> {
  await clearRecord();
  const c = await (clientReady ?? startSession());
  if (c) {
    expectSignedOut = true;
    await c.auth.signOut({ scope: "local" }).catch(() => {});
  }
  dispatch({ type: "signed-out" });
  broadcast({ kind: "signed-out" });
}

/** Dismisses "Your session ended. Sign in again." in every tab. */
export function dismissEnded() {
  dispatch({ type: "dismiss-ended" });
  broadcast({ kind: "dismiss-ended" });
}

/** The archive client for the write path (#116), as the typed calls of src/shared/archive.ts take it. */
export function archiveRpc(): RpcClient | null {
  const c = client;
  return c ? { rpc: (fn, args) => c.rpc(fn as never, args as never) as never } : null;
}


// ---------------------------------------------------------------------------------------------------------------
// `pending_share` and posters (§6.5, §6.6; #140)
// ---------------------------------------------------------------------------------------------------------------

/** The upload's progress for the chip ("posters n of m"); `last` is the previous run's outcome. */
export interface PosterUploadState {
  running: boolean;
  done: number;
  total: number;
  last: PosterUploadResult | null;
}

let shareSummary: PendingShareSummary | null = null;
let shareQuestionOpen = false;
let draining: Promise<DrainResult | null> | null = null;
let lastDrain: DrainResult | null = null;
let posterState: PosterUploadState = { running: false, done: 0, total: 0, last: null };
let posterRun: Promise<PosterUploadResult | null> | null = null;
let firstSyncAfterSignIn = false;
const ASKED_KEY = "tuva.share.askedNewestAt";
const notify = () => {
  for (const l of listeners) l();
};
function askedNewestAt(): string | null {
  try {
    return localStorage.getItem(ASKED_KEY);
  } catch {
    return null;
  }
}
function rememberAsked(at: string | null) {
  try {
    if (at) localStorage.setItem(ASKED_KEY, at);
  } catch {}
}

const shareReady = () => editAccess(state, Date.now()).enabled && state.reachable === true;

/** Re-reads the queue's counts from the companion (the chip row and the question read them). */
export async function refreshPendingShare(): Promise<PendingShareSummary | null> {
  const s = await readShareSummary();
  if (s) {
    shareSummary = s;
    if (!s.count) shareQuestionOpen = false;
    notify();
  }
  return s;
}

/** Applies §6.6's rule to one event: asks the one question, drains, or does nothing. */
async function considerShare(event: ShareEvent): Promise<DrainResult | null> {
  const first = event === "sync" && firstSyncAfterSignIn;
  if (event === "sync") firstSyncAfterSignIn = false;
  const summary = await refreshPendingShare();
  if (!summary) return null;
  const step = shareStep(
    event,
    { canEdit: editAccess(state, Date.now()).enabled, online: state.reachable === true, scanning: await scanBusy(), summary },
    { firstSyncAfterSignIn: first, askedNewestAt: askedNewestAt() },
  );
  if (step === "ask") {
    rememberAsked(summary.newestAt);
    shareQuestionOpen = true;
    notify();
  } else if (step === "drain") return drain();
  return null;
}

async function drain(): Promise<DrainResult | null> {
  if (draining) return draining;
  draining = (async () => {
    // §6.6: never offline, never mid-scan; the queue waits.
    if (!shareReady() || (await scanBusy())) return null;
    const rpc = archiveRpc();
    if (!rpc) return null;
    const r = await runDrain(rpc);
    lastDrain = r;
    if (r?.errors.length) console.warn(`share: ${r.errors.join("; ")}`);
    await refreshPendingShare();
    return r;
  })().finally(() => {
    draining = null;
    notify();
  });
  notify();
  const r = await draining;
  // The new Shared Videos' posters, then the after-write Sync (§6.4) for what others changed meanwhile.
  if (r && r.shared > 0) {
    await uploadPostersNow();
    void afterWrite();
  }
  return r;
}

/**
 * The question's "Share" (§6.6): this machine answers once, later drains run without asking. Drains now.
 */
export async function shareNow(): Promise<DrainResult | null> {
  shareQuestionOpen = false;
  const s = await setShareAuto("", true);
  if (s) shareSummary = s;
  notify();
  return drain();
}

/** The question's "Not now": the queue waits and the Videos stay Unshared; the chip row reopens the question. */
export function declineShare() {
  shareQuestionOpen = false;
  notify();
}

/** The chip row **Share n new Videos…** (#131 owns the row): opens the same question while the queue is non-empty. */
export async function openShareQuestion(): Promise<void> {
  await considerShare("open");
}

/** Uploads this machine's local posters of Shared Videos that have none (§6.5), 4 at a time, in the background. */
export function uploadPostersNow(): Promise<PosterUploadResult | null> {
  if (posterRun) return posterRun;
  posterRun = (async () => {
    if (!shareReady() || !client) return null;
    const rpc = archiveRpc();
    if (!rpc) return null;
    posterState = { ...posterState, running: true, done: 0, total: 0 };
    notify();
    const r = await runPosterUpload(client, rpc, "", (done, total) => {
      posterState = { ...posterState, done, total };
      notify();
    });
    if (r?.errors.length) console.warn(`posters: ${r.errors.join("; ")}`);
    posterState = { ...posterState, running: false, last: r ?? posterState.last };
    return r;
  })().finally(() => {
    posterRun = null;
    posterState = { ...posterState, running: false };
    notify();
  });
  return posterRun;
}

async function afterSyncShare() {
  await considerShare("sync");
  await uploadPostersNow();
}

/**
 * A scan just finished (the top bar's scan poll calls this): §6.6's scan-end rule, then the poster upload. True when
 * Local copy rows changed (the caller reloads the grid).
 */
export async function afterScan(): Promise<boolean> {
  const d = await considerShare("scan-end");
  const u = await uploadPostersNow();
  return (d?.shared ?? 0) + (u?.uploaded ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------------------------------------------

export interface UseSession {
  /** The companion's Session record; render from it at once (null: Standalone, or the record was cleared). */
  record: SessionRecord | null;
  /** `/api/session` answered (before that, `record` null means "not known yet"). */
  recordLoaded: boolean;
  /** supabase-js reported its initial session, or 2.5 s passed. Unsettled counts as offline. */
  authSettled: boolean;
  /** Edit controls are enabled (§5.3): the one rule. */
  canEdit: boolean;
  /** Edit controls are shown (the record says Video Editor), enabled or not. */
  editorView: boolean;
  /** This browser holds a session (of anyone); the chip's "Sign in" shows when false. */
  browserSignedIn: boolean;
  /** The last probe or Sync reached the archive; null before either ran. Offline = false. */
  reachable: boolean | null;
  syncing: boolean;
  lastSyncError: string | null;
  /** §5.4: set when the session dropped; the banner shows it until `dismissEnded()`. */
  ended: EndedReason | null;
  /** The running Sync's phase for the chip's Sync row ("checking" the session, then "pulling"); null when idle. */
  progress: SyncProgress | null;
  /** The last successful Sync (the record's `lastSyncAt`), ISO; null before the first. */
  lastSyncAt: string | null;
  /** §6.4's schema gate: set while this checkout and the archive disagree; the banner (#131) reads `line`. */
  schemaMismatch: SchemaMismatch | null;
  signIn: typeof signIn;
  signOut: typeof signOut;
  /** Continue on the reconciliation confirm. */
  confirmSignIn: typeof confirmSignIn;
  requestSync: typeof requestSync;
  dismissEnded: typeof dismissEnded;
  /** Call after a Video Editor's own write (#116). */
  afterWrite: typeof afterWrite;
  /** The chip menu's "Refresh all Shared data". */
  refreshAll: typeof refreshAll;
  /** §6.6: the `pending_share` queue's counts (null until read). The chip row shows while `count` > 0. */
  pendingShare: PendingShareSummary | null;
  /** §6.6: the one question is showing ("Share n new Videos from <folder>?"). */
  shareQuestion: boolean;
  /** A drain is running. */
  sharing: boolean;
  /** The last drain's outcome, null before one ran. */
  lastShare: DrainResult | null;
  shareNow: typeof shareNow;
  declineShare: typeof declineShare;
  openShareQuestion: typeof openShareQuestion;
  /** §6.5: the background poster upload. */
  posterUpload: PosterUploadState;
  uploadPosters: typeof uploadPostersNow;
}

export function useSession(): UseSession {
  const [, bump] = useState(0);
  useEffect(() => {
    void startSession();
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const s = state;
  const access = editAccess(s, Date.now());
  return {
    record: s.record, recordLoaded: s.recordLoaded, authSettled: s.authSettled, canEdit: access.enabled, editorView: access.shown,
    browserSignedIn: !!s.browser, reachable: s.reachable, syncing: s.syncing, lastSyncError: s.lastSyncError, ended: s.ended,
    progress: s.progress, lastSyncAt: s.record?.lastSyncAt ?? null, schemaMismatch: s.schemaMismatch,
    signIn, signOut, confirmSignIn, requestSync, dismissEnded, afterWrite, refreshAll,
    pendingShare: shareSummary, shareQuestion: shareQuestionOpen, sharing: draining != null, lastShare: lastDrain,
    shareNow, declineShare, openShareQuestion, posterUpload: posterState, uploadPosters: uploadPostersNow,
  };
}
