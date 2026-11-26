// Download from the Home Server, end to end between two test machines (docs/home-server-spec.md §8, §10): two real
// apps in this process, each with its own TUVA_DATA_DIR and a temp Root of ffmpeg lavfi Copies. The "mini" serves its
// Library Server on a free port; the "laptop" has it as its Home Server. The tailscale CLI is the fixture stub with
// TUVA_TV_LOOPBACK=1, so the laptop's loopback address counts as a Mac of the owner's. Nothing real is touched, no audio is played.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { sleep } from "../src/server/proc";
import { jsonInit } from "./helpers/http";
import { isOnHome } from "../src/shared/presence";

const base = mkdtempSync(join(tmpdir(), "tuva-homedl-app-"));
const FIX = join(import.meta.dir, "fixtures", "tailscale");
const fixtures = join(base, "ts");
const miniRoot = join(base, "mini-root");
const laptopRoot = join(base, "laptop-root");
const { ffmpeg } = loadConfig({});
const saved: Record<string, string | undefined> = {};
let mini: App;
let laptop: App;
let miniTv = 0;
let laptopUrl = "";

const clip = async (path: string, w: number, d: number) => {
  mkdirSync(join(path, ".."), { recursive: true });
  const p = Bun.spawn([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${w}x48:rate=10:duration=${d}`, "-pix_fmt", "yuv420p", path], { stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
};
const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(laptopUrl + path, jsonInit(init));
  const text = await r.text();
  return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};
const post = (path: string, body?: unknown) => api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
async function until<T>(fn: () => T | Promise<T>, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await sleep(50);
  }
  throw new Error("timed out");
}
const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port!;
  void s.stop(true);
  return p;
};
const videos = async () => (await api("/api/videos")).json as any[];

beforeAll(async () => {
  mkdirSync(fixtures, { recursive: true });
  copyFileSync(join(FIX, "status.json"), join(fixtures, "status.json"));
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) copyFileSync(join(FIX, "whois-same.json"), join(fixtures, `whois-${ip}.json`));
  for (const [k, v] of Object.entries({ TUVA_TAILSCALE: join(FIX, "stub.sh"), TUVA_TS_FIXTURES: fixtures })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  await clip(join(miniRoot, "Concerts", "2019", "Opening night.mp4"), 64, 1); // no source id: identified by its bytes
  await clip(join(miniRoot, "Songs", "Throat singing [aaaaaaaaaaa].mp4"), 96, 1); // a YouTube id
  mkdirSync(laptopRoot, { recursive: true });
  miniTv = freePort();
  mini = await startApp(loadConfig({ TUVA_DATA_DIR: join(base, "mini"), TUVA_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: miniRoot, TUVA_TV_PORT: String(miniTv), TUVA_TV_LOOPBACK: "1" }));
  await mini.scanner.requestAll();
  await mini.scanner.whenIdle();
  // the mini's own data for the never-Shared Video: titles, Type, a Chapter and a Local Song pointer
  mini.db.prepare("UPDATE videos SET title = 'Открытие', title_latin = 'Otkrytie', title_latin_source = 'manual', type = 'concert' WHERE content_hash IS NOT NULL").run();
  const vid = (mini.db.query("SELECT id FROM videos WHERE content_hash IS NOT NULL").get() as { id: string }).id;
  mini.db.prepare("INSERT INTO video_chapters (id, video_id, start_s, title, title_latin, suggested, source, updated_at) VALUES ('c0000000-0000-4000-8000-000000000001', ?, 0.5, 'Первая', 'Pervaya', 0, 'manual', 'x')").run(vid);
  const on = await fetch(`http://localhost:${mini.server.port}/api/tv/on`, jsonInit({ method: "POST", body: "{}" }));
  expect(on.status).toBe(200);

  laptop = await startApp(loadConfig({ TUVA_DATA_DIR: join(base, "laptop"), TUVA_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: laptopRoot, TUVA_TV_PORT: String(freePort()), TUVA_TV_LOOPBACK: "1" }));
  laptopUrl = `http://localhost:${laptop.server.port}`;
  await laptop.scanner.requestAll();
  await laptop.scanner.whenIdle();
  expect(laptop.home!.set({ address: `127.0.0.1:${miniTv}` }).ok).toBe(true);
  const st = await laptop.home!.refresh({ force: true });
  expect(st.error).toBeNull();
  expect(st.connected).toBe(true);
}, 90_000);

afterAll(async () => {
  await laptop?.stop();
  await mini?.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});

describe("a Copy downloaded from the Home Server", () => {
  test("the Library Server serves the whole file for ?download=1, with Range", async () => {
    const copyId = (mini.db.query("SELECT id FROM copy WHERE rel_path LIKE 'Concerts/%'").get() as { id: number }).id;
    const size = statSync(join(miniRoot, "Concerts/2019/Opening night.mp4")).size;
    const whole = await fetch(`http://127.0.0.1:${miniTv}/copy/${copyId}?download=1`);
    expect(whole.status).toBe(200);
    expect((await whole.arrayBuffer()).byteLength).toBe(size);
    const part = await fetch(`http://127.0.0.1:${miniTv}/copy/${copyId}?download=1`, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${size}`);
  });

  test("both Videos show On the Home Server first, with the mini's data", async () => {
    const list = await until(async () => {
      const v = await videos();
      return v.filter(isOnHome).length === 2 ? v : null;
    });
    const open = list.find((x) => x.title === "Открытие");
    expect(open).toMatchObject({ homeOnly: true, type: "concert", chapterCount: 1, available: false });
    expect(open.homeCopies[0].size).toBeGreaterThan(0);
  });

  test("a never-Shared Video (identified by its bytes) downloads to the mini's rel_path and takes the mini's data", async () => {
    const before = (await videos()).find((x) => x.title === "Открытие");
    const r = await post("/api/downloads/card", { videoId: before.id, source: "home", destDir: laptopRoot });
    expect(r.status).toBe(201);
    const file = join(laptopRoot, "Concerts", "2019", "Opening night.mp4");
    await until(() => existsSync(file) && (laptop.db.query("SELECT 1 FROM copy WHERE rel_path = 'Concerts/2019/Opening night.mp4'").get() as unknown));
    expect(readFileSync(file).equals(readFileSync(join(miniRoot, "Concerts/2019/Opening night.mp4")))).toBe(true);
    // it is no longer On the Home Server and has an Available local Copy
    const now = await until(async () => {
      const v = (await videos()).filter((x) => x.title === "Открытие");
      return v.length === 1 && v[0].available ? v[0] : null;
    });
    expect(isOnHome(now)).toBe(false); // the Home Server may still hold a twin (it is where Preferred Copy can stream from), but the Video is here
    expect(now.homeOnly).toBeUndefined();
    expect(now).toMatchObject({ title: "Открытие", titleLatin: "Otkrytie", type: "concert", chapterCount: 1 });
    expect((await videos()).filter(isOnHome)).toHaveLength(1); // only the other one is still on the Home Server
    const ch = laptop.db.query("SELECT title, title_latin, song_id FROM video_chapters WHERE video_id = ?").all(now.id);
    expect(ch).toEqual([{ title: "Первая", title_latin: "Pervaya", song_id: null }]);
    expect(laptop.db.query("SELECT song_id, version_id, proposed_song_id FROM videos WHERE id = ?").get(now.id)).toEqual({ song_id: null, version_id: null, proposed_song_id: null });
    // it plays here: the laptop's own /copy answers with the bytes (nothing is played)
    const copy = now.copies[0];
    const res = await fetch(laptopUrl + copy.url, { headers: { range: "bytes=0-99" } });
    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
    // the queue is clean and keeps no temp file
    expect((await api("/api/downloads")).json.videos[before.id]?.state ?? "done").toBe("done");
    expect(existsSync(join(base, "laptop", "downloads", "1", "1.part"))).toBe(false);
  }, 60_000);

  test("a YouTube-identified Video downloads too, and stops being On the Home Server", async () => {
    const before = (await videos()).find((x) => x.youtubeId === "aaaaaaaaaaa");
    expect(isOnHome(before)).toBe(true);
    expect((await post("/api/downloads/card", { videoId: before.id, source: "home", destDir: laptopRoot })).status).toBe(201);
    const now = await until(async () => {
      const v = (await videos()).filter((x) => x.youtubeId === "aaaaaaaaaaa");
      return v.length === 1 && v[0].available ? v[0] : null;
    });
    expect(existsSync(join(laptopRoot, "Songs", "Throat singing [aaaaaaaaaaa].mp4"))).toBe(true);
    expect(now.copies).toHaveLength(1);
    expect((await videos()).filter(isOnHome)).toHaveLength(0);
  }, 60_000);

  test("asking again, or for a destination that is not a Root, is refused", async () => {
    const v = (await videos()).find((x) => x.youtubeId === "aaaaaaaaaaa");
    expect((await post("/api/downloads/card", { videoId: v.id, source: "home", destDir: laptopRoot })).status).toBe(409);
    expect((await post("/api/downloads/card", { videoId: "nobody", source: "home", destDir: join(laptopRoot, "Songs") })).status).toBe(409);
  });
});
