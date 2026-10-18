// Sign-in core (sharing-spec §5.2–§5.4, §4.9; ticket #130): the archive client's pure parts, the Origin/Host checks of
// the session routes, the Session record's lifecycle through /api/sync and /api/session against a mocked PostgREST,
// one Sync at a time, the edit-control enablement rule, and the multi-tab reducer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCHIVE_KEY, ARCHIVE_URL, archiveEndpoint, changesSince, looksLikeJwt, postgrestClient, tokenExp, whoami, type RpcClient } from "../src/shared/archive";
import {
  classifySignedOut, decodeTab, editAccess, encodeTab, focusWantsSync, INITIAL_SESSION_STATE, probeOutcome, sessionReducer, signInFailure,
  tabAction, type SessionRecord, type SessionState,
} from "../src/shared/session";
import { hostError, localRequestError } from "../src/server/localOnly";
import { coalesce, schemaGateError } from "../src/server/sync";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.c2lnbmF0dXJl`;
const future = () => Math.floor(Date.now() / 1000) + 3600;

const REC: SessionRecord = {
  userId: "u-1", email: "m@example.org", displayName: "M", avatarUrl: null, grantLevel: "editor", archiveRole: "user",
  lastVerifiedAt: "2026-10-17T10:00:00Z", lastSyncAt: null, watermark: null,
};

describe("the archive client (src/shared/archive.ts)", () => {
  test("committed project and key; TUVA_ARCHIVE_URL / TUVA_ARCHIVE_KEY override", () => {
    expect(archiveEndpoint({})).toEqual({ url: ARCHIVE_URL, key: ARCHIVE_KEY });
    expect(ARCHIVE_KEY.startsWith("sb_publishable_")).toBe(true);
    expect(archiveEndpoint({ TUVA_ARCHIVE_URL: "http://127.0.0.1:9/", TUVA_ARCHIVE_KEY: "k" })).toEqual({ url: "http://127.0.0.1:9", key: "k" });
    expect(loadConfig({ TUVA_DATA_DIR: "/tmp/x", TUVA_ARCHIVE_URL: "http://a" }).archive.url).toBe("http://a");
  });

  test("tokenExp reads the claim without verifying; looksLikeJwt rejects other shapes", () => {
    expect(tokenExp(jwt({ exp: 123, sub: "u" }))).toBe(123);
    expect(tokenExp("nope")).toBeNull();
    expect(looksLikeJwt(jwt({ exp: 1 }))).toBe(true);
    expect(looksLikeJwt("a b.c.d")).toBe(false);
    expect(looksLikeJwt(42)).toBe(false);
    expect(looksLikeJwt("only.two")).toBe(false);
  });

  test("calls decode errors through readArchiveError and tell unreachable and 401 apart", async () => {
    const answer = (res: Awaited<ReturnType<RpcClient["rpc"]>>): RpcClient => ({ rpc: async () => res });
    expect(await whoami(answer({ data: { user_id: "u" }, error: null, status: 200 }))).toEqual({ ok: true, value: { user_id: "u" } as never });
    const off = await whoami(answer({ data: null, error: { code: "", message: "TypeError: fetch failed" }, status: 0 }));
    expect(off).toMatchObject({ ok: false, unreachable: true, unauthorized: false });
    const expired = await whoami(answer({ data: null, error: { code: "PGRST301", message: "JWT expired" }, status: 401 }));
    expect(expired).toMatchObject({ ok: false, unreachable: false, unauthorized: true });
    const forbidden = await changesSince(answer({ data: null, error: { code: "42501", message: "no" }, status: 403 }), null);
    expect(forbidden).toMatchObject({ ok: false, error: { word: "forbidden" }, unreachable: false });
    const thrown = await whoami({ rpc: () => Promise.reject(new Error("boom")) });
    expect(thrown).toMatchObject({ ok: false, unreachable: true });
  });

  test("postgrestClient sends the token in the Authorization header only", async () => {
    let seen: { url: string; auth: string | null; apikey: string | null; body: string } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen = { url, auth: h.get("authorization"), apikey: h.get("apikey"), body: String(init.body) };
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await changesSince(postgrestClient({ url: "http://arch", key: "pk" }, "TOKEN", fake), "2026-01-01T00:00:00Z");
    expect(r).toEqual({ ok: true, value: { ok: 1 } as never });
    expect(seen!).toEqual({ url: "http://arch/rest/v1/rpc/shared_changes_since", auth: "Bearer TOKEN", apikey: "pk", body: '{"p_since":"2026-01-01T00:00:00Z"}' });
  });
});

describe("Origin and Host checks of the session routes", () => {
  const req = (h: Record<string, string>) => new Request("http://localhost:4400/api/sync", { method: "POST", headers: h });
  test("same-origin loopback passes; another site, a rebinding Host, a missing Origin do not", () => {
    expect(localRequestError(req({ host: "localhost:4400", origin: "http://localhost:4400" }))).toBeNull();
    expect(localRequestError(req({ host: "127.0.0.1:4400", origin: "http://127.0.0.1:4400" }))).toBeNull();
    expect(localRequestError(req({ host: "localhost:4400", origin: "https://evil.example" }))).toBe("Origin is not this companion");
    expect(localRequestError(req({ host: "evil.example:4400", origin: "http://evil.example:4400" }))).toBe("Host is not this machine");
    expect(localRequestError(req({ host: "localhost:4400" }))).toBe("no Origin header");
  });
  test("the GET's Host check needs no Origin", () => {
    expect(hostError(req({ host: "localhost:4400" }))).toBeNull();
    expect(hostError(req({ host: "rebind.example" }))).toBe("Host is not this machine");
  });
});

describe("one Sync at a time", () => {
  test("calls during a run share one follow-up run with the newest argument", async () => {
    const runs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c = coalesce(async (a: string) => {
      runs.push(a);
      if (a === "first") await gate;
      return a;
    });
    const p1 = c.request("first");
    const p2 = c.request("second");
    const p3 = c.request("third");
    expect(c.busy()).toBe(true);
    release();
    expect(await Promise.all([p1, p2, p3])).toEqual(["first", "third", "third"]);
    expect(runs).toEqual(["first", "third"]);
    expect(c.busy()).toBe(false);
    expect(await c.request("later")).toBe("later");
  });
  test("a failed run does not wedge the queue", async () => {
    const c = coalesce(async (a: number) => {
      if (a === 1) throw new Error("x");
      return a;
    });
    const p1 = c.request(1);
    const p2 = c.request(2);
    await expect(p1).rejects.toThrow("x");
    expect(await p2).toBe(2);
  });
  test("the schema gate's lines", () => {
    expect(schemaGateError(1, 1)).toBeNull();
    expect(schemaGateError(1, 2)).toBe("Update TuvaVideos: git pull, then restart");
    expect(schemaGateError(2, 1)).toContain("has not run yet");
  });
});

describe("the Session record through /api/sync and /api/session (mocked PostgREST)", () => {
  const base = mkdtempSync(join(tmpdir(), "tuva-session-"));
  let app: App;
  let mock: ReturnType<typeof Bun.serve>;
  let url = "";
  const seen: { auth: string | null; apikey: string | null }[] = [];
  let who: Record<string, unknown> | { status: number; body: unknown } = {};
  let delayMs = 0;
  beforeAll(async () => {
    mock = Bun.serve({
      port: 0,
      async fetch(r) {
        // The pull (#139) answers an empty bundle here; test/syncPull.test.ts covers it.
        if (new URL(r.url).pathname === "/rest/v1/rpc/shared_changes_since")
          return Response.json({ shared_schema: 1, server_time: "2026-10-17T12:00:01Z", since: null, watermark: null, tables: {}, replace_whole: [], tombstones: [], archive_ids: {} });
        if (new URL(r.url).pathname !== "/rest/v1/rpc/video_whoami") return new Response("{}", { status: 404 });
        seen.push({ auth: r.headers.get("authorization"), apikey: r.headers.get("apikey") });
        if (delayMs) await Bun.sleep(delayMs);
        if ("status" in who) return new Response(JSON.stringify(who.body), { status: who.status as number });
        return Response.json(who);
      },
    });
    app = await startApp(loadConfig({ TUVA_DATA_DIR: join(base, "m"), TUVA_PORT: "0", TUVA_NO_OPEN: "1", TUVA_ARCHIVE_URL: `http://127.0.0.1:${mock.port}`, TUVA_ARCHIVE_KEY: "test-key" }));
    url = `http://localhost:${app.server.port}`;
  });
  afterAll(async () => {
    await app.stop();
    mock.stop(true);
    rmSync(base, { recursive: true, force: true });
  });
  const sync = (body: unknown, origin = url) =>
    fetch(url + "/api/sync", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
  const session = () => fetch(url + "/api/session").then((r) => r.json() as Promise<any>);
  const whoamiOf = (o: Record<string, unknown> = {}) => ({
    user_id: "11111111-1111-4111-8111-111111111111", email: "ed@example.org", display_name: "Ed", avatar_url: "https://x/a.png",
    must_change_password: false, archive_role: "user", grant_level: "editor", granted_at: null, shared_schema: 1, server_time: "2026-10-17T12:00:00Z", ...o,
  });

  test("GET /api/session starts empty and names the archive the browser should use", async () => {
    expect(await session()).toEqual({ record: null, archive: { url: `http://127.0.0.1:${mock.port}`, key: "test-key" }, syncing: false });
  });

  test("refusals: another Origin, a refresh token in the body, no token", async () => {
    const token = jwt({ exp: future(), sub: "x" });
    expect((await sync({ access_token: token }, "https://evil.example")).status).toBe(403);
    expect((await sync({ access_token: token, refresh_token: "r" })).status).toBe(400);
    expect((await sync({})).status).toBe(400);
    expect(seen.length).toBe(0);
  });

  test("a Sync calls video_whoami with the token and writes the record; the token is not kept or logged", async () => {
    who = whoamiOf({ must_change_password: true });
    const token = jwt({ exp: future(), sub: "11111111-1111-4111-8111-111111111111" });
    const r = await sync({ access_token: token }).then((x) => x.json() as Promise<any>);
    expect(seen.at(-1)).toEqual({ auth: `Bearer ${token}`, apikey: "test-key" });
    expect(r).toMatchObject({ ok: true, reachable: true, pulled: true, full: true, mustChangePassword: true, schema: { client: 1, archive: 1 }, error: null });
    expect(r.record).toEqual({
      userId: "11111111-1111-4111-8111-111111111111", email: "ed@example.org", displayName: "Ed", avatarUrl: "https://x/a.png",
      grantLevel: "editor", archiveRole: "user", lastVerifiedAt: "2026-10-17T12:00:00Z", lastSyncAt: expect.any(String), watermark: null,
    });
    expect((await session()).record).toEqual(r.record);
    const logPath = loadConfig({ TUVA_DATA_DIR: join(base, "m") }).logPath;
    if (existsSync(logPath)) expect(readFileSync(logPath, "utf8")).not.toContain(token);
    const dbBytes = readFileSync(join(base, "m", "library.db"));
    expect(dbBytes.includes(Buffer.from(token.split(".")[1]!))).toBe(false);
  });

  test("an unreachable or refusing archive leaves the record untouched", async () => {
    const before = (await session()).record;
    who = { status: 401, body: { code: "PGRST301", message: "JWT expired" } };
    const r401 = await sync({ access_token: jwt({ exp: future() }) }).then((x) => x.json() as Promise<any>);
    expect(r401).toMatchObject({ ok: false, reachable: true, unauthorized: true });
    expect(r401.record).toEqual(before);
    const expired = await sync({ access_token: jwt({ exp: 1000 }) }).then((x) => x.json() as Promise<any>);
    expect(expired).toMatchObject({ ok: false, unauthorized: true, error: "The session's access token has expired" });
    expect((await session()).record).toEqual(before);
  });

  test("the schema gate stops the Sync but the record still names who signed in", async () => {
    who = whoamiOf({ shared_schema: 2, grant_level: "member" });
    const r = await sync({ access_token: jwt({ exp: future() }) }).then((x) => x.json() as Promise<any>);
    expect(r).toMatchObject({ ok: false, reachable: true, schema: { client: 1, archive: 2 }, error: "Update TuvaVideos: git pull, then restart" });
    expect(r.record.grantLevel).toBe("member");
  });

  test("another account starts a fresh record; no grant is a record with grantLevel null", async () => {
    who = whoamiOf({ user_id: "22222222-2222-4222-8222-222222222222", grant_level: null, email: "n@example.org" });
    const r = await sync({ access_token: jwt({ exp: future() }) }).then((x) => x.json() as Promise<any>);
    expect(r.record).toMatchObject({ userId: "22222222-2222-4222-8222-222222222222", grantLevel: null, watermark: null });
    const onb = await fetch(url + "/api/onboarding").then((x) => x.json() as Promise<any>);
    expect(onb.mode).toBe("no-grant");
  });

  test("Syncs from several tabs coalesce: one running, one follow-up", async () => {
    who = whoamiOf();
    delayMs = 150;
    const n = seen.length;
    const all = await Promise.all([1, 2, 3].map(() => sync({ access_token: jwt({ exp: future() }) }).then((x) => x.json() as Promise<any>)));
    delayMs = 0;
    expect(all.every((r) => r.ok)).toBe(true);
    expect(seen.length - n).toBe(2);
  });

  test("DELETE /api/session clears the record (Sign out, SIGNED_OUT, cancelled sign-in); Origin checked", async () => {
    expect((await fetch(url + "/api/session", { method: "DELETE", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await session()).record).not.toBeNull();
    const r = await fetch(url + "/api/session", { method: "DELETE", headers: { origin: url } });
    expect(await r.json()).toEqual({ record: null });
    expect((await session()).record).toBeNull();
  });
});

describe("the edit-control enablement rule (§5.3)", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const live = { userId: "u-1", expiresAt: now / 1000 + 600 };
  const s = (o: Partial<SessionState>): SessionState => ({ ...INITIAL_SESSION_STATE, record: REC, authSettled: true, browser: live, reachable: true, ...o });
  test("enabled only with a settled, unexpired session of the record's user and a reached archive", () => {
    expect(editAccess(s({}), now)).toEqual({ shown: true, enabled: true });
    expect(editAccess(s({ authSettled: false }), now)).toEqual({ shown: true, enabled: false });
    expect(editAccess(s({ reachable: false }), now).enabled).toBe(false);
    expect(editAccess(s({ reachable: null }), now).enabled).toBe(false);
    expect(editAccess(s({ browser: null }), now).enabled).toBe(false);
    expect(editAccess(s({ browser: { userId: "u-2", expiresAt: null } }), now).enabled).toBe(false);
    expect(editAccess(s({ browser: { userId: "u-1", expiresAt: now / 1000 - 1 } }), now).enabled).toBe(false);
  });
  test("shown only for a Video Editor's record", () => {
    expect(editAccess(s({ record: { ...REC, grantLevel: "member" } }), now)).toEqual({ shown: false, enabled: false });
    expect(editAccess(s({ record: { ...REC, grantLevel: null } }), now)).toEqual({ shown: false, enabled: false });
    expect(editAccess(s({ record: null }), now)).toEqual({ shown: false, enabled: false });
  });
  test("focus Syncs when the last Sync is older than 10 minutes", () => {
    expect(focusWantsSync(REC, live, now)).toBe(true);
    expect(focusWantsSync({ ...REC, lastSyncAt: "2026-10-17T11:55:00Z" }, live, now)).toBe(false);
    expect(focusWantsSync({ ...REC, lastSyncAt: "2026-10-17T11:45:00Z" }, live, now)).toBe(true);
    expect(focusWantsSync(REC, null, now)).toBe(false);
    expect(focusWantsSync(null, live, now)).toBe(false);
  });
});

