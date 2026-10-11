import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { sleep } from "../src/server/proc";

const base = mkdtempSync(join(tmpdir(), "tuva-it-"));
const dataDir = join(base, "data");
const localDir = join(base, "local");
const extDir = join(base, "ext");
const shotsDir = join(base, "shots");
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
  // piped (non-seekable) webm: no duration, no Cues -> remux, made lazily on first play
  const p = Bun.spawn(["/usr/local/bin/ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=4", "-c:v", "libvpx-vp9", "-f", "webm", "pipe:1"], { stdout: Bun.file(join(localDir, "Live [bbbbbbbbbbb].webm")), stderr: "ignore" });
  await p.exited;
  writeFileSync(join(localDir, "Song One [aaaaaaaaaaa].f251.webm"), "partial");
  writeFileSync(join(localDir, "._Song One [aaaaaaaaaaa].mp4"), "appledouble");
  writeFileSync(join(localDir, "notes.txt"), "x");

  const cfg = loadConfig({
    TUVA_DATA_DIR: dataDir, TUVA_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: localDir, TUVA_EXTERNAL_ROOT: extDir, TUVA_SCREENSHOT_DIR: shotsDir,
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
    expect(videos.length).toBe(3);
    const song = videos.find((v: any) => v.youtubeId === "aaaaaaaaaaa");
    expect(song.title).toBe("Song One");
    expect(song.copies.length).toBe(2);
    expect(song.copies[0].rootKind).toBe("local"); // ranked, local first
    expect(song.copies[0]).toMatchObject({ container: "mp4", videoCodec: "h264", audioCodec: "aac", width: 320, height: 240, playback: "native" });
    expect(song.copies[0].rFrameRate).toBe("25/1");
    expect(song.available).toBe(true);
    const noId = videos.find((v: any) => v.youtubeId === null);
    const live = videos.find((v: any) => v.youtubeId === "bbbbbbbbbbb");
    expect(live.copies[0].playback).toBe("remux");
    expect(live.copies[0].fallback.state).toBe("none"); // lazy: not made until played
    expect(noId.title).toBe("No Id Concert");
    expect(noId.copies[0].playback).toBe("transcode");
    const db = app.db.query("SELECT content_hash FROM video WHERE youtube_id IS NULL").get() as { content_hash: string };
    expect(db.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("migrations ran and the search table holds Video titles", () => {
    expect((app.db.query("PRAGMA user_version").get() as any).user_version).toBeGreaterThanOrEqual(2);
    const n = (app.db.query("SELECT COUNT(*) n FROM search WHERE kind = 'video'").get() as any).n;
    expect(n).toBe(3);
    expect(app.db.query("SELECT ref_id FROM search WHERE search MATCH 'concert'").all().length).toBe(1);
  });

  test("POST /api/quit is refused when no launcher wired a quit hook", async () => {
    const r = await fetch(base_url + "/api/quit", { method: "POST" });
    expect(r.status).toBe(409);
    // and still answers: the server did not stop
    expect((await api("/api/health")).ok).toBe(true);
  });

  test("POST /api/quit calls the launcher's quit hook after replying", async () => {
    let calls = 0;
    app.quit = () => void calls++;
    try {
      const r = await fetch(base_url + "/api/quit", { method: "POST" });
      expect(r.status).toBe(202);
      expect(await r.json()).toEqual({ quitting: true });
      expect(calls).toBe(0);
      await waitFor(() => calls === 1, 2000);
    } finally {
      app.quit = undefined;
    }
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

describe("lazy remux", () => {
  test("first play triggers the job, answers preparing, then serves the Fallback", async () => {
    const live = (await api("/api/videos")).find((v: any) => v.youtubeId === "bbbbbbbbbbb");
    const url = base_url + live.copies[0].url;
    const first = await fetch(url);
    expect(first.status).toBe(503);
    const body: any = await first.json();
    expect(["queued", "preparing", "ready"]).toContain(body.state);
    await waitFor(async () => (await fetch(base_url + "/api/copies/" + live.copies[0].id).then((r) => r.json()) as any).fallback.state === "ready");
    const res = await fetch(url, { headers: { range: "bytes=0-99" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("video/webm");
    await res.arrayBuffer();
    const probe = Bun.spawnSync(["/usr/local/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(dataDir, "remux", live.copies[0].id + ".webm")]);
    expect(parseFloat(probe.stdout.toString())).toBeGreaterThan(3);
  });
});

describe("thumbnails", () => {
  test("poster and strip are generated with geometry", async () => {
    await waitFor(async () => (await api("/api/videos")).every((v: any) => v.thumbnail));
    const v = (await api("/api/videos")).find((x: any) => x.youtubeId === "aaaaaaaaaaa");
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

  test("a Copy recorded with a decomposed (NFD) path matches its NFC-listed file instead of duplicating", async () => {
    // The old exFAT drive listed "Khöömei" decomposed; the same files on APFS list precomposed.
    const nfc = "Khöömei Batch 9/Song Nine [ccccccccccc].mp4".normalize("NFC");
    mkdirSync(join(extDir, "Khöömei Batch 9".normalize("NFC")), { recursive: true });
    await ff("-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(extDir, nfc));
    await app.scanner.requestAll();
    await app.scanner.whenIdle();
    const row = app.db.query("SELECT id, size, mtime FROM copy WHERE root_id = 2 AND rel_path = ?").get(nfc) as { id: number; size: number; mtime: string };
    expect(row).toBeTruthy();
    app.db.query("UPDATE copy SET rel_path = ? WHERE id = ?").run(nfc.normalize("NFD"), row.id);
    await app.scanner.requestAll();
    await app.scanner.whenIdle();
    const rows = app.db.query("SELECT id, rel_path, missing_since FROM copy WHERE root_id = 2 AND video_id = (SELECT id FROM video WHERE youtube_id = 'ccccccccccc')").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(row.id);
    expect(rows[0].rel_path).toBe(nfc);
    expect(rows[0].missing_since).toBeNull();
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

describe("resume endpoint", () => {
  const post = (id: number, body: unknown, raw = false) =>
    fetch(`${base_url}/api/videos/${id}/resume`, { method: "POST", headers: { "content-type": raw ? "text/plain" : "application/json" }, body: JSON.stringify(body) });
  const row = (id: number) => app.db.query("SELECT resume_s, last_played_at FROM video WHERE id = ?").get(id) as { resume_s: number | null; last_played_at: string | null };
  const songId = () => (app.db.query("SELECT id FROM video WHERE youtube_id = 'aaaaaaaaaaa'").get() as { id: number }).id;

  test("stores resume_s and last_played_at and the API reports them", async () => {
    const id = songId();
    expect(row(id).last_played_at).toBeNull();
    app.db.exec(`UPDATE copy SET duration_s = 600 WHERE video_id = ${id}`); // the 6 s fixture would count as finished at once
    const r = await post(id, { resumeS: 2.5 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id, resumeS: 2.5, finished: false });
    expect(row(id).resume_s).toBe(2.5);
    expect(Date.now() - Date.parse(row(id).last_played_at!)).toBeLessThan(10_000);
    const v = await api(`/api/videos/${id}`);
    expect(v.resumeS).toBe(2.5);
    expect(v.lastPlayedAt).not.toBeNull();
  });

  test("a position within 30 s of the end is stored as finished (this fixture is 6 s long: always)", async () => {
    const id = songId();
    app.db.exec(`UPDATE copy SET duration_s = 6 WHERE video_id = ${id}`);
    const r = await (await post(id, { resumeS: 5.9 })).json();
    expect(r).toMatchObject({ resumeS: 0, finished: true });
    expect(row(id).resume_s).toBe(0);
  });

  test("the 30 s rule on a long Video, with the Copy's own duration", async () => {
    const id = songId();
    app.db.exec(`UPDATE copy SET duration_s = 600 WHERE video_id = ${id}`);
    try {
      expect(await (await post(id, { resumeS: 569 })).json()).toMatchObject({ resumeS: 569, finished: false });
      expect(await (await post(id, { resumeS: 570 })).json()).toMatchObject({ resumeS: 0, finished: true });
      const copyId = (app.db.query(`SELECT id FROM copy WHERE video_id = ${id} ORDER BY id LIMIT 1`).get() as { id: number }).id;
      app.db.exec(`UPDATE copy SET duration_s = 100 WHERE id = ${copyId}`);
      expect(await (await post(id, { resumeS: 80, copyId })).json()).toMatchObject({ resumeS: 0, finished: true });
      expect(await (await post(id, { resumeS: 80 })).json()).toMatchObject({ resumeS: 80 }); // longest Copy decides without copyId
    } finally {
      app.db.exec(`UPDATE copy SET duration_s = 6 WHERE video_id = ${id}`);
    }
  });

  test("a sendBeacon style body (any content type) works; bad input and unknown Videos are refused", async () => {
    const id = songId();
    app.db.exec(`UPDATE copy SET duration_s = 600 WHERE video_id = ${id}`);
    expect((await post(id, { resumeS: 33 }, true)).status).toBe(200);
    expect(row(id).resume_s).toBe(33);
    expect((await post(id, { resumeS: -1 })).status).toBe(400);
    expect((await post(id, { resumeS: "12" })).status).toBe(400);
    expect((await post(id, {})).status).toBe(400);
    expect((await fetch(`${base_url}/api/videos/${id}/resume`, { method: "POST", body: "not json" })).status).toBe(400);
    expect((await post(999999, { resumeS: 1 })).status).toBe(404);
    expect(row(id).resume_s).toBe(33);
    app.db.exec(`UPDATE copy SET duration_s = 6 WHERE video_id = ${id}`);
  });
});

describe("screenshot endpoint", () => {
  const png = async () => {
    const out = join(base, "frame.png");
    await ff("-f", "lavfi", "-i", "testsrc=size=64x48:rate=1:duration=1", "-frames:v", "1", out);
    return new Uint8Array(await Bun.file(out).arrayBuffer());
  };
  const shot = (id: number, t: string | null, body: BodyInit) =>
    fetch(`${base_url}/api/videos/${id}/screenshot${t == null ? "" : `?t=${t}`}`, { method: "POST", headers: { "content-type": "image/png" }, body });

  test("writes <title> @ <seconds>s.png into the screenshot folder", async () => {
    const id = (app.db.query("SELECT id FROM video WHERE youtube_id = 'aaaaaaaaaaa'").get() as { id: number }).id;
    app.db.exec(`UPDATE video SET title = 'Edited' WHERE id = ${id}`);
    const bytes = await png();
    const r = await shot(id, "12.3", bytes);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.saved).toBe(join(shotsDir, "Edited @ 12.3s.png"));
    expect(new Uint8Array(await Bun.file(j.saved).arrayBuffer())).toEqual(bytes);
  });

  test("a hostile title cannot leave the folder", async () => {
    const id = (app.db.query("SELECT id FROM video WHERE youtube_id = 'aaaaaaaaaaa'").get() as { id: number }).id;
    app.db.exec(`UPDATE video SET title = '../../evil/../x' WHERE id = ${id}`);
    const j: any = await (await shot(id, "1", await png())).json();
    expect(j.saved.startsWith(shotsDir + "/")).toBe(true);
    expect(readdirSync(shotsDir).some((f) => f.includes("evil"))).toBe(true);
    expect(existsSync(join(base, "evil"))).toBe(false);
    app.db.exec(`UPDATE video SET title = 'Edited' WHERE id = ${id}`);
  });

  test("refuses a non-PNG body, a bad t, and an unknown Video", async () => {
    const id = (app.db.query("SELECT id FROM video WHERE youtube_id = 'aaaaaaaaaaa'").get() as { id: number }).id;
    expect((await shot(id, "5", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).status).toBe(415);
    expect((await shot(id, null, await png())).status).toBe(400);
    expect((await shot(id, "-3", await png())).status).toBe(400);
    expect((await shot(id, "abc", await png())).status).toBe(400);
    expect((await shot(999999, "5", await png())).status).toBe(404);
  });
});
