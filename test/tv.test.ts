// The TV Server (docs/tv-spec.md 2, 3.1-3.3): the TV Playback profile's decision, scan-time judging and staleness,
// the second listener, the route list and the Approved TV allowlist.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { TvServer } from "../src/server/tv";
import { judgeStaleCopies } from "../src/server/tvJudge";
import { TV_ROUTES, matchTvRoute } from "../src/server/tvRoutes";
import { V } from "./helpers/seed";
import { decideTvPlayback, fallbackFacts, TV_PROFILE, tvOrder, type CopyFacts, type PlaybackProfile, type TvDecision } from "../src/shared/playbackProfile";

const facts = (ext: string, v: string | null, a: string | null, width = 1920, height = 1080, frameRate: number | null = 30): CopyFacts => ({ ext, videoCodec: v, audioCodec: a, width, height, frameRate });
const decide = (f: CopyFacts) => decideTvPlayback(f, TV_PROFILE);
const ok: TvDecision = { video: "directplay", audio: "directplay", reason: null };

describe("TV Playback profile decision", () => {
  test("every combination of the 2026-10-11 census direct-plays (docs/research-samsung-tv-streaming.md section 0)", () => {
    const census: [string, string, string][] = [
      ["mkv", "h264", "opus"], ["webm", "vp9", "opus"], ["mp4", "h264", "aac"], ["mkv", "av1", "opus"], ["mkv", "vp9", "opus"],
      ["mkv", "h264", "aac"], ["mp4", "vp9", "aac"], ["mkv", "vp9", "aac"], ["webm", "av1", "opus"], ["mkv", "vp9", "eac3"],
    ];
    for (const [ext, v, a] of census) {
      expect(decide(facts(ext, v, a))).toEqual(ok);
      expect(decide(facts(ext, v, a, 3840, 2160, 30))).toEqual(ok); // the 2160p Copies
      expect(decide(facts(ext, v, a, 2560, 1440, 59.94))).toEqual(ok);
    }
  });

  test("a portrait 1080x1920 Copy passes: the limit is on the long edge, not the height", () => {
    expect(decide(facts("mp4", "h264", "aac", 1080, 1920))).toEqual(ok);
    expect(decide(facts("mp4", "h264", "aac", 2160, 3840))).toEqual(ok);
    const over = decide(facts("mp4", "h264", "aac", 1080, 5000));
    expect(over.video).toBe("copy");
    expect(over.reason).toContain("5000");
  });

  test("a 10-bit Copy passes (no pixel-format rule)", () => {
    // ffprobe's codec name does not change with bit depth: a Main10 hevc and a 10-bit av1 are hevc and av1
    expect(decide(facts("mkv", "hevc", "ac3"))).toEqual(ok);
    expect(decide(facts("mkv", "av1", "opus"))).toEqual(ok);
  });

  test("an unknown audio codec is an audio transcode, the video untouched", () => {
    const d = decide(facts("mkv", "h264", "pcm_s16le"));
    expect(d.video).toBe("directplay");
    expect(d.audio).toBe("transcode");
    expect(d.reason).toContain("pcm_s16le");
    expect(decide(facts("webm", "vp9", "aac")).audio).toBe("transcode"); // webm plays opus and vorbis only
    expect(decide(facts("mp4", "h264", null))).toEqual(ok); // no audio track
  });

  test("an unknown extension is a video copy with a reason", () => {
    const d = decide(facts("avi", "h264", "aac"));
    expect(d.video).toBe("copy");
    expect(d.audio).toBe("copy");
    expect(d.reason).toContain(".avi");
    expect(decide(facts("avi", "h264", "wmapro")).audio).toBe("transcode");
    expect(decide(facts("MKV", "h264", "aac"))).toEqual(ok); // the extension is case-insensitive
  });

  test("an unplayable video codec or a frame rate over the codec's limit is a video copy", () => {
    expect(decide(facts("mkv", "mpeg4", "aac")).video).toBe("copy");
    expect(decide(facts("mp4", "h264", "aac", 1920, 1080, 120)).video).toBe("copy"); // h264 is limited to 60 fps
    expect(decide(facts("mkv", "hevc", "aac", 1920, 1080, 120))).toEqual(ok); // hevc to 120
    expect(decide(facts("mkv", "av1", "opus", 1920, 1080, 120))).toEqual(ok);
    expect(decide(facts("webm", "vp9", "opus", 1920, 1080, 1000)).video).toBe("directplay"); // a time base, not a rate
    expect(decide(facts("webm", "vp9", "opus", 1920, 1080, null))).toEqual(ok); // no frame rate known
    expect(decide(facts("mkv", null, "aac")).video).toBe("copy");
  });

  test("the order: own file, else an existing Fallback the profile plays, else live", () => {
    const own = decide(facts("mkv", "h264", "pcm_s16le"));
    const fb = decide(fallbackFacts(facts("mkv", "h264", "pcm_s16le"), "transcode", "5.mkv")); // audio made AAC
    expect(tvOrder(decide(facts("mp4", "h264", "aac")), null)).toBe("file");
    expect(tvOrder(own, fb)).toBe("fallback");
    expect(tvOrder(own, null)).toBe("live");
    expect(tvOrder(own, decide(fallbackFacts(facts("mkv", "mpeg4", "aac"), "remux", "5.mkv")))).toBe("live");
    expect(tvOrder(null, null)).toBe("live"); // not judged yet
  });
});