describe("the session reducer and several tabs", () => {
  test("record lifecycle: loaded, ended (record cleared, reason kept), re-sign-in clears the notice, sign out", () => {
    let s = sessionReducer(INITIAL_SESSION_STATE, { type: "record", record: REC });
    expect(s).toMatchObject({ record: REC, recordLoaded: true, ended: null });
    s = sessionReducer(s, { type: "auth", session: { userId: "u-1", expiresAt: null } });
    s = sessionReducer(s, { type: "ended", reason: "session-ended" });
    expect(s).toMatchObject({ record: null, browser: null, ended: "session-ended" });
    s = sessionReducer(s, { type: "record", record: null });
    expect(s.ended).toBe("session-ended");
    s = sessionReducer(s, { type: "sync-start" });
    s = sessionReducer(s, { type: "sync-end", record: REC, reachable: true, error: null });
    expect(s).toMatchObject({ record: REC, ended: null, syncing: false, reachable: true });
    s = sessionReducer(s, { type: "sync-end", reachable: false, error: "The archive can't be reached" });
    expect(s).toMatchObject({ record: REC, reachable: false, lastSyncError: "The archive can't be reached" });
    s = sessionReducer(s, { type: "signed-out" });
    expect(s).toMatchObject({ record: null, browser: null, ended: null, lastSyncError: null });
    const settled = sessionReducer(s, { type: "settled" });
    expect(sessionReducer(settled, { type: "settled" })).toBe(settled);
  });

  test("tab messages round-trip; own writes, junk and unknown kinds are ignored", () => {
    const raw = encodeTab("tab-a", 1, { kind: "record", record: REC });
    expect(decodeTab(raw, "tab-b")).toEqual({ kind: "record", record: REC });
    expect(decodeTab(raw, "tab-a")).toBeNull();
    expect(decodeTab("{", "tab-b")).toBeNull();
    expect(decodeTab(null, "tab-b")).toBeNull();
    expect(decodeTab(encodeTab("a", 2, { kind: "ended", reason: "nope" as never }), "b")).toBeNull();
    expect(decodeTab(JSON.stringify({ from: "a", seq: 1, msg: { kind: "token", t: "x" } }), "b")).toBeNull();
    expect(decodeTab(encodeTab("a", 3, { kind: "record", record: { nope: 1 } as never }), "b")).toBeNull();
  });

  test("another tab's messages drive this tab like its own events", () => {
    const start = sessionReducer(INITIAL_SESSION_STATE, { type: "record", record: REC });
    const ended = sessionReducer(start, tabAction({ kind: "ended", reason: "revoked" }));
    expect(ended).toMatchObject({ record: null, ended: "revoked" });
    expect(sessionReducer(ended, tabAction({ kind: "dismiss-ended" })).ended).toBeNull();
    expect(sessionReducer(start, tabAction({ kind: "signed-out" })).record).toBeNull();
    expect(sessionReducer(ended, tabAction({ kind: "record", record: REC }))).toMatchObject({ record: REC, ended: null });
  });
});

