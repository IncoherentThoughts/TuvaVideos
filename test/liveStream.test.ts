// Live streams through the TV listener (docs/home-server-spec.md 7, 10): a short generated fixture (lavfi testsrc,
// silent audio; never a library file) through encode mode, checked for segment count and a keyframe at each segment
// start; a far seek restarting the encoder; two slots and a third device's 503; the temp dir gone on stop.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";

process.env.TUVA_TV_LOOPBACK = "1";
const base = mkdtempSync(join(tmpdir(), "tuva-live-test-"));
const localDir = join(base, "local");
mkdirSync(localDir, { recursive: true });
let app: App;
let local = "";
let ffmpeg = "";
let ffprobe = "";
const TVS = ["127.0.0.1", "10.77.0.2", "10.77.0.3"];
const files = { enc: "Testsrc [aaaaaaaaaaa].mkv", copy: "Copyable [bbbbbbbbbbb].mkv" };
const ids: Record<keyof typeof files, number> = { enc: 0, copy: 0 };

async function run(bin: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return out;
}
const tv = (path: string, ip = TVS[0]!) => app.tv.fetch(new Request(`http://tv${path}`), ip);

/** The video packets of a segment: [pts, keyframe]. */
async function packets(file: string): Promise<[number, boolean][]> {
  const out = await run(ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file);
  return out
    .trim()
    .split("\n")
    .map((l) => l.split(","))
    .map(([t, f]) => [Number(t), (f ?? "").includes("K")] as [number, boolean]);
}

