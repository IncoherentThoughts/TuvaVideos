// `/copy/:id` decides by the requesting player's Playback profile (docs/tv-spec.md 3.2, audit PLAY-1 / TV-1): through
// the TV listener the Copy's own file when the TV plays it as-is, an existing Fallback only when the TV plays that,
// and never a Fallback job; the browser path is unchanged.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";

const base = mkdtempSync(join(tmpdir(), "tuva-tvcopy-"));
const localDir = join(base, "local");
mkdirSync(localDir, { recursive: true });
let app: App;
let local = "";
let ffmpeg = "";
const TV_IP = "127.0.0.1";

async function ff(...args: string[]) {
  const p = Bun.spawn([ffmpeg, "-v", "error", "-y", ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}
const lav = ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2", "-f", "lavfi", "-i", "sine=duration=2"];

const files = { ac3: "Ac3 [eeeeeeeeeee].mkv", pcm: "Pcm [fffffffffff].mkv", mp4: "Plain [ggggggggggg].mp4" };
const ids: Record<keyof typeof files, number> = { ac3: 0, pcm: 0, mp4: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tv = (path: string, init?: RequestInit) => app.tv.fetch(new Request(`http://tv${path}`, init), TV_IP);
const fbState = (id: number) => app.fallback.status(id).state;
const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

beforeAll(async () => {
  const cfg = loadConfig({ TUVA_DATA_DIR: join(base, "data"), TUVA_PORT: "0", TUVA_TV_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: localDir });
  ffmpeg = cfg.ffmpeg;
  await ff(...lav, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "ac3", join(localDir, files.ac3)); // browser: transcode; TV: as-is
  await ff(...lav, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", join(localDir, files.pcm)); // neither plays the audio
  await ff(...lav, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(localDir, files.mp4));
  app = await startApp(cfg);
  local = `http://localhost:${app.server.port}`;
  await app.scanner.requestAll();
  await app.scanner.whenIdle();
  for (const k of Object.keys(files) as (keyof typeof files)[]) {
    ids[k] = (app.db.query("SELECT id FROM copy WHERE rel_path = ?").get(files[k]) as { id: number }).id;
  }
  // the scan-time Fallbacks (ac3, pcm) finish before the tests look at them
  for (let i = 0; i < 300 && (fbState(ids.ac3) !== "ready" || fbState(ids.pcm) !== "ready"); i++) await sleep(100);
  await fetch(`${local}/api/tv/approve`, { method: "POST", body: JSON.stringify({ ip: TV_IP }) });
}, 60_000);

afterAll(async () => {
  await app.stop();
  rmSync(base, { recursive: true, force: true });
});

const clearFallback = (id: number) => app.db.query("UPDATE copy SET fallback_file = NULL WHERE id = ?").run(id);
const fallbackFile = (id: number) => (app.db.query("SELECT fallback_file f FROM copy WHERE id = ?").get(id) as { f: string | null }).f;

describe("/copy/:id through the TV listener", () => {
  test("the fixture: browser and TV disagree on the AC3 Copy", async () => {
    const c = await (await fetch(`${local}/api/copies/${ids.ac3}`)).json();
    expect(c.playback).toBe("transcode");
    expect(c.tv.order).toBe("file");
    expect((await (await fetch(`${local}/api/copies/${ids.pcm}`)).json()).tv.order).toBe("fallback");
    expect(fbState(ids.ac3)).toBe("ready");
  });

  test("a Copy the TV plays as-is: its own file, even while a browser Fallback exists", async () => {
    const res = await tv(`/copy/${ids.ac3}`);
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(new Uint8Array(readFileSync(join(localDir, files.ac3))));
    const part = await tv(`/copy/${ids.ac3}`, { headers: { range: "bytes=0-9" } });
    expect(part.status).toBe(206);
    expect((await bytesOf(part)).length).toBe(10);
  });

  test("with no Fallback made, the TV still gets the own file and no Fallback job is queued", async () => {
    clearFallback(ids.ac3);
    expect(fbState(ids.ac3)).toBe("none");
    const res = await tv(`/copy/${ids.ac3}`);
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(new Uint8Array(readFileSync(join(localDir, files.ac3))));
    await sleep(50);
    expect(fbState(ids.ac3)).toBe("none");
    expect(fallbackFile(ids.ac3)).toBeNull();
  });

  test("a Copy whose Fallback the TV plays: the Fallback; without one a 409, and nothing is queued", async () => {
    const made = fallbackFile(ids.pcm)!;
    expect(made).not.toBeNull();
    const res = await tv(`/copy/${ids.pcm}`);
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(new Uint8Array(readFileSync(join(app.cfg.remuxDir, made))));

    clearFallback(ids.pcm);
    const none = await tv(`/copy/${ids.pcm}`);
    expect(none.status).toBe(409);
    expect((await none.json()).order).toBe("live");
    await sleep(50);
    expect(fbState(ids.pcm)).toBe("none");
  });

  test("a native Copy plays as before on both listeners", async () => {
    const file = new Uint8Array(readFileSync(join(localDir, files.mp4)));
    expect(await bytesOf(await tv(`/copy/${ids.mp4}`))).toEqual(file);
    expect(await bytesOf(await fetch(`${local}/copy/${ids.mp4}`))).toEqual(file);
  });

  test("the browser path is unchanged: no Fallback yet is a 503 that queues the play job", async () => {
    clearFallback(ids.ac3);
    const res = await fetch(`${local}/copy/${ids.ac3}`);
    expect(res.status).toBe(503);
    expect(["queued", "preparing", "ready"]).toContain(((await res.json()) as { state: string }).state);
    expect(fbState(ids.ac3)).not.toBe("none");
  });
});
