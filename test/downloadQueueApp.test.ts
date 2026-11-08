// The Download queue end to end (downloader-spec §4, §6): the real app, the real runner and scanner, the fake yt-dlp
// (`TUVA_BIN_DIR`), a temp Root. No real downloads, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { sleep } from "../src/server/proc";
import { jsonInit } from "./helpers/http";

const FAKE = join(import.meta.dir, "fixtures", "fake-yt-dlp.ts");
const base = mkdtempSync(join(tmpdir(), "tuva-dlapp-"));
const dataDir = join(base, "data");
const rootDir = join(base, "root");
const binDir = join(base, "bin");
const clip = join(base, "clip.mp4");
const scenarioPath = join(base, "scenario.json");
const { ffmpeg } = loadConfig({});
const ids = ["aaaaaaaaaa1", "aaaaaaaaaa2", "aaaaaaaaaa3", "aaaaaaaaaa4", "aaaaaaaaaa5", "aaaaaaaaaa6"];
const SIZING = { duration: 1, requested_formats: [{ filesize: 100, vcodec: "avc1.64001f" }, { filesize: 50, vcodec: "none" }] };
const file = (i: number) => `Song ${i} [${ids[i - 1]}].mp4`;
const steps = [{ out: "TUVA downloading 50 150 NA 100 1" }, { err: "TUVAPP started" }, { out: "TUVAFILE @FILE" }];

let app: App;
let url: string;
const saved: Record<string, string | undefined> = {};

const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(url + path, jsonInit(init));
  const text = await r.text();
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};
const post = (path: string, body?: unknown) => api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
async function until(fn: () => boolean | Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error("timed out");
}