// ---- the route list, with no server ----

describe("route list", () => {
  test("every sample matches its own route, once, and nothing else on the list", () => {
    for (const r of TV_ROUTES) {
      const path = r.sample.split("?")[0]!;
      expect(TV_ROUTES.filter((x) => x.method === r.method && x.pattern.test(path)).length).toBe(1);
      expect(matchTvRoute(r.method, path)).toBe(r);
    }
  });

  test("the writes are exactly resume and view; nothing editable is listed", () => {
    expect(TV_ROUTES.filter((r) => r.method !== "GET").map((r) => r.sample)).toEqual([`/api/videos/${V(1)}/resume`, `/api/videos/${V(1)}/view`]);
    for (const bad of ["/copy/1/pcm", "/api/studio/state", "/api/roots", "/api/scan", "/api/rescan", "/api/quit", "/app.js", "/api/tv", "/favorites", "/themes/a/b.css"]) {
      expect(matchTvRoute("GET", bad)).toBeNull();
    }
    expect(matchTvRoute("DELETE", `/api/videos/${V(1)}`)).toBeNull();
    expect(matchTvRoute("PATCH", `/api/videos/${V(1)}`)).toBeNull();
    expect(matchTvRoute("POST", `/api/videos/${V(1)}/chapters`)).toBeNull();
  });

  test("a passive server never starts a TV Server", () => {
    const tv = new TvServer({ cfg: { tvPort: 0, passive: true, webDir: "" }, db: null as never });
    expect(tv.start()).toMatchObject({ ok: false, status: 409 });
    expect(tv.on).toBe(false);
  });
});

// ---- a real server on a temp data dir ----

const base = mkdtempSync(join(tmpdir(), "tuva-tv-"));
const localDir = join(base, "local");
mkdirSync(localDir, { recursive: true });
let app: App;
let local: string;
let tvBase = "";
let ffmpeg = "";

