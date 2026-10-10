import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { sleep } from "../src/server/proc";

const base = mkdtempSync(join(tmpdir(), "tuva-it-"));
const dataDir = join(base, "data");
const localDir = join(base, "local");
const extDir = join(base, "ext");
mkdirSync(localDir, { recursive: true });
mkdirSync(extDir, { recursive: true });

async function ff(...args: string[]) {
  const p = Bun.spawn(["/usr/local/bin/ffmpeg", "-v", "error", "-y", ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) throw new Error(await new Response(p.stderr).text());
}

let app: App;
let base_url: string;

beforeAll(async () => {
  const src = ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6", "-f", "lavfi", "-i", "sine=duration=6"];
  await ff(...src, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(localDir, "Song One [aaaaaaaaaaa].mp4"));
  // same id on the external Root: a second Copy of the same Video
  await ff(...src, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(extDir, "Song One [aaaaaaaaaaa].mp4"));
  // id-less file -> SHA-256 identity; E-AC3 audio -> transcode
  await ff(...src, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "eac3", join(localDir, "No Id Concert.mkv"));
  writeFileSync(join(localDir, "Song One [aaaaaaaaaaa].f251.webm"), "partial");
  writeFileSync(join(localDir, "._Song One [aaaaaaaaaaa].mp4"), "appledouble");
  writeFileSync(join(localDir, "notes.txt"), "x");

  const cfg = loadConfig({
    TUVA_DATA_DIR: dataDir, TUVA_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: localDir, TUVA_EXTERNAL_ROOT: extDir,
  });
  app = await startApp(cfg);
  base_url = `http://localhost:${app.server.port}`;
  await app.scanner.whenIdle();
}, 60_000);

afterAll(async () => {
  await app.stop();
  rmSync(base, { recursive: true, force: true });
});

const api = async (path: string, init?: RequestInit) => (await fetch(base_url + path, init)).json() as Promise<any>;

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error("timed out");
}

describe("scan and API", () => {
  test("identity, skip rules, Copies", async () => {
    const videos = await api("/api/videos");
    expect(videos.length).toBe(2);
    const song = videos.find((v: any) => v.youtubeId === "aaaaaaaaaaa");
    expect(song.title).toBe("Song One");
    expect(song.copies.length).toBe(2);
    expect(song.copies[0].rootKind).toBe("local"); // ranked, local first
    expect(song.copies[0]).toMatchObject({ container: "mp4", videoCodec: "h264", audioCodec: "aac", width: 320, height: 240, playback: "native" });
    expect(song.copies[0].rFrameRate).toBe("25/1");
    expect(song.available).toBe(true);
    const noId = videos.find((v: any) => v.youtubeId === null);
    expect(noId.title).toBe("No Id Concert");
    expect(noId.copies[0].playback).toBe("transcode");
    const db = app.db.query("SELECT content_hash FROM video WHERE youtube_id IS NULL").get() as { content_hash: string };
    expect(db.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("migrations ran and the search table holds Video titles", () => {
    expect((app.db.query("PRAGMA user_version").get() as any).user_version).toBeGreaterThanOrEqual(2);
    const n = (app.db.query("SELECT COUNT(*) n FROM search WHERE kind = 'video'").get() as any).n;
    expect(n).toBe(2);
    expect(app.db.query("SELECT ref_id FROM search WHERE search MATCH 'concert'").all().length).toBe(1);
  });

  test("scan progress and roots endpoints", async () => {
    const scan = await api("/api/scan");
    expect(scan.running).toBe(false);
    expect(scan.last.length).toBe(2);
    const roots = await api("/api/roots");
    expect(roots.map((r: any) => r.kind)).toEqual(["local", "external"]);
    expect(roots.every((r: any) => r.available)).toBe(true);
  });
});

describe("streaming", () => {
  test("Range requests give 206 with Content-Range", async () => {
    const [song] = (await api("/api/videos")).filter((v: any) => v.youtubeId === "aaaaaaaaaaa");
    const url = base_url + song.copies[0].url;
    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-type")).toBe("video/mp4");
    const size = Number(full.headers.get("content-length"));
    await full.arrayBuffer();
    const part = await fetch(url, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    const tail = await fetch(url, { headers: { range: "bytes=-50" } });
    expect(tail.status).toBe(206);
    expect((await tail.arrayBuffer()).byteLength).toBe(50);
    expect((await fetch(url, { headers: { range: `bytes=${size}-` } })).status).toBe(416);
  });
});

describe("fallback queue", () => {
  test("transcode Copy gets its Fallback at scan time and is served from it", async () => {
    const getCopy = async () => (await api("/api/videos")).find((v: any) => v.youtubeId === null).copies[0];
    await waitFor(async () => (await getCopy()).fallback.state === "ready");
    const c = await getCopy();
    const res = await fetch(base_url + c.url, { headers: { range: "bytes=0-9" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("video/x-matroska");
    await res.arrayBuffer();
    const probe = Bun.spawnSync(["/usr/local/bin/ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", join(dataDir, "remux", c.id + ".mkv")]);
    expect(probe.stdout.toString()).toContain("aac");
  });
});

describe("thumbnails", () => {
  test("poster and strip are generated with geometry", async () => {
    await waitFor(async () => (await api("/api/videos")).every((v: any) => v.thumbnail));
    const [v] = await api("/api/videos");
    expect(v.thumbnail.strip).toMatchObject({ frames: 6, columns: 6, rows: 1, frameWidth: 160 });
    const poster = await fetch(base_url + v.thumbnail.poster);
    expect(poster.status).toBe(200);
    expect(poster.headers.get("content-type")).toBe("image/webp");
    expect((await fetch(base_url + v.thumbnail.strip.url)).status).toBe(200);
  }, 60_000);
});

describe("Missing and unmounted Roots", () => {
  const extCopy = () => app.db.query("SELECT missing_since FROM copy WHERE root_id = 2").get() as { missing_since: string | null };

  test("a file gone from a mounted Root is Missing, and revives", async () => {
    const f = join(extDir, "Song One [aaaaaaaaaaa].mp4");
    renameSync(f, f + ".away");
    await app.scanner.requestAll();
    await app.scanner.whenIdle();
    expect(extCopy().missing_since).not.toBeNull();
    const vids = await api("/api/videos");
    expect(vids.find((v: any) => v.youtubeId === "aaaaaaaaaaa").copies.find((c: any) => c.rootKind === "external").missing).toBe(true);
    renameSync(f + ".away", f);
    await app.scanner.requestAll();
    await app.scanner.whenIdle();
    expect(extCopy().missing_since).toBeNull();
  });

  test("an unmounted Root changes nothing", async () => {
    renameSync(extDir, extDir + ".unmounted");
    try {
      await app.scanner.requestAll();
      await app.scanner.whenIdle();
      expect(extCopy().missing_since).toBeNull();
      const roots = await api("/api/roots");
      expect(roots.find((r: any) => r.kind === "external").available).toBe(false);
      const v = (await api("/api/videos")).find((x: any) => x.youtubeId === "aaaaaaaaaaa");
      expect(v.available).toBe(true); // the local Copy still plays
    } finally {
      renameSync(extDir + ".unmounted", extDir);
    }
  });

  test("a rescan never overwrites an edited title", async () => {
    app.db.exec("UPDATE video SET title = 'Edited' WHERE youtube_id = 'aaaaaaaaaaa'");
    await app.scanner.requestAll();
    await app.scanner.whenIdle();
    expect((app.db.query("SELECT title FROM video WHERE youtube_id = 'aaaaaaaaaaa'").get() as any).title).toBe("Edited");
  });
});
