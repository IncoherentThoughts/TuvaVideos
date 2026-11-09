// Instagram sign-in (downloader-spec §5): the settings and their validation (the cookies.txt header check, the 0600
// copy, contents never returned, clearing deletes the file), `GET/PUT /api/downloads/settings` on the real app, and the
// cookies retry run by the real runner against the fake yt-dlp. No real browser cookies are ever read: "browser" mode
// is checked only as the arguments it builds.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/server/db";
import { buildDownloadArgs, buildSizingArgs } from "../src/server/downloads/args";
import {
  COOKIES_FILE, cookiesFor, getSettings, isNetscapeCookies, NOT_NETSCAPE, noteCookies, putSettings, readAuth, SettingsError,
} from "../src/server/downloads/instagramAuth";
import { DownloadQueue, type ItemRow } from "../src/server/downloads/queue";
import { getSetting } from "../src/server/downloads/toolsInstall";
import { sleep } from "../src/server/proc";
import { jsonInit } from "./helpers/http";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const FAKE = join(import.meta.dir, "fixtures", "fake-yt-dlp.ts");
const base = mkdtempSync(join(tmpdir(), "tuva-igcookies-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const SECRET = "sessionid\tS3CR3T-COOKIE-VALUE";
const cookiesTxt = (header = "# Netscape HTTP Cookie File") => `${header}\n# This is a generated file!\n.instagram.com\tTRUE\t/\tTRUE\t2000000000\t${SECRET}\n`;
let n = 0;
function fixture(text: string, mode = 0o644) {
  const p = join(base, `src-${++n}.txt`);
  writeFileSync(p, text);
  chmodSync(p, mode);
  return p;
}
function fresh() {
  const dataDir = join(base, `data-${++n}`);
  mkdirSync(dataDir);
  return { db: openDb(":memory:", MIGRATIONS), dataDir };
}

describe("the cookies.txt header check (§5.2)", () => {
  test("both Netscape headers pass; anything else is refused", () => {
    expect(isNetscapeCookies("# Netscape HTTP Cookie File\n.x\tTRUE")).toBe(true);
    expect(isNetscapeCookies("# HTTP Cookie File\r\n")).toBe(true);
    expect(isNetscapeCookies("﻿# Netscape HTTP Cookie File\n")).toBe(true);
    expect(isNetscapeCookies("")).toBe(false);
    expect(isNetscapeCookies('[{"name":"sessionid"}]')).toBe(false);
    expect(isNetscapeCookies(".instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tx\n# Netscape HTTP Cookie File")).toBe(false);
    expect(isNetscapeCookies("# Netscape HTTP Cookie File and more")).toBe(false);
  });
});

describe("settings (§5.2–5.3)", () => {
  test("default: signed out, notice not acknowledged, the browser list", () => {
    const { db } = fresh();
    expect(getSettings(db)).toMatchObject({ instagramAuth: { kind: "none" }, noticeAckAt: null, browsers: expect.arrayContaining(["firefox", "safari", "chrome"]) });
  });

  test("cookies cannot be set before the notice is acknowledged; the ack can come in the same request and is kept once", () => {
    const { db, dataDir } = fresh();
    expect(() => putSettings(db, dataDir, { instagramAuth: { kind: "browser", browser: "firefox" } })).toThrow(SettingsError);
    expect(() => putSettings(db, dataDir, { instagramAuth: { kind: "file", path: fixture(cookiesTxt()) } })).toThrow(/notice/);
    expect(readAuth(db)).toEqual({ kind: "none" });
    expect(existsSync(join(dataDir, COOKIES_FILE))).toBe(false);
    const t1 = new Date("2026-11-08T10:00:00Z");
    const s = putSettings(db, dataDir, { noticeAck: true, instagramAuth: { kind: "browser", browser: "firefox" } }, () => t1);
    expect(s).toMatchObject({ instagramAuth: { kind: "browser", browser: "firefox" }, noticeAckAt: t1.toISOString() });
    putSettings(db, dataDir, { noticeAck: true }, () => new Date("2026-12-01T00:00:00Z"));
    expect(getSetting(db, "instagram_notice_ack_at")).toBe(t1.toISOString());
    // signing out never needs the notice
    const { db: db2, dataDir: d2 } = fresh();
    expect(putSettings(db2, d2, { instagramAuth: { kind: "none" } }).instagramAuth).toEqual({ kind: "none" });
  });

  test("bad bodies are refused and change nothing", () => {
    const { db, dataDir } = fresh();
    putSettings(db, dataDir, { noticeAck: true });
    for (const b of [{ noticeAck: false }, { instagramAuth: "file" }, { instagramAuth: { kind: "cookies" } }, { instagramAuth: { kind: "browser", browser: "netscape" } }, { instagramAuth: { kind: "browser" } }, { instagramAuth: { kind: "file" } }, { instagramAuth: { kind: "file", path: "relative.txt" } }, { instagramAuth: { kind: "file", path: join(base, "missing.txt") } }])
      expect(() => putSettings(db, dataDir, b as Record<string, unknown>)).toThrow(SettingsError);
    expect(readAuth(db)).toEqual({ kind: "none" });
  });

  test("a file that is not a Netscape cookies.txt is refused with the spec's words; nothing is copied", () => {
    const { db, dataDir } = fresh();
    for (const text of ['[{"name":"sessionid","value":"x"}]', cookiesTxt("# Cookies"), ""]) {
      expect(() => putSettings(db, dataDir, { noticeAck: true, instagramAuth: { kind: "file", path: fixture(text) } })).toThrow(NOT_NETSCAPE);
    }
    expect(existsSync(join(dataDir, COOKIES_FILE))).toBe(false);
    expect(readAuth(db)).toEqual({ kind: "none" });
  });

  test("a cookies.txt is copied to <dataDir>/instagram-cookies.txt at 0600; the original path and contents are never returned", () => {
    const { db, dataDir } = fresh();
    const src = fixture(cookiesTxt("# HTTP Cookie File"), 0o644);
    const s = putSettings(db, dataDir, { noticeAck: true, instagramAuth: { kind: "file", path: src } });
    const dest = join(dataDir, COOKIES_FILE);
    expect(readFileSync(dest, "utf8")).toBe(readFileSync(src, "utf8"));
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(s.instagramAuth).toEqual({ kind: "file" });
    for (const out of [JSON.stringify(s), JSON.stringify(getSettings(db)), getSetting(db, "instagram_auth")!]) {
      expect(out).not.toContain("S3CR3T");
      expect(out).not.toContain(src);
      expect(out).not.toContain(dest);
    }
    // a replacement over an existing (wider) file ends at 0600 too
    chmodSync(dest, 0o644);
    putSettings(db, dataDir, { instagramAuth: { kind: "file", path: fixture(cookiesTxt()) } });
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(cookiesFor(db, dataDir)).toEqual({ file: dest });
  });

  test("clearing deletes the copied file, and so does switching to a browser", () => {
    const { db, dataDir } = fresh();
    const dest = join(dataDir, COOKIES_FILE);
    putSettings(db, dataDir, { noticeAck: true, instagramAuth: { kind: "file", path: fixture(cookiesTxt()) } });
    expect(existsSync(dest)).toBe(true);
    putSettings(db, dataDir, { instagramAuth: { kind: "none" } });
    expect(existsSync(dest)).toBe(false);
    expect(cookiesFor(db, dataDir)).toBeNull();
    putSettings(db, dataDir, { instagramAuth: { kind: "file", path: fixture(cookiesTxt()) } });
    putSettings(db, dataDir, { instagramAuth: { kind: "browser", browser: "safari" } });
    expect(existsSync(dest)).toBe(false);
    expect(cookiesFor(db, dataDir)).toEqual({ browser: "safari" });
  });

  test("lastWorkedAt and expired: success notes the date and clears expired; expired cookies are not used; a new setting starts clean", () => {
    const { db, dataDir } = fresh();
    putSettings(db, dataDir, { noticeAck: true, instagramAuth: { kind: "browser", browser: "firefox" } });
    noteCookies(db, "worked", () => new Date("2026-11-08T12:00:00Z"));
    expect(readAuth(db)).toEqual({ kind: "browser", browser: "firefox", lastWorkedAt: "2026-11-08T12:00:00.000Z" });
    noteCookies(db, "expired");
    expect(readAuth(db)).toMatchObject({ kind: "browser", expired: true, lastWorkedAt: "2026-11-08T12:00:00.000Z" });
    expect(cookiesFor(db, dataDir)).toBeNull();
    putSettings(db, dataDir, { instagramAuth: { kind: "browser", browser: "firefox" } });
    expect(readAuth(db)).toEqual({ kind: "browser", browser: "firefox" });
    // signed out: nothing to note
    putSettings(db, dataDir, { instagramAuth: { kind: "none" } });
    noteCookies(db, "worked");
    expect(readAuth(db)).toEqual({ kind: "none" });
  });

  test("browser mode is only arguments: --cookies-from-browser <name> before the URL, in both passes", () => {
    const spec = { url: "https://www.instagram.com/p/C1abc/", source: "instagram" as const, quality: "1080p" as const, ffmpegLocation: "/ff", cookies: { browser: "chrome" } };
    for (const a of [buildSizingArgs(spec), buildDownloadArgs(spec)]) {
      const i = a.indexOf("--cookies-from-browser");
      expect(a[i + 1]).toBe("chrome");
      expect(a.at(-1)).toBe(spec.url);
      expect(a).not.toContain("--cookies");
    }
  });
});

// ---- the cookies retry with the real runner and the fake yt-dlp (§5.4) -------------------------------------------

const WALL = "ERROR: [Instagram] IG: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in. If it is, then use --cookies-from-browser or --cookies for the authentication.";
const EXPIRED = "WARNING: [Instagram] The provided account cookies are no longer valid. Use --cookies-from-browser or --cookies for the authentication";
const SIZING = { duration: 1, requested_formats: [{ filesize: 100, vcodec: "avc1.64001f" }, { filesize: 50, vcodec: "none" }] };

describe("the cookies retry with the fake yt-dlp", () => {
  const dir = join(base, "retry");
  const dataDir = join(dir, "data");
  const dest = join(dir, "dest");
  const clip = join(dir, "clip.bin");
  const scenario = join(dir, "scenario.json");
  const argvFile = join(dir, "argv.json");
  const db = openDb(":memory:", MIGRATIONS);
  let offset = 0;
  const q = new DownloadQueue({
    db,
    dataDir,
    tools: async () => ({ ytDlpPath: FAKE, ffmpegLocation: "/fake/ffmpeg", jsRuntime: null, env: { FAKE_YTDLP_SCENARIO: scenario, FAKE_YTDLP_CLIP: clip, FAKE_YTDLP_ARGV_FILE: argvFile } }),
    probe: async () => true,
    rootFor: () => null, // outside every Root: the item ends done_outside, no scan
    rootAvailable: () => true,
    defaultRoot: () => null,
    scanFile: async () => ({ ok: true }),
    hasCopy: () => false,
    instagramCookies: () => cookiesFor(db, dataDir),
    onInstagramCookies: (o) => noteCookies(db, o),
    // the Instagram pause (§5.4) is skipped by moving the clock between jobs
    now: () => Date.now() + offset,
  });
  let v = 0;
  const igVideo = (sid: string) => {
    const id = `ig-${++v}`;
    db.prepare("INSERT INTO videos (id, content_hash, instagram_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', 'x')").run(id, `h${id}`, sid, `Reel ${sid}`);
    return id;
  };
  const runJob = async (ids: string[]) => {
    offset += 60_000;
    q.addBulk({ option: "random", quality: "1080p", destDir: dest, videoIds: ids });
    await sleep(20);
    await q.settled();
  };
  const item = (videoId: string) => db.query("SELECT * FROM download_item WHERE video_id = ? ORDER BY id DESC").get(videoId) as ItemRow;
  const lastArgv = () => JSON.parse(readFileSync(argvFile, "utf8")) as string[];

  beforeAll(() => {
    mkdirSync(dest, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(clip, "not really a video");
    putSettings(db, dataDir, { noticeAck: true, instagramAuth: { kind: "file", path: fixture(cookiesTxt()) } });
  });

  test("a login wall triggers one retry with the cookies.txt; success sets lastWorkedAt", async () => {
    writeFileSync(scenario, JSON.stringify({ sizing: SIZING, exit: 1, steps: [{ err: WALL }], withCookies: { exit: 0, steps: [{ out: "TUVAFILE @FILE" }], file: "Reel [instagram-IGok1].mp4" } }));
    const id = igVideo("IGok1");
    await runJob([id]);
    expect(item(id)).toMatchObject({ state: "done_outside", reason: null });
    expect(existsSync(join(dest, "Reel [instagram-IGok1].mp4"))).toBe(true);
    const argv = lastArgv();
    expect(argv[argv.indexOf("--cookies") + 1]).toBe(join(dataDir, COOKIES_FILE));
    const log = readFileSync(item(id).log_path, "utf8");
    expect(log).toContain("trying once more with cookies (cookies.txt)");
    expect(log).not.toContain("S3CR3T");
    expect(readAuth(db)).toMatchObject({ kind: "file", lastWorkedAt: expect.any(String) });
    expect(readAuth(db)).not.toHaveProperty("expired");
  });

  test("a second login wall fails the item as login wall; the cookies were tried once", async () => {
    writeFileSync(scenario, JSON.stringify({ sizing: SIZING, exit: 1, steps: [{ err: WALL }] }));
    const id = igVideo("IGwall2");
    await runJob([id]);
    expect(item(id)).toMatchObject({ state: "failed", reason: "login_wall" });
    expect(lastArgv()).toContain("--cookies");
    expect(readFileSync(item(id).log_path, "utf8").match(/trying once more with cookies/g)).toHaveLength(1);
    expect(readAuth(db)).not.toHaveProperty("expired");
  });

  test("cookies_expired on the retry fails the item as cookies expired and sets expired; the next login wall is not retried", async () => {
    writeFileSync(scenario, JSON.stringify({ sizing: SIZING, exit: 1, steps: [{ err: WALL }], withCookies: { steps: [{ err: EXPIRED }, { err: WALL }] } }));
    const id = igVideo("IGexp3");
    await runJob([id]);
    expect(item(id)).toMatchObject({ state: "failed", reason: "cookies_expired" });
    expect(readAuth(db)).toMatchObject({ kind: "file", expired: true });
    expect(cookiesFor(db, dataDir)).toBeNull();
    // expired cookies are not used: the next wall is the signed-out path (that item, and needs sign-in for the rest)
    const a = igVideo("IGafter4");
    const b = igVideo("IGafter5");
    await runJob([a, b]);
    expect(item(a)).toMatchObject({ state: "failed", reason: "login_wall" });
    expect(item(b)).toMatchObject({ state: "failed", reason: "needs_signin" });
    expect(lastArgv()).not.toContain("--cookies");
  });
});

// ---- the HTTP endpoints on the real app (§6) ----------------------------------------------------------------------

describe("GET/PUT /api/downloads/settings", () => {
  const dataDir = join(base, "app-data");
  const rootDir = join(base, "app-root");
  let app: App;
  let url: string;
  const api = async (path: string, init?: RequestInit) => {
    const r = await fetch(url + path, jsonInit(init));
    const text = await r.text();
    return { status: r.status, text, json: JSON.parse(text) };
  };
  const put = (body: unknown, headers: Record<string, string> = {}) => api("/api/downloads/settings", { method: "PUT", body: JSON.stringify(body), headers });

  beforeAll(async () => {
    mkdirSync(rootDir, { recursive: true });
    app = await startApp(loadConfig({ TUVA_DATA_DIR: dataDir, TUVA_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: rootDir }));
    url = `http://localhost:${app.server.port}`;
  }, 60_000);
  afterAll(async () => void (await app?.stop()));

  test("round trip: notice first, a refused file, a copied file whose contents never come back, then clearing", async () => {
    expect((await api("/api/downloads/settings")).json).toMatchObject({ instagramAuth: { kind: "none" }, noticeAckAt: null });
    const src = fixture(cookiesTxt());
    expect(await put({ instagramAuth: { kind: "file", path: src } })).toMatchObject({ status: 400, json: { error: expect.stringMatching(/notice/) } });
    expect(await put({ noticeAck: true, instagramAuth: { kind: "file", path: fixture("{}") } })).toMatchObject({ status: 400, json: { error: NOT_NETSCAPE } });
    // the refused request changed nothing, its ack included
    expect((await api("/api/downloads/settings")).json.noticeAckAt).toBeNull();
    const ok = await put({ noticeAck: true, instagramAuth: { kind: "file", path: src } });
    expect(ok).toMatchObject({ status: 200, json: { instagramAuth: { kind: "file" }, noticeAckAt: expect.any(String) } });
    const got = await api("/api/downloads/settings");
    for (const t of [ok.text, got.text]) {
      expect(t).not.toContain("S3CR3T");
      expect(t).not.toContain(src);
    }
    expect(statSync(join(dataDir, COOKIES_FILE)).mode & 0o777).toBe(0o600);
    expect((await put({ instagramAuth: { kind: "none" } })).json.instagramAuth).toEqual({ kind: "none" });
    expect(existsSync(join(dataDir, COOKIES_FILE))).toBe(false);
  });

  test("a PUT from another origin is refused", async () => {
    const r = await put({ instagramAuth: { kind: "none" } }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });
});
