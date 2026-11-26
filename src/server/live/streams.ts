// Live streams (docs/home-server-spec.md 7, docs/tv-spec.md 3.4): `/live/:copyId/index.m3u8?q=` and its `seg<n>.ts`,
// made on the fly by ffmpeg into a temp dir, one per device and at most two per server. The encoder runs about 60 s
// ahead of the last segment asked for and is then paused (SIGSTOP); segments 300 s behind are deleted; a jump outside
// what was made kills it and starts again at the segment asked for. It bypasses the ffmpeg queue and the Thumbnail
// gate. Nothing is cached: the temp dir goes when the stream stops, is replaced or idles, the server turns off, or the
// process exits.
import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db";
import { log } from "../log";
import type { Roots } from "../roots";
import { factsOfRow } from "../tvJudge";
import { decideTvPlayback, TV_PROFILE } from "../../shared/playbackProfile";
import { parseLiveQuality, type LiveQuality } from "../../shared/liveQuality";
import { ffmpegArgs, planLive, pruneBelow, segmentAction, segmentCount, shouldPause, vodPlaylist, type LivePlan, type ProducedRange } from "./hls";
import { arbitrate, MAX_LIVE_STREAMS } from "./slots";

/** A stream nobody has asked anything of for this long is stopped (a paused player restarts it on its next segment). */
export const LIVE_IDLE_MS = 120_000;
/** The longest a segment request waits for the encoder. */
const SEGMENT_WAIT_MS = 60_000;
const TICK_MS = 150;

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LiveDeps {
  db: Db;
  roots: Pick<Roots, "get" | "isAvailable">;
  ffmpeg: string;
  /** Where the temp dirs go; the system temp dir by default. */
  tmpRoot?: string;
  idleMs?: number;
}

interface CopyRow {
  id: number;
  root_id: number;
  rel_path: string;
  size: number | null;
  duration_s: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  r_frame_rate: string | null;
  missing_since: string | null;
  title: string;
}

class LiveStream {
  private dir: string | null = null;
  private proc: Subprocess | null = null;
  private run = 0;
  private range: ProducedRange | null = null;
  /** The start segment of a run that failed, so a request for it is an error, not another restart. */
  private failedStart: number | null = null;
  private failure = "";
  private paused = false;
  lastRequested = 0;
  lastAt = Date.now();
  readonly count: number;

  constructor(
    readonly key: string,
    readonly device: string,
    readonly deviceName: string,
    readonly title: string,
    private input: string,
    readonly plan: LivePlan,
    readonly durationS: number,
    private ffmpeg: string,
    private tmpRoot: string,
  ) {
    this.count = segmentCount(durationS);
  }

  private segPath = (n: number) => join(this.dir!, `seg${n}.ts`);

  private kill() {
    const p = this.proc;
    this.proc = null;
    this.paused = false;
    if (!p) return;
    try {
      p.kill("SIGKILL"); // a stopped (SIGSTOP) process dies too
    } catch {}
  }

  private startAt(n: number) {
    this.kill();
    if (!this.dir) this.dir = mkdtempSync(join(this.tmpRoot, "tuva-live-"));
    for (const f of readdirSync(this.dir)) rmSync(join(this.dir, f), { force: true });
    const run = ++this.run;
    this.failedStart = null;
    this.range = { start: n, next: n, low: n, exited: false };
    const p = Bun.spawn([this.ffmpeg, ...ffmpegArgs(this.plan, this.input, this.dir, n)], { stdout: "ignore", stderr: "pipe" });
    this.proc = p;
    log(`Live stream ${this.key} for ${this.deviceName}: ${this.plan.mode}${this.plan.shortEdge ? ` ${this.plan.shortEdge}p ${this.plan.videoKbps} kbit/s` : ""}, from segment ${n}`);
    void (async () => {
      const err = await new Response(p.stderr as ReadableStream).text().catch(() => "");
      const code = await p.exited;
      if (run !== this.run || !this.range) return;
      this.range.exited = true;
      this.refresh();
      if (code !== 0 && p.signalCode == null) {
        this.failedStart = n;
        this.failure = err.trim().split("\n").slice(-3).join(" ") || `ffmpeg exited ${code}`;
        log(`Live stream ${this.key}: ffmpeg failed at segment ${n}: ${this.failure}`);
      }
    })();
  }

  /** Counts finished segments (ffmpeg writes `.tmp` and renames, so a `seg<n>.ts` on disk is whole), prunes, pauses. */
  refresh() {
    const r = this.range;
    if (!r || !this.dir) return;
    while (r.next < this.count && existsSync(this.segPath(r.next))) r.next++;
    const below = Math.min(pruneBelow(this.lastRequested), r.next);
    for (; r.low < below; r.low++) {
      try {
        unlinkSync(this.segPath(r.low));
      } catch {}
    }
    if (!this.proc || r.exited) return;
    const pause = shouldPause(r.next, this.lastRequested);
    if (pause !== this.paused) {
      try {
        this.proc.kill(pause ? "SIGSTOP" : "SIGCONT");
        this.paused = pause;
      } catch {}
    }
  }

