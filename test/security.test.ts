// Regression tests for docs/audit/01-security.md: the localhost guard (SEC-1..SEC-3), frame headers (SEC-5), the TV
// Server's loopback refusal (SEC-1), its CORS policy (SEC-4) and the file paths it no longer sends (SEC-6).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { localGuard } from "../src/server/localOnly";
import { isOwnAddress, lanAddresses, tvCorsOrigin, tvRequestError } from "../src/server/tv";
import { stripPaths } from "../src/server/tvRoutes";
import { insertCopy, insertVideo } from "./helpers/seed";

const EVIL = "https://evil.example";

describe("localGuard (pure)", () => {
  const req = (method: string, h: Record<string, string>, body?: string) => new Request("http://localhost:4400/api/x", { method, headers: h, body });
  const own = { host: "localhost:4400", origin: "http://localhost:4400" };
  test("reads: a loopback Host on this port passes; a rebinding Host or another port does not", () => {
    expect(localGuard(req("GET", { host: "localhost:4400" }), 4400)).toBeNull();
    expect(localGuard(req("GET", { host: "127.0.0.1:4400" }), 4400)).toBeNull();
    expect(localGuard(req("GET", { host: "[::1]:4400" }), 4400)).toBeNull();
    expect(localGuard(req("GET", { host: "rebind.evil.example:4400" }), 4400)).toMatchObject({ status: 403 });
    expect(localGuard(req("GET", { host: "localhost:4401" }), 4400)).toMatchObject({ status: 403 });
    expect(localGuard(req("GET", {}), 4400)).toMatchObject({ status: 403 });
  });
  test("writes: this companion's Origin passes; another site's, `null`, or a foreign Referer does not", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(localGuard(req(m, own), 4400)).toBeNull();
      expect(localGuard(req(m, { ...own, origin: EVIL }), 4400)).toMatchObject({ status: 403, error: "Origin is not this companion" });
      expect(localGuard(req(m, { ...own, origin: "null" }), 4400)).toMatchObject({ status: 403 });
      expect(localGuard(req(m, { ...own, origin: "http://localhost:4401" }), 4400)).toMatchObject({ status: 403 }); // another local app
      expect(localGuard(req(m, { host: own.host, referer: `${EVIL}/page` }), 4400)).toMatchObject({ status: 403 });
      expect(localGuard(req(m, { host: own.host, referer: "http://localhost:4400/play/x" }), 4400)).toBeNull();
      expect(localGuard(req(m, { host: own.host }), 4400)).toBeNull(); // curl on this machine: no browser sends a write without Origin
    }
  });
  test("a write with a body must be application/json (or the screenshot's image/png): never a CORS simple type", () => {
    expect(localGuard(req("POST", { ...own, "content-type": "application/json" }, "{}"), 4400)).toBeNull();
    expect(localGuard(req("POST", { ...own, "content-type": "application/json; charset=utf-8" }, "{}"), 4400)).toBeNull();
    expect(localGuard(req("POST", { ...own, "content-type": "image/png" }, "x"), 4400)).toBeNull();
    for (const t of ["text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      expect(localGuard(req("POST", { ...own, "content-type": t }, "{}"), 4400)).toMatchObject({ status: 415 });
    }
    const blob = new Request("http://localhost:4400/api/x", { method: "POST", headers: own, body: new Blob(["{}"]) }); // no type
    expect(localGuard(blob, 4400)).toMatchObject({ status: 415 });  });
});

describe("TV Server helpers (pure)", () => {
  test("this machine's own addresses", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "0.0.0.0", " 127.0.0.1 "]) expect(isOwnAddress(ip, [])).toBe(true);
    expect(isOwnAddress("192.168.1.5", ["192.168.1.5"])).toBe(true);
    expect(isOwnAddress("192.168.1.6", ["192.168.1.5"])).toBe(false);
  });
  test("CORS only for the TV app's origins; a name Host or another site's Origin is refused", () => {
    expect([null, "null", "file://"].map((o) => tvCorsOrigin(o))).toEqual([true, true, true]);
    expect([EVIL, "http://127.0.0.1:4401", "http://localhost:8081"].map((o) => tvCorsOrigin(o))).toEqual([false, false, false]);
    // TUVA_TV_LOOPBACK=1: the shell served on this machine for desktop testing, never another site
    expect([EVIL, "http://127.0.0.1:8081", "http://localhost:8081", "http://127.0.0.1.evil.example"].map((o) => tvCorsOrigin(o, true))).toEqual([false, true, true, false]);
    const r = (h: Record<string, string>) => new Request("http://x/api/videos", { headers: h });
    expect(tvRequestError(r({ host: "192.168.1.5:4401" }))).toBeNull();
    expect(tvRequestError(r({ host: "192.168.1.5:4401", origin: "null" }))).toBeNull();
    expect(tvRequestError(r({ host: "127.0.0.1:4401", origin: "http://127.0.0.1:4401" }))).toBeNull(); // the desktop page at /
    expect(tvRequestError(r({ host: "192.168.1.5:4401", origin: EVIL }))).toBe("Origin is not the TV app");
    expect(tvRequestError(r({ host: "rebind.evil.example:4401" }))).toBe("Host is not an address of this machine");
  });
  test("stripPaths drops every `path`, deep, and nothing else", () => {
    expect(stripPaths([{ id: 1, copies: [{ id: 2, url: "/copy/2", path: "/Users/me/x.mp4" }] }])).toEqual([{ id: 1, copies: [{ id: 2, url: "/copy/2" }] }]);
    expect(stripPaths({ a: null, b: [1, "path"] })).toEqual({ a: null, b: [1, "path"] });
  });
});