beforeAll(async () => {
  const cfg = loadConfig({ TUVA_DATA_DIR: join(base, "data"), TUVA_PORT: "0", TUVA_TV_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: localDir, TUVA_TV_LOOPBACK: "1" });
  ffmpeg = cfg.ffmpeg;
  ffprobe = cfg.ffprobe;
  const lav = ["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25:duration=32", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest"];
  // mpeg4 video: the TV profile cannot play it, so the Copy plays as a Live stream in encode mode
  await run(ffmpeg, "-v", "error", "-y", ...lav, "-c:v", "mpeg4", "-q:v", "5", "-c:a", "pcm_s16le", join(localDir, files.enc));
  // h264 with PCM audio: only the audio is wrong, copy mode (every extension the scan takes is on the TV table)
  await run(ffmpeg, "-v", "error", "-y", ...lav.map((a) => a.replace("duration=32", "duration=12")), "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", join(localDir, files.copy));
  app = await startApp(cfg);
  local = `http://localhost:${app.server.port}`;
  await app.scanner.requestAll();
  await app.scanner.whenIdle();
  for (const k of Object.keys(files) as (keyof typeof files)[]) ids[k] = (app.db.query("SELECT id FROM copy WHERE rel_path = ?").get(files[k]) as { id: number }).id;
  for (const ip of TVS) await fetch(`${local}/api/tv/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ip }) });
  expect(app.tv.start()).toEqual({ ok: true });
}, 90_000);

afterAll(async () => {
  await app.stop();
  rmSync(base, { recursive: true, force: true });
});

describe("Live stream", () => {
  test("the profile: video transcode for mpeg4, an audio-only fix for PCM", async () => {
    const enc = await (await fetch(`${local}/api/copies/${ids.enc}`)).json();
    expect(enc.tv.order).toBe("live");
    expect(enc.tv.decision.video).toBe("transcode");
    const copy = await (await fetch(`${local}/api/copies/${ids.copy}`)).json();
    expect(copy.tv.decision).toMatchObject({ video: "directplay", audio: "transcode" });
  });

  test("encode mode: 4 segments of 720p h264, a keyframe at each segment start and none between", async () => {
    const pl = await tv(`/live/${ids.enc}/index.m3u8?q=orig`);
    expect(pl.status).toBe(200);
    expect(pl.headers.get("content-type")).toContain("mpegurl");
    const text = await pl.text();
    const segs = text.match(/^seg\d+\.ts\?q=orig$/gm)!;
    expect(segs.length).toBe(4);
    const starts: number[] = [];
    for (let i = 0; i < segs.length; i++) {
      const res = await tv(`/live/${ids.enc}/${segs[i]}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("video/mp2t");
      const file = join(base, `enc${i}.ts`);
      await Bun.write(file, await res.arrayBuffer());
      const p = await packets(file);
      expect(p[0]![1]).toBe(true); // opens on a keyframe
      expect(p.filter(([, k]) => k).length).toBe(1); // and has no other
      starts.push(p[0]![0]);
      if (i === 0) {
        const info = JSON.parse(await run(ffprobe, "-v", "error", "-show_entries", "stream=codec_name,height", "-of", "json", file)) as { streams: { codec_name: string; height?: number }[] };
        expect(info.streams.find((s) => s.height)).toMatchObject({ codec_name: "h264", height: 720 });
        expect(info.streams.some((s) => s.codec_name === "aac")).toBe(true);
      }
    }
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeCloseTo(10, 1);
    expect(app.live.streams()).toHaveLength(1);
  }, 60_000);

  test("a far seek kills and restarts at the segment asked for, on the same timeline", async () => {
    const dev = TVS[0]!;
    await tv(`/live/${ids.enc}/index.m3u8?q=480`, dev); // replaces this device's own stream
    expect(app.live.streams().map((s) => s.key)).toEqual([`${ids.enc}:480`]);
    const res = await tv(`/live/${ids.enc}/seg3.ts?q=480`, dev);
    expect(res.status).toBe(200);
    const file = join(base, "seek3.ts");
    await Bun.write(file, await res.arrayBuffer());
    const p = await packets(file);
    expect(p[0]![1]).toBe(true);
    expect(p[0]![0]).toBeGreaterThan(29.9); // segment 3 starts at 30 s (plus the TS mux delay)
    expect(p[0]![0]).toBeLessThan(32);
    const back = await tv(`/live/${ids.enc}/seg0.ts?q=480`, dev); // behind this run's start: restarts again
    expect(back.status).toBe(200);
  }, 60_000);

  test("copy mode: the h264 video untouched, the audio made AAC", async () => {
    const dev = TVS[0]!;
    const pl = await (await tv(`/live/${ids.copy}/index.m3u8`, dev)).text();
    expect(pl.match(/^seg\d+\.ts/gm)!.length).toBe(2);
    const res = await tv(`/live/${ids.copy}/seg0.ts?q=orig`, dev);
    expect(res.status).toBe(200);
    const file = join(base, "copy0.ts");
    await Bun.write(file, await res.arrayBuffer());
    const info = JSON.parse(await run(ffprobe, "-v", "error", "-show_entries", "stream=codec_name,height", "-of", "json", file)) as { streams: { codec_name: string; height?: number }[] };
    expect(info.streams.map((s) => s.codec_name).sort()).toEqual(["aac", "h264"]);
  }, 30_000);

  test("two streams per server, one per device: a third device gets 503 busy", async () => {
    expect((await tv(`/live/${ids.enc}/index.m3u8?q=720`, TVS[1])).status).toBe(200);
    expect(app.live.streams()).toHaveLength(2);
    const busy = await tv(`/live/${ids.enc}/index.m3u8?q=720`, TVS[2]);
    expect(busy.status).toBe(503);
    const body = (await busy.json()) as { error: string; streams: { device: string; title: string }[] };
    expect(body.error).toBe("busy");
    expect(body.streams).toHaveLength(2);
    expect(body.streams.every((s) => s.title.length > 0)).toBe(true);
    expect((await tv(`/live/${ids.enc}/index.m3u8?q=bogus`, TVS[0])).status).toBe(400);
    // the desktop Player (home-server-spec 7.1) is one more device in the same two slots
    const mine = await fetch(`${local}/live/${ids.enc}/index.m3u8?q=480`);
    expect(mine.status).toBe(503);
    expect(((await mine.json()) as { error: string }).error).toBe("busy");
  });

  test("turning the server off kills every stream and deletes its temp dir", async () => {
    const dirs = app.live.streams().map((s) => s.tempDir).filter((d): d is string => !!d);
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) expect(existsSync(d)).toBe(true);
    app.tv.stop();
    expect(app.live.streams()).toHaveLength(0);
    for (const d of dirs) expect(existsSync(d)).toBe(false);
  });

  test("the localhost app serves this Mac's Live streams to the desktop Player, its segments relative to the playlist", async () => {
    const pl = await fetch(`${local}/live/${ids.enc}/index.m3u8?q=480`);
    expect(pl.status).toBe(200);
    expect(pl.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    const text = await pl.text();
    expect(text).toContain("seg0.ts?q=480");
    expect(app.live.streams().map((s) => s.key)).toEqual([`${ids.enc}:480`]);
    const seg = await fetch(`${local}/live/${ids.enc}/seg0.ts?q=480`);
    expect(seg.status).toBe(200);
    expect((await seg.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    app.live.stopAll();
  }, 30_000);
});