  async segment(n: number, signal: AbortSignal): Promise<Response> {
    this.lastAt = Date.now();
    this.lastRequested = n;
    const until = Date.now() + SEGMENT_WAIT_MS;
    for (;;) {
      this.refresh();
      const onDisk = !!this.dir && existsSync(this.segPath(n));
      const act = segmentAction(this.range, n, onDisk);
      if (act === "ready") return new Response(Bun.file(this.segPath(n)), { headers: { "content-type": "video/mp2t", "cache-control": "no-store" } });
      if (act === "restart") {
        if (this.lastRequested !== n) return json({ error: "superseded by a later request" }, 404);
        if (this.failedStart === n) return json({ error: "the Live stream failed", detail: this.failure }, 500);
        this.startAt(n);
      }
      if (signal.aborted) return json({ error: "aborted" }, 499);
      if (Date.now() > until) return json({ error: "the Live stream is not keeping up" }, 504);
      this.lastAt = Date.now();
      await sleep(TICK_MS);
    }
  }

  stop() {
    this.run++;
    this.kill();
    this.range = null;
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
  }

  get tempDir(): string | null {
    return this.dir;
  }
}

/** Every manager, so one exit hook clears them all. */
const managers = new Set<LiveStreams>();
let exitHooked = false;

export class LiveStreams {
  private byDevice = new Map<string, LiveStream>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: LiveDeps) {
    managers.add(this);
    if (!exitHooked) {
      exitHooked = true;
      process.on("exit", () => {
        for (const m of managers) m.stopAll();
      });
    }
  }

  /** The device and title of each stream running, for the busy answer and the menu. */
  streams(): { device: string; title: string; key: string; tempDir: string | null }[] {
    return [...this.byDevice.values()].map((s) => ({ device: s.deviceName, title: s.title, key: s.key, tempDir: s.tempDir }));
  }

  stop(device: string) {
    const s = this.byDevice.get(device);
    if (!s) return;
    s.stop();
    this.byDevice.delete(device);
    log(`Live stream ${s.key} for ${s.deviceName}: stopped`);
    if (!this.byDevice.size) this.stopTicker();
  }

  /** The server turned off, the app quits, or the process exits: kill every encoder and delete every temp dir. */
  stopAll() {
    for (const d of [...this.byDevice.keys()]) this.stop(d);
    this.stopTicker();
  }

  private stopTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private tick() {
    const idle = this.deps.idleMs ?? LIVE_IDLE_MS;
    for (const [device, s] of this.byDevice) {
      if (Date.now() - s.lastAt > idle) this.stop(device);
      else s.refresh();
    }
  }

  /** `/live/:copyId/index.m3u8?q=` or `/live/:copyId/seg<n>.ts?q=` for `device` (its address), called `deviceName`. */
  async serve(req: Request, device: string, deviceName: string): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/live\/(\d+)\/(?:(index\.m3u8)|seg(\d+)\.ts)$/);
    if (!m) return json({ error: "not found" }, 404);
    const q = parseLiveQuality(url.searchParams.get("q"));
    if (!q) return json({ error: "q is orig, 1080, 720 or 480" }, 400);
    const copyId = Number(m[1]);
    const c = this.deps.db
      .query(
        "SELECT c.id, c.root_id, c.rel_path, c.size, c.duration_s, c.video_codec, c.audio_codec, c.width, c.height, c.r_frame_rate, c.missing_since, v.title FROM copy c JOIN videos v ON v.id = c.video_id WHERE c.id = ?",
      )
      .get(copyId) as CopyRow | null;
    if (!c) return json({ error: "no such copy" }, 404);
    const root = this.deps.roots.get(c.root_id);
    if (c.missing_since || !root || !this.deps.roots.isAvailable(c.root_id)) return json({ error: "copy unavailable" }, 404);
    if (!c.duration_s || c.duration_s <= 0) return json({ error: "the Copy's duration is not known" }, 409);

    const key = `${copyId}:${q}`;
    const arb = arbitrate(
      [...this.byDevice.values()].map((s) => ({ device: s.device, key: s.key })),
      device,
      key,
      MAX_LIVE_STREAMS,
    );
    if (arb.action === "busy") {
      const holders = arb.holders.map((h) => this.byDevice.get(h.device)!);
      return json({ error: "busy", streams: holders.map((s) => ({ device: s.deviceName, title: s.title })) }, 503);
    }
    if (arb.action === "replace") this.stop(device);
    let stream = this.byDevice.get(device);
    if (!stream) {
      stream = this.create(c, q, device, deviceName, join(root.path, c.rel_path));
      this.byDevice.set(device, stream);
      this.ticker ??= setInterval(() => this.tick(), 500);
      (this.ticker as { unref?: () => void }).unref?.();
    }

    if (m[2]) {
      stream.lastAt = Date.now();
      return new Response(vodPlaylist(c.duration_s, q), { headers: { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" } });
    }
    const n = Number(m[3]);
    if (n >= stream.count) return json({ error: "no such segment" }, 404);
    return stream.segment(n, req.signal);
  }

  private create(c: CopyRow, q: LiveQuality, device: string, deviceName: string, input: string): LiveStream {
    const decision = decideTvPlayback(factsOfRow(c), TV_PROFILE);
    const plan = planLive({ durationS: c.duration_s!, width: c.width, height: c.height, videoCodec: c.video_codec, audioCodec: c.audio_codec, sizeBytes: c.size, decision }, q);
    return new LiveStream(`${c.id}:${q}`, device, deviceName, c.title, input, plan, c.duration_s!, this.deps.ffmpeg, this.deps.tmpRoot ?? tmpdir());
  }
}
