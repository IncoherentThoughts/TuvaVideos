// The browser's session layer (docs/sharing-spec.md §5.1–§5.4; ticket #130): the one supabase-js client, the Session
// record from the companion, and `useSession()`, the hook the chip, the dialog, the banners (#131) and the edit
// controls (#116) read. One store per tab, started once (main.tsx); several tabs agree through supabase-js's own
// storage plus a `localStorage` broadcast of record changes. The pure rules are in src/shared/session.ts.
//
// No timers but the one-shot 2.5 s `authSettled` wait: the revocation probe runs on window focus and before each Sync.
import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "preact/hooks";
import type { RpcClient } from "../shared/archive";
import {
  AUTH_SETTLE_MS, classifySignedOut, decodeTab, editAccess, encodeTab, focusWantsSync, INITIAL_SESSION_STATE, probeOutcome,
  SIGN_IN_ERRORS, signInFailure, sessionReducer, tabAction, TAB_KEY,
  type BrowserSession, type EndedReason, type ProbeOutcome, type SessionAction, type SessionRecord, type SessionResponse,
  type SessionState, type SyncResponse, type TabMessage,
} from "../shared/session";

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
    if (session && state.record?.userId === session.user.id) void requestSync();
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
  if (focusWantsSync(state.record, state.browser, Date.now())) void requestSync();
  else void probe();
}

/**
 * One Sync from this tab at a time (a second call while one runs gets the same promise; the companion coalesces
 * across tabs). Probes first; hands the access token, and only it, to `POST /api/sync`. Null when nothing ran.
 */
export function requestSync(): Promise<SyncResponse | null> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    await clientReady;
    if (!client) return null;
    dispatch({ type: "sync-start" });
    const p = await probe();
    if (p !== "ok") {
      if (p === "revoked") return null;
      dispatch({ type: "sync-end", reachable: p === "unreachable" ? false : state.reachable === true, error: p === "unreachable" ? "The archive can't be reached" : "Not signed in" });
      return null;
    }
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      dispatch({ type: "sync-end", reachable: true, error: "Not signed in" });
      return null;
    }
    let res: SyncResponse;
    try {
      const r = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ access_token: token }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
      res = (await r.json()) as SyncResponse;
    } catch (e) {
      dispatch({ type: "sync-end", reachable: state.reachable === true, error: `Sync failed: ${(e as Error).message}` });
      return null;
    }
    dispatch({ type: "sync-end", record: res.record, reachable: res.reachable, error: res.error });
    broadcast({ kind: "record", record: res.record });
    return res;
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

export interface SignInResult {
  ok: boolean;
  /** One of §5.1's three lines when `ok` is false. */
  error: string | null;
  /** The first Sync after the sign-in; null when it could not run (the record is then unchanged). */
  sync: SyncResponse | null;
  /** `video_whoami().must_change_password`: show the notice linking to songsofthesteppe.org; the session stays. */
  mustChangePassword: boolean;
}

/** §5.1: `signInWithPassword`, then a Sync that writes the record. Reconciliation's count and confirm are #131/#115's. */
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
  const sync = await requestSync();
  return { ok: true, error: null, sync, mustChangePassword: sync?.mustChangePassword === true };
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
  signIn: typeof signIn;
  signOut: typeof signOut;
  requestSync: typeof requestSync;
  dismissEnded: typeof dismissEnded;
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
    signIn, signOut, requestSync, dismissEnded,
  };
}