async function ff(...args: string[]) {
  const p = Bun.spawn([ffmpeg, "-v", "error", "-y", ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}

const lav = (size: string, secs = 2) => ["-f", "lavfi", "-i", `testsrc=size=${size}:rate=25:duration=${secs}`, "-f", "lavfi", "-i", `sine=duration=${secs}`];

beforeAll(async () => {
  const cfg = loadConfig({ TUVA_DATA_DIR: join(base, "data"), TUVA_PORT: "0", TUVA_TV_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: localDir });
  ffmpeg = cfg.ffmpeg;
  await ff(...lav("320x240", 70), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(localDir, "Plain [aaaaaaaaaaa].mp4"));
  await ff(...lav("1080x1920"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(localDir, "Portrait [bbbbbbbbbbb].mp4"));
  await ff(...lav("320x240"), "-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-c:a", "aac", join(localDir, "Ten Bit [ccccccccccc].mkv")).catch(() =>
    ff(...lav("320x240"), "-c:v", "libx264", "-c:a", "aac", join(localDir, "Ten Bit [ccccccccccc].mkv")),
  );
  await ff(...lav("320x240"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", join(localDir, "Pcm [ddddddddddd].mkv"));
  app = await startApp(cfg);
  local = `http://localhost:${app.server.port}`;
  await app.scanner.requestAll();
  await app.scanner.whenIdle();
}, 60_000);

afterAll(async () => {
  await app.stop();
  rmSync(base, { recursive: true, force: true });
});

const j = async (path: string, init?: RequestInit) => (await fetch(local + path, init)).json() as Promise<any>;
const post = (path: string, body?: unknown) => j(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const tvReq = (path: string, init?: RequestInit) => fetch(tvBase + path, init);
const tvModel = { "x-tuva-tv": "Samsung 85R85H" };

describe("scan-time judging", () => {
  test("/api/videos carries the decision and the order on every Copy", async () => {
    const videos = await j("/api/videos");
    expect(videos.length).toBe(4);
    const by = (id: string) => videos.find((v: any) => v.youtubeId === id).copies[0];
    expect(by("aaaaaaaaaaa").tv).toEqual({ decision: ok, order: "file" });
    expect(by("bbbbbbbbbbb").tv).toEqual({ decision: ok, order: "file" }); // portrait 1080x1920
    expect(by("ccccccccccc").tv).toEqual({ decision: ok, order: "file" });
    const pcm = by("ddddddddddd").tv;
    expect(pcm.decision.audio).toBe("transcode");
    expect(pcm.decision.video).toBe("directplay");
    expect(pcm.order).toBe("live"); // no Fallback made yet
    const one = await j(`/api/copies/${by("ddddddddddd").id}`);
    expect(one.tv).toEqual(pcm);
    expect((app.db.query("SELECT DISTINCT tv_profile_version v FROM copy").all() as { v: number }[]).map((r) => r.v)).toEqual([TV_PROFILE.version]);
  });

  test("an existing Fallback the profile plays moves the order to fallback", async () => {
    const id = (app.db.query("SELECT c.id FROM copy c JOIN videos v ON v.id = c.video_id WHERE v.youtube_id = 'ddddddddddd'").get() as { id: number }).id;
    app.db.query("UPDATE copy SET fallback_file = ? WHERE id = ?").run(`${id}.mkv`, id);
    try {
      expect((await j(`/api/copies/${id}`)).tv.order).toBe("fallback"); // the Fallback holds AAC
    } finally {
      app.db.query("UPDATE copy SET fallback_file = NULL WHERE id = ?").run(id);
    }
  });

  test("a stale profile version is judged again; so are unjudged rows", () => {
    const stale = JSON.stringify({ video: "transcode", audio: "transcode", reason: "old" });
    app.db.query("UPDATE copy SET tv_playback = ?, tv_profile_version = 0").run(stale);
    app.db.query("UPDATE copy SET tv_playback = NULL, tv_profile_version = NULL WHERE id = (SELECT MIN(id) FROM copy)").run();
    expect(judgeStaleCopies(app.db)).toBe(4);
    expect(judgeStaleCopies(app.db)).toBe(0); // nothing left to do
    expect((app.db.query("SELECT COUNT(*) n FROM copy WHERE tv_playback LIKE '%old%'").get() as { n: number }).n).toBe(0);

    // a new profile version (mkv no longer listed) re-judges every Copy, and only the mkv ones change
    const next: PlaybackProfile = { ...TV_PROFILE, version: TV_PROFILE.version + 1, rules: { mp4: TV_PROFILE.rules.mp4! } };
    expect(judgeStaleCopies(app.db, next)).toBe(4);
    const rows = app.db.query("SELECT rel_path, tv_playback, tv_profile_version v FROM copy ORDER BY rel_path").all() as { rel_path: string; tv_playback: string; v: number }[];
    for (const r of rows) {
      expect(r.v).toBe(next.version);
      expect(JSON.parse(r.tv_playback).video).toBe(r.rel_path.endsWith(".mkv") ? "copy" : "directplay");
    }
    expect(judgeStaleCopies(app.db)).toBe(4); // back under the real profile
    expect(JSON.parse((app.db.query("SELECT tv_playback FROM copy WHERE rel_path LIKE 'Ten%'").get() as any).tv_playback)).toEqual(ok);
  });
});

describe("TV Server listener", () => {
  test("off at launch; the control routes live on the localhost listener only", async () => {
    const s = await j("/api/tv");
    expect(s).toMatchObject({ available: true, on: false, port: null, pending: [], approved: [], playing: null });
    expect(app.tv.on).toBe(false);
  });

  test("turn on binds a listener on all interfaces; health answers anyone", async () => {
    const s = await post("/api/tv/on");
    expect(s.on).toBe(true);
    expect(s.port).toBeGreaterThan(0);
    tvBase = `http://127.0.0.1:${s.port}`;
    const h = await tvReq("/api/health");
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ app: "TuvaVideos TV Server" });
    expect(await post("/api/tv/on")).toMatchObject({ on: true, port: s.port }); // idempotent
  });

  test("every unlisted route is a 404 on the TV listener, for an Approved TV and a stranger alike", async () => {
    const unlisted: [string, string][] = [
      ["GET", "/api/roots"], ["GET", "/api/scan"], ["GET", "/api/studio/state"], ["GET", "/api/tv"], ["GET", "/app.js"], ["GET", "/app.css"], ["GET", "/favorites"],
      ["GET", "/search"], ["GET", `/play/${V(1)}`], ["GET", "/themes/a/b.css"], ["GET", "/copy/1/pcm"], ["GET", "/api/studio/search?q=a"], ["GET", "/live/x"],
      ["GET", `/api/videos/${V(1)}/extra`], ["GET", "/nope"], ["GET", "/index.html"],
      ["POST", "/api/rescan"], ["POST", "/api/quit"], ["POST", "/api/tv/on"], ["POST", "/api/tv/off"], ["POST", "/api/tv/approve"], ["POST", `/api/videos/${V(1)}/favorite`],
      ["POST", `/api/videos/${V(1)}/loop`], ["POST", `/api/videos/${V(1)}/screenshot?t=1`], ["POST", `/api/videos/${V(1)}/chapters`], ["POST", "/api/copies/1/reveal"], ["POST", "/api/choose-file"],
      ["POST", "/api/studio/play"], ["POST", "/api/artists"], ["POST", "/api/songs"], ["POST", `/api/videos/${V(1)}/relocate`],
      ["PATCH", `/api/videos/${V(1)}`], ["PUT", `/api/videos/${V(1)}/audio`], ["PUT", "/api/audio-presets/x"], ["DELETE", `/api/videos/${V(1)}`], ["DELETE", `/api/videos/${V(1)}/view`],
      ["DELETE", "/api/tv/approved/1.2.3.4"], ["DELETE", "/api/audio-presets/x"],
    ];
    const walk = async () => {
      for (const [method, path] of unlisted) {
        const r = await tvReq(path, { method, headers: tvModel, body: method === "GET" ? undefined : "{}" });
        expect([method, path, r.status, r.headers.get("x-tv-route")]).toEqual([method, path, 404, "unlisted"]);
      }
    };
    await walk(); // a stranger: still a 404, not a 403, and no prompt is raised by it
    expect((await j("/api/tv")).pending).toEqual([]);
    await post("/api/tv/approve", { ip: "127.0.0.1" });
    await walk();
    await j("/api/tv/approved/127.0.0.1", { method: "DELETE" });
  });

  test("a stranger gets 403 approve and a prompt carrying the X-Tuva-TV model", async () => {
    for (const path of ["/api/videos", "/", "/copy/1"]) {
      const r = await tvReq(path, { headers: tvModel });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "approve" });
    }
    expect((await j("/api/tv")).pending).toEqual([{ ip: "127.0.0.1", model: "Samsung 85R85H" }]);
  });

  test("Allow stores an Approved TV with its model; every listed route then answers", async () => {
    const s = await post("/api/tv/approve", { ip: "127.0.0.1" });
    expect(s.pending).toEqual([]);
    expect(s.approved).toHaveLength(1);
    expect(s.approved[0]).toMatchObject({ ip: "127.0.0.1", model: "Samsung 85R85H" });
    expect(app.db.query("SELECT model FROM approved_tv WHERE ip = '127.0.0.1'").get()).toEqual({ model: "Samsung 85R85H" });

    const videos = (await (await tvReq("/api/videos", { headers: tvModel })).json()) as any[];
    expect(videos[0].copies[0].tv.order).toBeDefined();
    const vid = videos[0].id;
    const copy = videos[0].copies[0].id;
    // walk the data: every listed route is answered by its handler (never the unlisted 404)
    for (const r of TV_ROUTES) {
      const path = r.sample.replace(`/videos/${V(1)}`, `/videos/${vid}`).replace("/copies/1", `/copies/${copy}`).replace("/copy/1", `/copy/${copy}`).replace(`/thumbs/${V(1)}/`, `/thumbs/${vid}/`).replace("/live/1/", `/live/${copy}/`);
      const res = await tvReq(path, { method: r.method, headers: tvModel, body: r.method === "POST" ? JSON.stringify({ resumeS: 3 }) : undefined });
      expect([r.method, path, res.headers.get("x-tuva-route") ?? res.headers.get("x-tv-route")]).toEqual([r.method, path, null]);
      if (r.kind === "live") expect(res.status).toBe(404); // until tv-live-remux
      else if (path.startsWith("/thumbs/")) expect(res.status).toBe(404); // no Thumbnail in a fixture library, still the handler's answer
      else expect(res.status).toBeLessThan(500); // some samples name nothing in the fixture library (a Song): still the handler's own answer
    }
    const ui = await (await tvReq("/", { headers: tvModel })).text();
    expect(ui).toContain("TuvaVideos TV Server");
    expect(ui).toMatch(/\d+\.\d+\.\d+\.\d+:\d+|no network address/);
  });

  test("the two writes work over the TV listener", async () => {
    const vid = (await j("/api/videos")).find((v: any) => v.youtubeId === "aaaaaaaaaaa").id; // the 70 s one: Resume near the end stores 0
    const r = await tvReq(`/api/videos/${vid}/resume`, { method: "POST", headers: tvModel, body: JSON.stringify({ resumeS: 12.5 }) });
    expect(r.status).toBe(200);
    expect((await j(`/api/videos/${vid}`)).resumeS).toBe(12.5);
    const before = (await j(`/api/videos/${vid}`)).viewCount;
    expect((await tvReq(`/api/videos/${vid}/view`, { method: "POST", headers: tvModel })).status).toBe(200);
    expect((await j(`/api/videos/${vid}`)).viewCount).toBe(before + 1);
  });

  test("thumbs answers carry Access-Control-Allow-Origin: *, the localhost listener's do not", async () => {
    const vid = (await j("/api/videos"))[0].id;
    expect((await tvReq(`/thumbs/${vid}/poster.webp`, { headers: tvModel })).headers.get("access-control-allow-origin")).toBe("*");
    expect((await fetch(`${local}/thumbs/${vid}/poster.webp`)).headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the indicator: an Approved TV that just made a request is playing the Video whose stream it asked for", async () => {
    const v = (await j("/api/videos"))[0];
    await tvReq(`/api/videos/${v.id}`, { headers: tvModel });
    expect((await j("/api/tv")).playing).toMatchObject({ ip: "127.0.0.1", model: "Samsung 85R85H" }); // title: the stream asked for last (the route walk asked for one)
    await tvReq(`/copy/${v.copies[0].id}`, { headers: { ...tvModel, range: "bytes=0-9" } });
    expect((await j("/api/tv")).playing).toEqual({ ip: "127.0.0.1", model: "Samsung 85R85H", title: v.title });
    expect((app.db.query("SELECT last_seen_at FROM approved_tv").get() as any).last_seen_at).not.toBeNull();
  });

  test("Remove puts the TV's next request back through the prompt", async () => {
    const s = await j("/api/tv/approved/127.0.0.1", { method: "DELETE" });
    expect(s.approved).toEqual([]);
    expect((await j("/api/tv/approved/127.0.0.1", { method: "DELETE" })).error).toBeDefined();
    expect((await tvReq("/api/videos", { headers: tvModel })).status).toBe(403);
    expect((await j("/api/tv")).pending).toEqual([{ ip: "127.0.0.1", model: "Samsung 85R85H" }]);
  });

  test("Deny silences the IP until the next turn-on", async () => {
    const s = await post("/api/tv/deny", { ip: "127.0.0.1" });
    expect(s.pending).toEqual([]);
    expect((await tvReq("/api/videos", { headers: tvModel })).status).toBe(403);
    expect((await j("/api/tv")).pending).toEqual([]); // silenced
    await post("/api/tv/off");
    await post("/api/tv/on");
    tvBase = `http://127.0.0.1:${(await j("/api/tv")).port}`;
    expect((await tvReq("/api/videos", { headers: tvModel })).status).toBe(403);
    expect((await j("/api/tv")).pending).toHaveLength(1); // asks again
  });

  test("per-request IP check: other addresses are judged on their own", async () => {
    await post("/api/tv/approve", { ip: "10.0.0.7" });
    const req = (ip: string) => app.tv.fetch(new Request("http://x/api/videos"), ip);
    expect((await req("10.0.0.7")).status).toBe(200);
    expect((await req("::ffff:10.0.0.7".replace("::ffff:", ""))).status).toBe(200);
    expect((await req("10.0.0.8")).status).toBe(403);
    expect((await req("")).status).toBe(403); // an address Bun could not read is never approved
    expect((await j("/api/tv")).pending.map((p: any) => p.ip)).toContain("10.0.0.8");
    await j("/api/tv/approved/10.0.0.7", { method: "DELETE" });
  });

  test("approve and deny need an ip", async () => {
    expect((await fetch(`${local}/api/tv/approve`, { method: "POST", body: "{}" })).status).toBe(400);
    expect((await fetch(`${local}/api/tv/deny`, { method: "POST", body: "nope" })).status).toBe(400);
  });

  test("off is a hard stop: the listener is gone, the hooks ran, the pending prompt is cleared", async () => {
    let cut = 0;
    app.tv.onStop(() => cut++);
    const s = await post("/api/tv/off");
    expect(s).toMatchObject({ on: false, port: null, pending: [], playing: null });
    expect(cut).toBe(1);
    let failed = false;
    try {
      await tvReq("/api/health");
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect((await j("/api/health")).app).toBe("TuvaVideos"); // the localhost listener is untouched
    expect((await post("/api/tv/off")).on).toBe(false); // idempotent
    expect(cut).toBe(1);
  });
});