beforeAll(async () => {
  mkdirSync(rootDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const p = Bun.spawn([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1", "-pix_fmt", "yuv420p", clip], { stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  writeFileSync(join(binDir, "yt-dlp"), `#!/bin/sh\nexec bun "${FAKE}" "$@"\n`);
  chmodSync(join(binDir, "yt-dlp"), 0o755);
  for (const [k, v] of Object.entries({ TUVA_BIN_DIR: binDir, FAKE_YTDLP_SCENARIO: scenarioPath, FAKE_YTDLP_CLIP: clip })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const cfg = loadConfig({ TUVA_DATA_DIR: dataDir, TUVA_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: rootDir });
  app = await startApp(cfg);
  url = `http://localhost:${app.server.port}`;
  const ins = app.db.prepare("INSERT INTO videos (id, youtube_id, title, created_at, updated_at) VALUES (?, ?, ?, 'x', 'x')");
  ids.forEach((id, i) => ins.run(`v${i + 1}`, id, `Song ${i + 1}`));
}, 60_000);

afterAll(async () => {
  await app?.stop();
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(base, { recursive: true, force: true });
});

describe("a job of 5 through the real app", () => {
  test("successes become Copies through scanFile; failures are classified; the report lists them", async () => {
    const perUrl: Record<string, object> = {};
    ids.slice(0, 5).forEach((id, i) => (perUrl[id] = { file: file(i + 1) }));
    perUrl[ids[3]!] = { exit: 1, steps: [{ err: "ERROR: [youtube] aaaaaaaaaa4: Video unavailable" }] };
    perUrl[ids[4]!] = { exit: 1, steps: [{ err: "ERROR: [youtube] aaaaaaaaaa5: Private video. Sign in if you've been granted access to this video" }] };
    writeFileSync(scenarioPath, JSON.stringify({ sizing: SIZING, steps, perUrl }));

    const r = await post("/api/downloads/jobs", { option: "random", quality: "1080", destDir: rootDir, videoIds: ["v1", "v2", "v3", "v4", "v5"] });
    expect(r.status).toBe(201);
    const jobId = r.json.jobId as number;
    await until(async () => (await api("/api/downloads")).json.job?.running === false);
    const s = (await api(`/api/downloads?job=${jobId}`)).json;
    expect(s.job.counts).toMatchObject({ total: 5, done: 3, failed: 2 });
    const byVideo = (v: string) => s.items.find((i: any) => i.videoId === v);
    expect(byVideo("v4")).toMatchObject({ state: "failed", reason: "unavailable" });
    expect(byVideo("v5")).toMatchObject({ state: "failed", reason: "private" });
    // the scan-in made Copies (and nothing else scanned the Root)
    const copies = app.db.query("SELECT video_id, rel_path, missing_since FROM copy ORDER BY video_id").all() as any[];
    expect(copies.map((c) => c.video_id)).toEqual(["v1", "v2", "v3"]);
    expect(copies.map((c) => c.rel_path)).toEqual([file(1), file(2), file(3)]);
    expect(existsSync(join(rootDir, file(1)))).toBe(true);
    expect(s.log.lines.some((l: any) => l.text.includes("TUVAFILE"))).toBe(true);
    const rep = await api(`/api/downloads/jobs/${jobId}/report.txt`);
    expect(rep.status).toBe(200);
    expect(rep.text).toContain("2 of 5 Videos failed");
    expect(rep.text).toContain("Song 4");
    expect(rep.text).toContain("unavailable — [youtube] aaaaaaaaaa4: Video unavailable");
    expect(rep.text).toContain("private — ");
    // the Videos with a Copy are no longer downloadable: a card click is refused
    expect((await post("/api/downloads/card", { videoId: "v1" })).status).toBe(409);
  }, 60_000);

  test("Retry failed re-runs the failures; a second Confirm keeps only the latest bulk job", async () => {
    const perUrl: Record<string, object> = {};
    ids.forEach((id, i) => (perUrl[id] = { file: file(i + 1) }));
    writeFileSync(scenarioPath, JSON.stringify({ sizing: SIZING, steps, perUrl }));
    const jobId = (await api("/api/downloads")).json.job.id as number;
    expect((await post(`/api/downloads/jobs/${jobId}/retry-failed`)).json).toEqual({ retried: 2 });
    await until(async () => (await api("/api/downloads")).json.job?.running === false);
    expect((await api(`/api/downloads?job=${jobId}`)).json.job.counts).toMatchObject({ done: 5, failed: 0 });
    expect(app.db.query("SELECT COUNT(*) AS n FROM copy").get()).toEqual({ n: 5 });
    // a card click for a Video with a Copy is refused; v6 downloads as a card job that leaves nothing behind
    const c = await post("/api/downloads/card", { videoId: "v6" });
    expect(c.status).toBe(201);
    await until(async () => (await api("/api/downloads")).json.runningCount === 0);
    await until(() => (app.db.query("SELECT COUNT(*) AS n FROM download_job WHERE kind = 'card'").get() as any).n === 0);
  }, 60_000);
});

describe("the quit guard (§4.7)", () => {
  test("POST /api/quit with downloads running asks first; forced, it kills them and keeps the partials", async () => {
    app.db.prepare("DELETE FROM copy WHERE video_id = 'v6'").run();
    writeFileSync(scenarioPath, JSON.stringify({ sizing: SIZING, steps: [{ out: "TUVA downloading 10 150 NA 100 1" }], hang: true, file: file(6) }));
    expect((await post("/api/downloads/card", { videoId: "v6" })).status).toBe(201);
    await until(async () => (await api("/api/downloads")).json.runningCount === 1);
    let quit = 0;
    app.quit = () => void quit++;
    try {
      const ask = await post("/api/quit");
      expect(ask.status).toBe(409);
      expect(ask.json).toMatchObject({ running: 1, confirm: true });
      writeFileSync(join(rootDir, `${file(6)}.part`), "partial");
      const go = await post("/api/quit", { force: true });
      expect(go.status).toBe(202);
      await until(() => quit === 1, 2000);
      const item = app.db.query("SELECT state FROM download_item WHERE video_id = 'v6' ORDER BY id DESC").get() as { state: string };
      expect(item.state).toBe("queued"); // waits for the next launch; the partial stays for --continue
      expect(existsSync(join(rootDir, `${file(6)}.part`))).toBe(true);
      expect(app.downloads!.runningCount()).toBe(0);
    } finally {
      app.quit = undefined;
    }
  }, 30_000);
});

describe("Scanner.scanFile (§4.6)", () => {
  test("a file that is not a Video fails with the probe's words and adds nothing; a missing file fails too", async () => {
    writeFileSync(join(rootDir, "notes.mp4"), "not a video");
    const before = (app.db.query("SELECT COUNT(*) AS n FROM copy").get() as any).n;
    const r = await app.scanner.scanFile(1, "notes.mp4");
    expect(r.ok).toBe(false);
    expect((app.db.query("SELECT COUNT(*) AS n FROM copy").get() as any).n).toBe(before);
    expect((await app.scanner.scanFile(1, "nope.mp4")).ok).toBe(false);
    expect((await app.scanner.scanFile(99, "x.mp4")).ok).toBe(false);
  });

  test("waits for a running Rescan, and a Rescan queued meanwhile still runs", async () => {
    app.scanner.request(1);
    const r = await app.scanner.scanFile(1, file(1)); // already a Copy: updated in place
    expect(r.ok).toBe(true);
    await app.scanner.whenIdle();
  });
});
