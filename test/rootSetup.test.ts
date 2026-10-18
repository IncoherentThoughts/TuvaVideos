// First launch (docs/sharing-spec.md §8.4): the Root field's path check, which onboarding surface shows, and the
// routes that insert the `root` row (starting the first scan) and dismiss the Member's bar.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { writeSessionRecord } from "../src/server/localCopy/meta";
import { checkRootPath, expandHome, onboardingFor, parseRootInput, rootErrorFor, type RootFs } from "../src/server/rootSetup";

describe("the Root field's path", () => {
  test("~ expands to the home directory; other text is trimmed and kept", () => {
    expect(expandHome("~", "/Users/a")).toBe("/Users/a");
    expect(expandHome(" ~/Videos ", "/Users/a/")).toBe("/Users/a/Videos");
    expect(expandHome("/srv/v", "/Users/a")).toBe("/srv/v");
    expect(expandHome("~bob/x", "/Users/a")).toBe("~bob/x");
  });

  test("only an absolute path passes; it is normalized without a trailing slash", () => {
    expect(parseRootInput("/a/b/../c/", "/h", posix.isAbsolute)).toEqual({ ok: true, path: "/a/c" });
    expect(parseRootInput("~/v", "/h", posix.isAbsolute)).toEqual({ ok: true, path: "/h/v" });
    expect(parseRootInput("/", "/h", posix.isAbsolute)).toEqual({ ok: true, path: "/" });
    for (const bad of ["", "   ", "Videos", "./v", "~bob/x"]) expect(parseRootInput(bad, "/h", posix.isAbsolute)).toEqual({ ok: false, error: "Enter the folder's full path" });
    expect(parseRootInput("C:\\Videos", "C:\\Users\\a", win32.isAbsolute).ok).toBe(true);
  });

  test("fs codes map to the three inline errors", () => {
    expect(rootErrorFor("ENOENT")).toBe("Not found");
    expect(rootErrorFor("ENOTDIR")).toBe("Not a folder");
    expect(rootErrorFor("EACCES")).toBe("Can't read it");
    expect(rootErrorFor("EPERM")).toBe("Can't read it");
    expect(rootErrorFor(undefined)).toBe("Can't read it");
  });

  test("the check: exists, is a directory, readable", async () => {
    const fail = (code: string) => Object.assign(new Error(code), { code });
    const fs = (isDir: boolean | string, list?: string): RootFs => ({
      isDirectory: async () => (typeof isDir === "string" ? Promise.reject(fail(isDir)) : isDir),
      canList: async () => (list ? Promise.reject(fail(list)) : undefined),
    });
    expect(await checkRootPath("/x", "/h", fs("ENOENT"))).toEqual({ ok: false, error: "Not found" });
    expect(await checkRootPath("/x", "/h", fs(false))).toEqual({ ok: false, error: "Not a folder" });
    expect(await checkRootPath("/x", "/h", fs(true, "EACCES"))).toEqual({ ok: false, error: "Can't read it" });
    expect(await checkRootPath("/x/", "/h", fs(true))).toEqual({ ok: true, path: "/x" });
    expect(await checkRootPath("rel", "/h", fs(true))).toEqual({ ok: false, error: "Enter the folder's full path" });
  });

  test("on the real filesystem", async () => {
    const base = mkdtempSync(join(tmpdir(), "tuva-rootcheck-"));
    try {
      writeFileSync(join(base, "file.mp4"), "x");
      mkdirSync(join(base, "locked"));
      chmodSync(join(base, "locked"), 0o000);
      expect(await checkRootPath(base, "/h")).toEqual({ ok: true, path: base });
      expect(await checkRootPath(join(base, "nope"), "/h")).toEqual({ ok: false, error: "Not found" });
      expect(await checkRootPath(join(base, "file.mp4"), "/h")).toEqual({ ok: false, error: "Not a folder" });
      if (process.getuid?.() !== 0) expect(await checkRootPath(join(base, "locked"), "/h")).toEqual({ ok: false, error: "Can't read it" });
    } finally {
      chmodSync(join(base, "locked"), 0o755);
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("which onboarding surface shows", () => {
  test("no Root: the panel without the grant, the bar with it until dismissed; a Root: nothing", () => {
    expect(onboardingFor({ mode: "standalone", rootCount: 0, barDismissed: false })).toBe("panel");
    expect(onboardingFor({ mode: "no-grant", rootCount: 0, barDismissed: true })).toBe("panel");
    expect(onboardingFor({ mode: "member", rootCount: 0, barDismissed: false })).toBe("bar");
    expect(onboardingFor({ mode: "editor", rootCount: 0, barDismissed: false })).toBe("bar");
    expect(onboardingFor({ mode: "member", rootCount: 0, barDismissed: true })).toBe("none");
    expect(onboardingFor({ mode: "standalone", rootCount: 1, barDismissed: false })).toBe("none");
    expect(onboardingFor({ mode: "member", rootCount: 1, barDismissed: false })).toBe("none");
  });

  test("config has no hard-coded Root; TUVA_LOCAL_ROOT still seeds one", () => {
    expect(loadConfig({ TUVA_DATA_DIR: "/tmp/x" }).localRoot).toBeUndefined();
    expect(loadConfig({ TUVA_DATA_DIR: "/tmp/x", TUVA_LOCAL_ROOT: "/r" }).localRoot).toBe("/r");
  });
});

describe("first-launch routes", () => {
  const base = mkdtempSync(join(tmpdir(), "tuva-onboard-"));
  const apps: App[] = [];
  afterAll(async () => {
    for (const a of apps) await a.stop();
    rmSync(base, { recursive: true, force: true });
  });
  const start = async (name: string) => {
    const app = await startApp(loadConfig({ TUVA_DATA_DIR: join(base, name), TUVA_PORT: "0", TUVA_NO_OPEN: "1" }));
    apps.push(app);
    const url = `http://localhost:${app.server.port}`;
    const post = (p: string, body?: unknown) =>
      fetch(url + p, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: body === undefined ? undefined : JSON.stringify(body) });
    const get = (p: string) => fetch(url + p).then((r) => r.json() as Promise<any>);
    return { app, post, get };
  };

  test("a fresh machine shows the panel; a good folder inserts the root row and scans it", async () => {
    const { app, post, get } = await start("standalone");
    expect(await get("/api/onboarding")).toEqual({ mode: "standalone", rootCount: 0, show: "panel" });
    const missing = await post("/api/roots", { path: join(base, "no-such") });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toEqual({ error: "Not found" });
    const folder = join(base, "videos");
    mkdirSync(folder);
    const ok = await post("/api/roots", { path: folder + "/" });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as any;
    expect(body.root).toMatchObject({ path: folder, kind: "local" });
    expect(body.onboarding.show).toBe("none");
    await app.scanner.whenIdle();
    expect(app.scanner.progress().last.map((s: { rootId: number }) => s.rootId)).toEqual([body.root.id]);
    expect((await post("/api/roots", { path: folder })).status).toBe(409);
    expect((await fetch(`http://localhost:${app.server.port}/api/roots`, { method: "POST", body: JSON.stringify({ path: folder }) })).status).toBe(403);
  });

  test("a Member with no Root gets the bar; dismissing it is remembered", async () => {
    const { app, post, get } = await start("member");
    writeSessionRecord(app.db, { userId: "u1", grantLevel: "member" });
    expect(await get("/api/onboarding")).toEqual({ mode: "member", rootCount: 0, show: "bar" });
    expect(((await (await post("/api/onboarding/dismiss-bar")).json()) as any).show).toBe("none");
    expect((await get("/api/onboarding")).show).toBe("none");
  });
});