describe("reading supabase-js outcomes", () => {
  test("sign-in errors map to §5.1's three lines", () => {
    expect(signInFailure({ name: "AuthApiError", status: 400, code: "invalid_credentials" })).toBe("wrong");
    expect(signInFailure({ name: "AuthApiError", status: 429, code: "over_request_rate_limit" })).toBe("rate-limited");
    expect(signInFailure({ name: "AuthRetryableFetchError", status: 0 })).toBe("unreachable");
    expect(signInFailure({ name: "AuthApiError", status: 503 })).toBe("unreachable");
  });
  test("the revocation probe", () => {
    expect(probeOutcome(null)).toBe("ok");
    expect(probeOutcome({ name: "AuthRetryableFetchError", status: 0 })).toBe("unreachable");
    expect(probeOutcome({ name: "AuthApiError", status: 403, code: "session_not_found" })).toBe("revoked");
    expect(probeOutcome({ name: "AuthApiError", status: 401, code: "bad_jwt" })).toBe("revoked");
    // session_not_found reaches us as AuthSessionMissingError: revoked when a session was held, else nothing to probe.
    expect(probeOutcome({ name: "AuthSessionMissingError", status: 400 }, true)).toBe("revoked");
    expect(probeOutcome({ name: "AuthSessionMissingError", status: 400 }, false)).toBe("no-session");
  });
  test("a SIGNED_OUT this tab did not start, with the record still held, is a dropped session", () => {
    expect(classifySignedOut({ initiatedHere: false, recordPresent: true })).toBe("dropped");
    expect(classifySignedOut({ initiatedHere: false, recordPresent: false })).toBe("user");
    expect(classifySignedOut({ initiatedHere: true, recordPresent: true })).toBe("user");
  });
});