// ---- a real server ----

const base = mkdtempSync(join(tmpdir(), "tuva-sec-"));
const localDir = join(base, "local");
mkdirSync(localDir, { recursive: true });
let app: App;
let local: string;
let port: number;
let quits = 0;
let vid = "";
let copyId = 0;

beforeAll(async () => {
  // no TUVA_TV_LOOPBACK: this machine's own addresses are never a TV
  const cfg = loadConfig({ TUVA_DATA_DIR: join(base, "data"), TUVA_PORT: "0", TUVA_TV_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: localDir, TUVA_TRASH: "/bin/false" });
  app = await startApp(cfg, { quit: () => quits++ });
  port = app.server.port!;
  local = `http://localhost:${port}`;
  vid = insertVideo(app.db, { youtube_id: "aaaaaaaaaaa", title: "Secret title" });
  const rootId = (app.db.query("SELECT id FROM root ORDER BY id LIMIT 1").get() as { id: number }).id;
  copyId = insertCopy(app.db, { video_id: vid, root_id: rootId, rel_path: "Secret [aaaaaaaaaaa].mp4" });
}, 60_000);

afterAll(async () => {
  app.tv.stop();
  await app.stop();
  rmSync(base, { recursive: true, force: true });
});

const cross = { origin: EVIL, "content-type": "text/plain;charset=UTF-8" };
const rebind = () => ({ host: `rebind.evil.example:${port}`, origin: `http://rebind.evil.example:${port}` });

describe("the localhost listener refuses other sites (SEC-1, SEC-2, SEC-3)", () => {
  test("a cross-site simple POST cannot turn the TV Server on, approve an IP, plant an Artist or quit", async () => {
    expect((await fetch(`${local}/api/tv/on`, { method: "POST", headers: cross, body: "" })).status).toBe(403);
    expect(app.tv.on).toBe(false);
    expect((await fetch(`${local}/api/tv/approve`, { method: "POST", headers: cross, body: '{"ip":"192.0.2.66"}' })).status).toBe(403);
    expect(app.tv.approved()).toEqual([]);
    expect((await fetch(`${local}/api/artists`, { method: "POST", headers: cross, body: '{"name":"CSRF"}' })).status).toBe(403);
    expect(app.db.query("SELECT COUNT(*) n FROM local_artist WHERE name = 'CSRF'").get()).toEqual({ n: 0 });
    expect((await fetch(`${local}/api/rescan`, { method: "POST", headers: cross, body: "" })).status).toBe(403);
    expect((await fetch(`${local}/api/quit`, { method: "POST", headers: cross, body: "" })).status).toBe(403);
    expect(quits).toBe(0);
  });

  test("this companion's own page still writes; its text/plain body is refused (415)", async () => {
    const own = { origin: local, "content-type": "application/json" };
    const r = await fetch(`${local}/api/artists`, { method: "POST", headers: own, body: '{"name":"Own Artist"}' });
    expect(r.status).toBeLessThan(300);
    expect((await fetch(`${local}/api/tv/off`, { method: "POST", headers: { origin: local, "content-type": "text/plain" }, body: "" })).status).toBe(200); // an empty body needs no type
    expect((await fetch(`${local}/api/artists`, { method: "POST", headers: { origin: local, "content-type": "text/plain" }, body: '{"name":"Plain"}' })).status).toBe(415);
    const via127 = `http://127.0.0.1:${port}`;
    expect((await fetch(`${via127}/api/tv/deny`, { method: "POST", headers: { origin: via127, "content-type": "application/json" }, body: '{"ip":"192.0.2.9"}' })).status).toBe(200);
  });

  test("a DNS-rebinding Host is refused on reads and writes, deletes included", async () => {
    for (const p of ["/api/videos", "/api/favorites", "/api/roots", "/api/health", `/copy/${copyId}`, "/"]) {
      expect([p, (await fetch(local + p, { headers: rebind() })).status]).toEqual([p, 403]);
    }
    const del = await fetch(`${local}/api/videos/${vid}`, { method: "DELETE", headers: { ...rebind(), "content-type": "application/json" }, body: '{"media":true}' });
    expect(del.status).toBe(403);
    expect(app.db.query("SELECT COUNT(*) n FROM videos WHERE id = ?").get(vid)).toEqual({ n: 1 });
    expect((await fetch(`${local}/api/videos`, { headers: { host: `localhost:${port + 1}` } })).status).toBe(403); // another port
    expect((await fetch(`${local}/api/videos`)).status).toBe(200);
  });

  test("the shell page cannot be framed (SEC-5)", async () => {
    const r = await fetch(`${local}/`);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect((await fetch(`${local}/api/health`)).headers.get("x-frame-options")).toBeNull(); // JSON answers are left alone
  });
});

describe("the TV Server (SEC-1, SEC-4, SEC-6)", () => {
  const post = (p: string, body?: unknown) => fetch(local + p, { method: "POST", headers: { origin: local, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  test("this machine's own addresses are never approved, and raise no prompt", async () => {
    expect((await post("/api/tv/on")).status).toBe(200);
    for (const ip of ["127.0.0.1", "::1", ...lanAddresses()]) {
      const r = await post("/api/tv/approve", { ip });
      expect([ip, r.status]).toEqual([ip, 422]);
    }
    expect(app.tv.approved()).toEqual([]);
    const tvPort = app.tv.port!;
    const r = await fetch(`http://127.0.0.1:${tvPort}/api/videos`);
    expect(r.status).toBe(403);
    expect(app.tv.state().pending).toEqual([]);
    // a row stored before the fix is listed (so it can be Removed) but not served
    app.db.query("INSERT INTO approved_tv (ip, model, approved_at) VALUES ('127.0.0.1', NULL, ?)").run(new Date().toISOString());
    expect((await fetch(`http://127.0.0.1:${tvPort}/api/videos`)).status).toBe(403);
    app.db.query("DELETE FROM approved_tv").run();
  });

  test("CORS answers only the TV app's origins; another site's page gets a 403 and no CORS headers", async () => {
    expect((await post("/api/tv/approve", { ip: "10.0.0.7" })).status).toBe(200);
    const tv = (p: string, init: RequestInit = {}) => app.tv.fetch(new Request(`http://10.0.0.1:4401${p}`, { ...init, headers: { host: "10.0.0.1:4401", ...(init.headers as Record<string, string>) } }), "10.0.0.7");
    const shell = await tv("/api/videos", { headers: { origin: "null" } });
    expect(shell.status).toBe(200);
    expect(shell.headers.get("access-control-allow-origin")).toBe("*");
    const tizen = await tv("/api/videos");
    expect(tizen.headers.get("access-control-allow-origin")).toBe("*");
    const evil = await tv("/api/videos", { headers: { origin: EVIL } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await tv("/api/videos", { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "GET", "access-control-request-headers": "x-tuva-tv" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-tuva-tv");
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, HEAD, POST");
    const evilPre = await tv("/api/videos", { method: "OPTIONS", headers: { origin: EVIL, "access-control-request-method": "GET" } });
    expect(evilPre.headers.get("access-control-allow-origin")).toBeNull();
    const rebound = await tv("/api/videos", { headers: { host: "rebind.evil.example:4401" } });
    expect(rebound.status).toBe(403);
    // the two writes the TV makes still work with its text/plain bodies
    const w = await tv(`/api/videos/${vid}/view`, { method: "POST", headers: { origin: "null", "content-type": "text/plain" } });
    expect(w.status).toBe(200);
  });

  test("no answer to a TV carries a Copy's absolute file path; localhost still does", async () => {
    const tv = (p: string) => app.tv.fetch(new Request(`http://10.0.0.1:4401${p}`), "10.0.0.7").then((r) => r.text());
    for (const p of ["/api/videos", `/api/videos/${vid}`, `/api/copies/${copyId}`]) {
      const body = await tv(p);
      expect(body).toContain(`/copy/${copyId}`);
      expect([p, body.includes(localDir), body.includes('"path"')]).toEqual([p, false, false]);
    }
    expect(await (await fetch(`${local}/api/copies/${copyId}`)).json()).toMatchObject({ path: join(localDir, "Secret [aaaaaaaaaaa].mp4") });
    await fetch(`${local}/api/tv/approved/10.0.0.7`, { method: "DELETE", headers: { origin: local } });
  });
});
