// The Download queue's state machine (downloader-spec §4.1–4.8, §5.4, §9) with a stub runner and an injected clock: the
// backoff tests never sleep. The end-to-end run with the fake yt-dlp and the real scanner is test/downloadQueueApp.test.ts.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import type { FailureReason } from "../src/server/downloads/classify";
import { DownloadQueue, QueueError, type ItemRow, type QueueDeps, type Runner } from "../src/server/downloads/queue";
import { failureReport, localDate, localDateTime, reasonWords, REASON_WORDS } from "../src/server/downloads/report";
import { downloadRoutes } from "../src/server/downloads/routes";
import type { ItemEvent, ItemOutcome } from "../src/server/downloads/runItem";
import { getSetting } from "../src/server/downloads/toolsInstall";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const base = mkdtempSync(join(tmpdir(), "tuva-dlq-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

// ---- clock and timers ------------------------------------------------------------------------------------------

class Clock {
  t = Date.parse("2026-11-08T12:00:00.000Z");
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private n = 0;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const id = ++this.n;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  };
  clearTimer = (h: unknown) => void (this.timers = this.timers.filter((x) => x.id !== h));
  get pending() {
    return this.timers.length;
  }
  /** Moves time forward, firing due timers in order, letting async work settle after each. */
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await flush();
    }
    this.t = target;
  }
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

// ---- stub runner -----------------------------------------------------------------------------------------------

type Beh = { ok: true } | { ok: false; reason: FailureReason; errorLine?: string } | "hang";
class Stub implements Runner {
  plans = new Map<string, Beh[]>();
  sizeFails = new Map<string, { reason: FailureReason; errorLine: string }[]>();
  started: string[] = [];
  killed: string[] = [];
  live = new Map<string, { fin: (o: ItemOutcome) => void; cwd: string }>();
  exact = 1000;
  /** Behaviours for the next runs of a URL (a Video's id is in it); once used up, runs succeed. */
  plan(part: string, ...b: Beh[]) {
    this.plans.set(part, b);
  }
  private pick(url: string): Beh {
    for (const [k, v] of this.plans) if (url.includes(k) && v.length) return v.shift()!;
    return { ok: true };
  }
  size: Runner["size"] = async (spec) => {
    for (const [k, v] of this.sizeFails) if (spec.url.includes(k) && v.length) return { ok: false, ...v.shift()! };
    return { ok: true, sizing: { exactBytes: this.exact, videoCodec: "avc1", mergeFormat: "mp4", durationS: 10 } };
  };
  run: Runner["run"] = (spec, onEvent) => {
    this.started.push(spec.url);
    const b = this.pick(spec.url);
    let resolve!: (o: ItemOutcome) => void;
    const done = new Promise<ItemOutcome>((r) => (resolve = r));
    const file = join(spec.cwd, `Stub [${spec.url.split(/[=/]/).filter(Boolean).pop()}].mp4`);
    const fin = (o: ItemOutcome) => resolve(o);
    if (b === "hang") {
      onEvent({ type: "progress", doneBytes: 250, totalBytes: 1000, speed: 100, eta: 5 } as ItemEvent);
      this.live.set(spec.url, { fin, cwd: spec.cwd });
    } else
      queueMicrotask(() => {
        onEvent({ type: "progress", doneBytes: 1000, totalBytes: 1000, speed: 100, eta: 0 });
        if (b.ok) fin({ ok: true, filePath: file, exitCode: 0 });
        else fin({ ok: false, killed: false, reason: b.reason, errorLine: b.errorLine ?? null, exitCode: 1 });
      });
    return {
      done,
      kill: async () => {
        this.killed.push(spec.url);
        this.live.delete(spec.url);
        resolve({ ok: false, killed: true, reason: "unknown", errorLine: null, exitCode: -1 });
      },
    };
  };
  /** Completes a hanging run. */
  finish(part: string, o: Partial<ItemOutcome> = {}) {
    for (const [url, l] of this.live)
      if (url.includes(part)) {
        this.live.delete(url);
        l.fin({ ok: true, filePath: join(l.cwd, `x [${part}].mp4`), exitCode: 0, ...(o as object) } as ItemOutcome);
      }
  }
}

// ---- harness ---------------------------------------------------------------------------------------------------

let seq = 0;
function setup(extra: Partial<QueueDeps> = {}) {
  const dir = mkdtempSync(join(base, "t-"));
  const rootDir = join(dir, "root");
  const dataDir = join(dir, "data");
  mkdirSync(rootDir);
  const db = openDb(":memory:", MIGRATIONS);
  db.prepare("INSERT INTO root (path, kind) VALUES (?, 'local')").run(rootDir);
  const clock = new Clock();
  const stub = new Stub();
  const state = { mounted: true, copies: new Set<string>(), scanOk: true, scanned: [] as string[], runtime: true, cookies: false, prepared: 0 };
  const deps: QueueDeps = {
    db,
    dataDir,
    runner: stub,
    tools: async () => ({ ytDlpPath: "/fake/yt-dlp", ffmpegLocation: "/fake", jsRuntime: null }),
    beforeJob: async () => void state.prepared++,
    probe: async () => probes.shift() ?? true,
    rootFor: (d) => (d === rootDir || d.startsWith(rootDir + "/") ? { id: 1, path: rootDir } : null),
    rootAvailable: () => state.mounted,
    defaultRoot: () => ({ id: 1, path: rootDir }),
    scanFile: async (_r, rel) => {
      state.scanned.push(rel);
      return state.scanOk ? { ok: true } : { ok: false, error: "ffprobe: moov atom not found" };
    },
    hasCopy: (id) => state.copies.has(id),
    jsRuntimeAvailable: async () => state.runtime,
    instagramCookies: () => state.cookies,
    now: clock.now,
    random: () => 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...extra,
  };
  const probes: boolean[] = [];
  const q = new DownloadQueue(deps);
  /** A fresh queue on the same database, as after a restart. */
  const restart = () => new DownloadQueue(deps);
  let n = 0;
  const video = (source: "youtube" | "instagram" | "rutube" = "youtube") => {
    const i = ++n;
    const id = `vid-${++seq}`;
    const sid = source === "youtube" ? `yt${String(i).padStart(9, "0")}` : source === "instagram" ? `IG${i}` : String(i).padStart(32, "a");
    db.prepare("INSERT INTO videos (id, youtube_id, content_hash, instagram_id, rutube_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'x', 'x')").run(
      id, source === "youtube" ? sid : null, source === "youtube" ? null : `h${id}`, source === "instagram" ? sid : null, source === "rutube" ? sid : null, `Title ${source} ${i}`,
    );
    return { id, sid };
  };
  const vids = (k: number, source: "youtube" | "instagram" | "rutube" = "youtube") => Array.from({ length: k }, () => video(source));
  const bulk = (v: { id: string }[], o: { quality?: string; destDir?: string } = {}) => q.addBulk({ option: "random", quality: o.quality ?? "1080", destDir: o.destDir ?? rootDir, videoIds: v.map((x) => x.id) });
  const items = (jobId?: number) => db.query(`SELECT * FROM download_item ${jobId ? "WHERE job_id = " + jobId : ""} ORDER BY id`).all() as ItemRow[];
  const states = (jobId?: number) => items(jobId).map((i) => i.state);
  const item = (videoId: string) => db.query("SELECT * FROM download_item WHERE video_id = ? ORDER BY id DESC").get(videoId) as ItemRow;
  return { dir, rootDir, dataDir, db, clock, stub, state, q, restart, video, vids, bulk, items, states, item, probes, deps };
}

let h: ReturnType<typeof setup>;
beforeEach(() => {
  h = setup();
});

describe("a job runs", () => {
  test("two slots, queue order, scan-in per file, finished job and throughput", async () => {
    const v = h.vids(3);
    for (const x of v) h.stub.plan(x.sid, "hang");
    h.bulk(v);
    await flush();
    expect(h.stub.started).toHaveLength(2); // two slots
    expect(h.states()).toEqual(["downloading", "downloading", "queued"]);
    expect(h.stub.started[0]).toContain(v[0]!.sid);
    h.clock.t += 10_000;
    h.stub.finish(v[0]!.sid);
    await flush();
    expect(h.stub.started[2]).toContain(v[2]!.sid); // the freed slot goes to the next
    h.clock.t += 10_000;
    h.stub.finish(v[1]!.sid);
    h.stub.finish(v[2]!.sid);
    await h.q.settled();
    expect(h.states()).toEqual(["done", "done", "done"]);
    expect(h.state.scanned).toHaveLength(3);
    expect(h.state.scanned[0]).toMatch(/^x \[yt\d+\]\.mp4$/);
    const job = h.db.query("SELECT * FROM download_job").get() as any;
    expect(job.finished_at).not.toBeNull();
    // Σ bytes ÷ Σ downloading seconds: 3 × 1000 B over (10 + 20 + 10) s
    expect(Number(getSetting(h.db, "last_throughput_bps"))).toBe(75);
    expect(h.state.prepared).toBe(1); // updateYtDlpIfDue once, before the job's first item
  });

  test("progress lands on the row and the snapshot", async () => {
    const [a] = h.vids(1);
    h.stub.plan(a!.sid, "hang");
    h.bulk([a!]);
    await flush();
    const s = h.q.snapshot();
    expect(s.items[0]).toMatchObject({ state: "downloading", doneBytes: 250, exactBytes: 1000, speedBps: 100, etaS: 5 });
    expect((s.videos[a!.id] as any).state).toBe("downloading");
    expect(s.job).toMatchObject({ id: 1, running: true, counts: { running: 1, total: 1 }, doneBytes: 250, totalBytes: 1000 });
  });

  test("skipped: a Copy appeared while the item waited", async () => {
    const v = h.vids(3);
    for (const x of v.slice(0, 2)) h.stub.plan(x.sid, "hang");
    h.bulk(v);
    await flush();
    h.state.copies.add(v[2]!.id); // arrived by other means while queued
    h.stub.finish(v[0]!.sid);
    await flush();
    expect(h.item(v[2]!.id).state).toBe("skipped");
    expect(h.stub.started.some((u) => u.includes(v[2]!.sid))).toBe(false);
    h.stub.finish(v[1]!.sid);
    await h.q.settled();
    expect((h.db.query("SELECT finished_at FROM download_job").get() as any).finished_at).not.toBeNull();
  });

  test("done_outside: a folder outside every Root is not scanned; inside is", async () => {
    const [a, b] = h.vids(2);
    const out = join(h.dir, "elsewhere");
    h.q.addBulk({ option: "random", quality: "720", destDir: out, videoIds: [a!.id] });
    await h.q.settled();
    expect(h.item(a!.id).state).toBe("done_outside");
    expect(h.state.scanned).toEqual([]);
    h.bulk([b!]);
    await h.q.settled();
    expect(h.item(b!.id).state).toBe("done");
    expect(h.state.scanned).toHaveLength(1);
  });

  test("a failed scan-in fails the item as unknown with the probe error", async () => {
    const [a] = h.vids(1);
    h.state.scanOk = false;
    h.bulk([a!]);
    await h.q.settled();
    expect(h.item(a!.id)).toMatchObject({ state: "failed", reason: "unknown", error_line: "ffprobe: moov atom not found" });
  });

  test("a permanent failure fails the item and the rest carry on; Retry failed brings it back, attempts reset", async () => {
    const v = h.vids(3);
    h.stub.plan(v[1]!.sid, { ok: false, reason: "unavailable", errorLine: "Video unavailable" });
    h.bulk(v);
    await h.q.settled();
    expect(h.states()).toEqual(["done", "failed", "done"]);
    expect(h.item(v[1]!.id)).toMatchObject({ reason: "unavailable", error_line: "Video unavailable", attempts: 1 });
    expect(h.q.retryFailed(1)).toBe(1);
    expect(h.item(v[1]!.id)).toMatchObject({ reason: null, error_line: null, attempts: 1 }); // reset to 0, then picked at once
    await h.q.settled();
    expect(h.states()).toEqual(["done", "done", "done"]);
  });

  test("an unknown Video, a hash-only Video and one that has a Copy are rejected, not queued", () => {
    const [a] = h.vids(1);
    h.db.prepare("INSERT INTO videos (id, content_hash, title, created_at, updated_at) VALUES ('hashonly', 'hh', 'No source', 'x', 'x')").run();
    const [c] = h.vids(1);
    h.state.copies.add(c!.id);
    const r = h.q.addBulk({ option: "random", quality: "1080", destDir: h.rootDir, videoIds: [a!.id, "hashonly", "nope", c!.id] });
    expect(r.added).toBe(1);
    expect(r.rejected.map((x) => x.why).sort()).toEqual(["already on this machine", "no source id", "unknown Video"]);
    expect(() => h.q.addBulk({ option: "random", quality: "1080", destDir: h.rootDir, videoIds: ["nope"] })).toThrow(QueueError);
  });
});

describe("pause, cancel", () => {
  test("pause kills what runs (partials kept) and puts it back in line; resume runs it again", async () => {
    const v = h.vids(3);
    for (const x of v) h.stub.plan(x.sid, "hang");
    h.bulk(v);
    await flush();
    await h.q.pause();
    expect(h.stub.killed).toHaveLength(2);
    expect(h.states()).toEqual(["queued", "queued", "queued"]);
    expect(h.items().map((i) => i.attempts)).toEqual([0, 0, 0]); // an interrupted attempt does not count
    expect(getSetting(h.db, "queue_paused")).toBe("1");
    expect(h.q.snapshot().paused).toBe(true);
    await flush();
    expect(h.stub.started).toHaveLength(2); // nothing new starts while paused
    h.q.resume();
    await flush();
    expect(h.stub.started).toHaveLength(5); // v0 and v1 again, then v2
    expect(getSetting(h.db, "queue_paused")).toBe("0");
  });

  test("cancel job: runs killed, queued and running partials deleted, finished files kept, items cancelled", async () => {
    const v = h.vids(3);
    h.stub.plan(v[0]!.sid, { ok: true });
    for (const x of v.slice(1)) h.stub.plan(x.sid, "hang");
    h.bulk(v);
    await flush();
    const f = (name: string) => join(h.rootDir, name);
    const partials = [`T [${v[1]!.sid}].mp4.part`, `T [${v[1]!.sid}].f137.mp4`, `T [${v[1]!.sid}].f251.webm.part`, `T [${v[2]!.sid}].mp4.ytdl`];
    for (const n of partials) writeFileSync(f(n), "p");
    writeFileSync(f(`Done [${v[0]!.sid}].mp4`), "finished");
    writeFileSync(f("Other [zzzzzzzzzzz].mp4.part"), "not ours");
    await h.q.cancelJob(1);
    for (const n of partials) expect(existsSync(f(n))).toBe(false);
    expect(existsSync(f(`Done [${v[0]!.sid}].mp4`))).toBe(true);
    expect(existsSync(f("Other [zzzzzzzzzzz].mp4.part"))).toBe(true);
    expect(h.states()).toEqual(["done", "cancelled", "cancelled"]);
    expect(h.stub.killed).toHaveLength(2);
    const job = h.db.query("SELECT * FROM download_job").get() as any;
    expect(job.cancelled_at).not.toBeNull();
    expect(job.finished_at).not.toBeNull();
    await h.q.settled();
  });

  test("cancel one Video: only its run, its partials; the freed slot goes on", async () => {
    const v = h.vids(3);
    h.stub.plan(v[0]!.sid, "hang");
    h.stub.plan(v[1]!.sid, "hang");
    h.bulk(v);
    await flush();
    writeFileSync(join(h.rootDir, `T [${v[0]!.sid}].mp4.part`), "p");
    await h.q.cancelItem(h.item(v[0]!.id).id);
    expect(existsSync(join(h.rootDir, `T [${v[0]!.sid}].mp4.part`))).toBe(false);
    expect(h.item(v[0]!.id).state).toBe("cancelled");
    await flush();
    expect(h.item(v[2]!.id).state).toBe("done"); // took the free slot
    expect(h.item(v[1]!.id).state).toBe("downloading");
    await expect(h.q.cancelItem(h.item(v[0]!.id).id)).rejects.toThrow(/cancelled/);
    h.stub.finish(v[1]!.sid);
    await h.q.settled();
  });

  test("a queued item can be cancelled too, and the job finishes without it", async () => {
    const v = h.vids(3);
    for (const x of v) h.stub.plan(x.sid, "hang");
    h.bulk(v);
    await flush();
    await h.q.cancelItem(h.item(v[2]!.id).id);
    h.stub.finish(v[0]!.sid);
    h.stub.finish(v[1]!.sid);
    await h.q.settled();
    expect(h.states()).toEqual(["done", "done", "cancelled"]);
    expect((h.db.query("SELECT finished_at FROM download_job").get() as any).finished_at).not.toBeNull();
  });
});

describe("offline", () => {
  test("a network failure requeues, pauses everything as offline, probes 15 s then doubling to 2 min, resumes", async () => {
    const v = h.vids(3);
    h.stub.plan(v[0]!.sid, { ok: false, reason: "network", errorLine: "Unable to download video data: timed out" });
    h.stub.plan(v[1]!.sid, "hang");
    h.bulk(v);
    await flush();
    const s = h.q.snapshot();
    expect(s.offline).not.toBeNull();
    // the failing item and the one that was running beside it both wait; nothing is failed and attempts are unchanged
    expect(h.states()).toEqual(["waiting", "waiting", "queued"]);
    expect(h.items().map((i) => i.attempts)).toEqual([0, 0, 0]);
    expect(h.items()[0]!.reason).toBe("network");
    expect(h.stub.killed).toHaveLength(1);
    const startedBefore = h.stub.started.length;

    // probes: 15 s, 30 s, 60 s, 120 s, 120 s, then success
    h.probes.push(false, false, false, false, false, true);
    let waited = 0;
    for (const gap of [15, 30, 60, 120, 120]) {
      await h.clock.advance((gap - 1) * 1000);
      expect(h.q.snapshot().offline).not.toBeNull();
      expect(h.probes.length).toBeGreaterThan(1); // not probed early
      await h.clock.advance(1000);
      waited += gap;
      expect(h.probes.length).toBe(6 - (waited === 15 ? 1 : waited === 45 ? 2 : waited === 105 ? 3 : waited === 225 ? 4 : 5));
    }
    await h.clock.advance(120_000);
    expect(h.q.snapshot().offline).toBeNull();
    await h.q.settled();
    expect(h.stub.started.length).toBeGreaterThan(startedBefore);
    expect(h.states()).toEqual(["done", "done", "done"]);
  });

  test("while offline new jobs wait and nothing starts", async () => {
    const [a, b] = h.vids(2);
    h.stub.plan(a!.sid, { ok: false, reason: "network", errorLine: "Got error" });
    h.bulk([a!]);
    await flush();
    const n = h.stub.started.length;
    h.bulk([b!]);
    await flush();
    expect(h.stub.started.length).toBe(n);
    expect(h.item(b!.id).state).toBe("queued");
  });
});

describe("per-site backoff", () => {
  test("429: the site pauses 1, 5, 10 min and the third rate limit on the item fails it; other sites carry on", async () => {
    const [yt] = h.vids(1);
    const [rt] = h.vids(1, "rutube");
    const rl = { ok: false, reason: "rate_limited", errorLine: "HTTP Error 429: Too Many Requests" } as const;
    h.stub.plan(yt!.sid, rl, rl, rl);
    h.bulk([yt!, rt!]);
    await flush();
    expect(h.item(rt!.id).state).toBe("done"); // another site is not held
    expect(h.item(yt!.id)).toMatchObject({ state: "waiting", reason: "rate_limited" });
    expect(h.q.snapshot().sitePauses).toEqual([{ site: "youtube", until: new Date(h.clock.t + 60_000).toISOString() }]);
    expect(h.stub.started.filter((u) => u.includes(yt!.sid))).toHaveLength(1);

    await h.clock.advance(59_000);
    expect(h.stub.started.filter((u) => u.includes(yt!.sid))).toHaveLength(1);
    await h.clock.advance(2_000);
    await flush();
    expect(h.stub.started.filter((u) => u.includes(yt!.sid))).toHaveLength(2); // retried after 1 min
    expect(Date.parse(h.q.snapshot().sitePauses[0]!.until) - h.clock.t).toBeGreaterThan(4 * 60_000 + 55_000); // 5 min
    await h.clock.advance(5 * 60_000 - 1000 - 1000);
    expect(h.stub.started.filter((u) => u.includes(yt!.sid))).toHaveLength(2);
    await h.clock.advance(3_000);
    await flush();
    // the third 429 on the same item: failed as rate_limited, and the site rests another 10 min
    expect(h.stub.started.filter((u) => u.includes(yt!.sid))).toHaveLength(3);
    expect(h.item(yt!.id)).toMatchObject({ state: "failed", reason: "rate_limited" });
    const left = Date.parse(h.q.snapshot().sitePauses[0]!.until) - h.clock.t;
    expect(left).toBeGreaterThan(9 * 60_000);
    expect(left).toBeLessThanOrEqual(10 * 60_000);
  });

  test("YouTube's sign-in check counts as a rate limit; a success resets the site's backoff", async () => {
    const v = h.vids(2);
    h.stub.plan(v[0]!.sid, { ok: false, reason: "youtube_signin", errorLine: "Sign in to confirm you're not a bot" });
    h.bulk([v[0]!]);
    await flush();
    expect(h.item(v[0]!.id)).toMatchObject({ state: "waiting", reason: "rate_limited" });
    await h.clock.advance(61_000);
    await h.q.settled();
    expect(h.item(v[0]!.id).state).toBe("done");
    // success reset the strikes: the next limit is a 1 min pause again
    h.stub.plan(v[1]!.sid, { ok: false, reason: "rate_limited", errorLine: "429" });
    h.bulk([v[1]!]);
    await flush();
    expect(Date.parse(h.q.snapshot().sitePauses[0]!.until) - h.clock.t).toBe(60_000);
  });
});

describe("disk full", () => {
  test("fails the item, pauses the queue with the folder named; Resume goes again", async () => {
    const v = h.vids(3);
    h.stub.plan(v[0]!.sid, { ok: false, reason: "disk_full", errorLine: "[Errno 28] No space left on device" });
    h.stub.plan(v[1]!.sid, "hang");
    h.bulk(v);
    await flush();
    expect(h.item(v[0]!.id)).toMatchObject({ state: "failed", reason: "disk_full" });
    const s = h.q.snapshot();
    expect(s.paused).toBe(true);
    expect(s.diskFull).toEqual({ dir: h.rootDir });
    expect(h.item(v[1]!.id).state).toBe("queued"); // the other run was stopped, partials kept
    expect(h.item(v[2]!.id).state).toBe("queued");
    expect(h.stub.started.some((u) => u.includes(v[2]!.sid))).toBe(false);
    h.q.resume();
    await h.q.settled();
    expect(h.q.snapshot().diskFull).toBeNull();
    expect(h.states()).toEqual(["done", "done", "done"]);
  });
});

describe("Instagram", () => {
  test("one at a time, with a 3 s pause (random 0) before the next", async () => {
    const ig = h.vids(3, "instagram");
    for (const x of ig) h.stub.plan(x.sid, "hang");
    const [yt] = h.vids(1);
    h.bulk([...ig, yt!]);
    await flush();
    // two slots: the first Instagram item and the YouTube one behind the other two Instagram items
    expect(h.stub.started.filter((u) => u.includes("instagram.com"))).toHaveLength(1);
    expect(h.item(yt!.id).state).toBe("done");
    h.stub.finish(ig[0]!.sid);
    await flush();
    expect(h.stub.started.filter((u) => u.includes("instagram.com"))).toHaveLength(1); // paused
    await h.clock.advance(2_900);
    expect(h.stub.started.filter((u) => u.includes("instagram.com"))).toHaveLength(1);
    await h.clock.advance(200);
    await flush();
    expect(h.stub.started.filter((u) => u.includes("instagram.com"))).toHaveLength(2);
    h.stub.finish(ig[1]!.sid);
    await h.clock.advance(3_100);
    h.stub.finish(ig[2]!.sid);
    await h.q.settled();
  });

  test("the pause is random 3 to 8 s", async () => {
    const x = setup({ random: () => 0.999 });
    const ig = x.vids(2, "instagram");
    x.stub.plan(ig[0]!.sid, { ok: true });
    x.bulk(ig);
    await flush();
    await x.clock.advance(7_900);
    expect(x.stub.started).toHaveLength(1);
    await x.clock.advance(300);
    await flush();
    expect(x.stub.started).toHaveLength(2);
  });

  test("a login wall without cookies: that item fails, the rest of the job's Instagram items are marked needs sign-in, untried", async () => {
    const ig = h.vids(4, "instagram");
    const [yt] = h.vids(1);
    h.stub.plan(ig[0]!.sid, { ok: false, reason: "login_wall", errorLine: "Instagram sent an empty media response" });
    h.bulk([ig[0]!, yt!, ig[1]!, ig[2]!, ig[3]!]);
    await h.q.settled();
    expect(h.item(ig[0]!.id)).toMatchObject({ state: "failed", reason: "login_wall" });
    for (const x of ig.slice(1)) expect(h.item(x.id)).toMatchObject({ state: "failed", reason: "needs_signin" });
    expect(h.item(yt!.id).state).toBe("done");
    expect(h.stub.started.filter((u) => u.includes("instagram.com"))).toHaveLength(1);
    // Retry failed re-runs them all
    expect(h.q.retryFailed(1)).toBe(4);
    await h.clock.advance(10_000);
    await h.q.settled();
    await h.clock.advance(10_000);
    await h.q.settled();
    expect(h.states().filter((s) => s === "done").length).toBeGreaterThanOrEqual(2);
  });

  test("with cookies configured a login wall fails only that item (the retry with cookies is ticket #205)", async () => {
    h.state.cookies = true;
    const ig = h.vids(2, "instagram");
    h.stub.plan(ig[0]!.sid, { ok: false, reason: "login_wall", errorLine: "empty media response" });
    h.bulk(ig);
    await h.q.settled();
    await h.clock.advance(10_000);
    await h.q.settled();
    expect(h.states()).toEqual(["failed", "done"]);
  });
});

describe("JavaScript runtime", () => {
  test("waits until a runtime exists, then goes once more; a second miss fails", async () => {
    const [a, b] = h.vids(2);
    const miss = { ok: false, reason: "no_js_runtime", errorLine: "Signature extraction failed" } as const;
    h.state.runtime = false;
    h.stub.plan(a!.sid, miss, miss);
    h.stub.plan(b!.sid, miss, miss);
    h.bulk([a!, b!]);
    await flush();
    expect(h.states()).toEqual(["waiting", "waiting"]);
    await h.clock.advance(65_000);
    expect(h.states()).toEqual(["waiting", "waiting"]);
    h.state.runtime = true;
    await h.clock.advance(31_000);
    await h.q.settled();
    expect(h.states()).toEqual(["failed", "failed"]); // went once more, missed again
    expect(h.item(a!.id).reason).toBe("no_js_runtime");
  });

  test("with a runtime present the failure gets one immediate retry", async () => {
    const [a] = h.vids(1);
    h.stub.plan(a!.sid, { ok: false, reason: "no_js_runtime", errorLine: "n challenge solving failed" });
    h.bulk([a!]);
    await h.q.settled();
    expect(h.item(a!.id).state).toBe("done");
    expect(h.stub.started).toHaveLength(2);
  });
});

describe("restart and resume (§4.7)", () => {
  test("live items go back to queued, nothing starts, the prompt reports what is left; Resume runs it", async () => {
    const v = h.vids(4);
    h.stub.plan(v[0]!.sid, { ok: true });
    h.stub.plan(v[1]!.sid, "hang");
    h.stub.plan(v[2]!.sid, "hang");
    h.bulk(v);
    await flush();
    expect(h.states()).toEqual(["done", "downloading", "downloading", "queued"]);
    // the process dies here: the old queue is simply dropped
    const stub2 = new Stub();
    h.deps.runner = stub2;
    const q2 = h.restart();
    expect(h.states()).toEqual(["done", "queued", "queued", "queued"]);
    expect(h.items().map((i) => i.speed_bps)).toEqual([null, null, null, null]);
    const s = q2.snapshot();
    expect(s.started).toBe(false);
    expect(s.resumePrompt).toEqual({ jobId: 1, left: 3, estBytes: 1500, waitingForRoot: null });
    q2.tick();
    await flush();
    expect(stub2.started).toEqual([]); // the runner starts nothing on its own
    q2.resume();
    await q2.settled();
    expect(stub2.started).toHaveLength(3);
    expect(h.states()).toEqual(["done", "done", "done", "done"]);
    expect(q2.snapshot().resumePrompt).toBeNull();
  });

  test("an unmounted Root holds it: the prompt says so and Resume is refused until it is back", async () => {
    const v = h.vids(2);
    h.stub.plan(v[0]!.sid, "hang");
    h.bulk(v);
    await flush();
    h.state.mounted = false;
    h.deps.runner = new Stub();
    const q2 = h.restart();
    expect(q2.snapshot().resumePrompt).toMatchObject({ left: 1, waitingForRoot: h.rootDir });
    expect(() => q2.resume()).toThrow(/waiting for/);
    h.state.mounted = true;
    q2.resume();
    await q2.settled();
    expect(h.states()).toEqual(["done", "done"]);
  });

  test("Discard cancels the job and deletes its partials", async () => {
    const v = h.vids(2);
    for (const x of v) h.stub.plan(x.sid, "hang");
    h.bulk(v);
    await flush();
    writeFileSync(join(h.rootDir, `T [${v[0]!.sid}].mp4.part`), "p");
    h.deps.runner = new Stub();
    const q2 = h.restart();
    await q2.cancelJob(1);
    expect(existsSync(join(h.rootDir, `T [${v[0]!.sid}].mp4.part`))).toBe(false);
    expect(h.states()).toEqual(["cancelled", "cancelled"]);
    expect(q2.snapshot().resumePrompt).toBeNull();
  });

  test("a card click while the prompt is open adds its job of one first and starts the runner, which resumes the old job too", async () => {
    const v = h.vids(2);
    h.stub.plan(v[0]!.sid, "hang");
    h.bulk(v);
    await flush();
    const stub2 = new Stub();
    h.deps.runner = stub2;
    const q2 = h.restart();
    const [card] = h.vids(1);
    q2.addCard({ videoId: card!.id });
    await q2.settled();
    expect(stub2.started).toHaveLength(2); // the card, then the item the old job had left
    expect(stub2.started[0]).toContain(card!.sid); // front of the queue
    expect(h.states()).toEqual(["done", "done"]);
    expect(q2.snapshot().resumePrompt).toBeNull();
  });

  test("a persisted pause survives the restart; Resume clears it", async () => {
    const v = h.vids(1);
    h.bulk(v);
    await h.q.pause();
    const q2 = h.restart();
    expect(q2.snapshot().paused).toBe(true);
    q2.resume();
    await q2.settled();
    expect(h.states()).toEqual(["done"]);
  });

  test("shutdown (the quit guard's kill) keeps the partials and queues the items", async () => {
    const v = h.vids(2);
    for (const x of v) h.stub.plan(x.sid, "hang");
    h.bulk(v);
    await flush();
    writeFileSync(join(h.rootDir, `T [${v[0]!.sid}].mp4.part`), "p");
    expect(h.q.runningCount()).toBe(2);
    expect(await h.q.killAll()).toBe(2);
    expect(h.stub.killed).toHaveLength(2);
    expect(h.states()).toEqual(["queued", "queued"]);
    expect(existsSync(join(h.rootDir, `T [${v[0]!.sid}].mp4.part`))).toBe(true);
  });
});

describe("one live item per Video, the card, retention (§4.1, §4.8)", () => {
  test("a Video already queued in another job moves into the new one; a running one stays where it is", async () => {
    const v = h.vids(4);
    h.stub.plan(v[0]!.sid, "hang");
    h.stub.plan(v[1]!.sid, "hang");
    h.bulk(v); // job 1: two running, v2 and v3 queued
    await flush();
    const r = h.bulk([v[0]!, v[2]!]); // job 2
    expect(r).toMatchObject({ added: 0, moved: 1, alreadyRunning: 1 });
    expect(h.item(v[2]!.id).job_id).toBe(r.jobId);
    expect((h.db.query("SELECT COUNT(*) AS n FROM download_item WHERE video_id = ?").get(v[2]!.id) as any).n).toBe(1);
    expect(h.item(v[0]!.id).job_id).toBe(1);
    h.stub.finish(v[0]!.sid);
    h.stub.finish(v[1]!.sid);
    await h.q.settled();
  });

  test("a card click goes to the front with min - 1; a card for a live item moves it to the front", async () => {
    const v = h.vids(4);
    h.stub.plan(v[0]!.sid, "hang");
    h.stub.plan(v[1]!.sid, "hang");
    h.bulk(v);
    await flush();
    const min = (h.db.query("SELECT MIN(queue_pos) AS m FROM download_item WHERE state = 'queued'").get() as any).m;
    const [c] = h.vids(1);
    h.q.addCard({ videoId: c!.id });
    expect(h.item(c!.id).queue_pos).toBe(h.item(v[0]!.id).queue_pos - 1); // min over the live items, running ones included
    expect(h.item(c!.id).queue_pos).toBeLessThan(min);
    expect(h.item(c!.id).queue_pos).toBeLessThan(min);
    const r = h.q.addCard({ videoId: v[3]!.id });
    expect(r.moved).toBe(true);
    expect(h.item(v[3]!.id).queue_pos).toBeLessThan(h.item(c!.id).queue_pos);
    const s = h.q.snapshot();
    expect((s.videos[v[3]!.id] as any).rank).toBe(1);
    expect((s.videos[c!.id] as any).rank).toBe(2);
    h.stub.finish(v[0]!.sid);
    h.stub.finish(v[1]!.sid);
    await h.q.settled();
  });

  test("a card job is deleted when it succeeds (the card still sees 'done' for a moment); a failed one stays until Retry or Dismiss", async () => {
    const [a, b] = h.vids(2);
    h.stub.plan(b!.sid, { ok: false, reason: "private", errorLine: "Private video" });
    h.q.addCard({ videoId: a!.id });
    await h.q.settled();
    expect(h.db.query("SELECT * FROM download_job").all()).toHaveLength(0);
    expect(h.db.query("SELECT * FROM download_item").all()).toHaveLength(0);
    expect(existsSync(join(h.dataDir, "downloads", "1"))).toBe(false);
    expect((h.q.snapshot().videos[a!.id] as any).state).toBe("done");
    await h.clock.advance(31_000);
    expect(h.q.snapshot().videos[a!.id]).toBeUndefined();

    h.q.addCard({ videoId: b!.id });
    await h.q.settled();
    const failed = h.item(b!.id);
    expect(failed.state).toBe("failed");
    expect((h.q.snapshot().videos[b!.id] as any).reason).toBe("private");
    expect(h.q.itemLog(failed.id, 200).errorAt).toBeGreaterThanOrEqual(-1);
    h.q.retryItem(failed.id);
    await h.q.settled();
    expect(h.db.query("SELECT * FROM download_job").all()).toHaveLength(0); // succeeded: gone

    // dismissal
    h.stub.plan(b!.sid, { ok: false, reason: "private", errorLine: "Private video" });
    h.q.addCard({ videoId: b!.id });
    await h.q.settled();
    h.q.dismissItem(h.item(b!.id).id);
    expect(h.db.query("SELECT * FROM download_job").all()).toHaveLength(0);
  });

  test("a bulk Confirm deletes older finished bulk jobs (rows and logs); an unfinished one stays", async () => {
    const [a, b, c] = h.vids(3);
    h.bulk([a!]);
    await h.q.settled();
    const dir1 = join(h.dataDir, "downloads", "1");
    mkdirSync(dir1, { recursive: true });
    writeFileSync(join(dir1, "marker"), "x");
    expect(existsSync(dir1)).toBe(true);
    h.stub.plan(b!.sid, "hang");
    h.bulk([b!]);
    await flush();
    expect(h.db.query("SELECT id FROM download_job ORDER BY id").all()).toEqual([{ id: 2 }]); // job 1 gone
    expect(existsSync(dir1)).toBe(false);
    h.bulk([c!]); // job 2 is still running: kept
    expect((h.db.query("SELECT id FROM download_job ORDER BY id").all() as any[]).map((r) => r.id)).toEqual([2, 3]);
    h.stub.finish(b!.sid);
    await h.q.settled();
    expect(h.q.snapshot().lastBulkJobId).toBe(3);
  });

  test("a card job does not count as the 'latest bulk job'", async () => {
    const [a, c] = h.vids(2);
    h.bulk([a!]);
    await h.q.settled();
    h.q.addCard({ videoId: c!.id });
    await h.q.settled();
    expect(h.db.query("SELECT kind FROM download_job").all()).toEqual([{ kind: "bulk" }]);
  });
});

describe("the log and the Failure report (§6, §9)", () => {
  test("the report lists exactly the failed Videos, in the spec's words, and Retry failed updates it", async () => {
    const v = h.vids(4);
    h.stub.plan(v[0]!.sid, { ok: false, reason: "unavailable", errorLine: "[youtube] x: Video unavailable" });
    h.stub.plan(v[1]!.sid, { ok: false, reason: "geo", errorLine: "The uploader has not made this video available in your country" });
    h.bulk(v, { quality: "720" });
    await h.q.settled();
    const job = h.db.query("SELECT created_at FROM download_job").get() as any;
    const r = h.q.report(1);
    expect(r.fileName).toBe(`TuvaVideos failed downloads ${localDate(job.created_at)}.txt`);
    const t1 = h.item(v[0]!.id);
    const t2 = h.item(v[1]!.id);
    expect(r.text).toBe(
      [
        "TuvaVideos — failed downloads",
        `Job of ${localDateTime(job.created_at)} · 720p · into ${h.rootDir}`,
        "2 of 4 Videos failed",
        "",
        t1.title,
        `  ${t1.source_url}`,
        "  unavailable — [youtube] x: Video unavailable",
        "",
        t2.title,
        `  ${t2.source_url}`,
        "  not available in your country — The uploader has not made this video available in your country",
        "",
      ].join("\n"),
    );
    h.q.retryFailed(1);
    await h.q.settled();
    expect(h.q.report(1).text).toContain("0 of 4 Videos failed");
  });

  test("reason words cover every class", () => {
    expect(Object.values(REASON_WORDS).sort()).toEqual(
      ["unavailable", "private", "not available in your country", "login wall or removed post", "private: follow required", "cookies expired", "needs sign-in", "rate limited", "rate limited", "disk full", "network", "no JavaScript runtime", "unknown error"].sort(),
    );
    expect(reasonWords(null)).toBe("unknown error");
    expect(reasonWords("something new")).toBe("unknown error");
    const t = failureReport({ createdAt: "2026-11-08T21:14:00Z", quality: "best", destDir: "/x" }, 1, [{ title: "T", sourceUrl: "u", reason: "needs_signin", errorLine: null }]);
    expect(t).toContain("  needs sign-in\n");
    expect(t).toContain("best quality");
  });

  test("log lines come by cursor, across items; a stale cursor resets", async () => {
    const v = h.vids(2);
    h.bulk(v);
    await h.q.settled();
    const it = h.items();
    mkdirSync(join(h.dataDir, "downloads", "1"), { recursive: true });
    writeFileSync(it[0]!.log_path, "TUVA downloading 1 2 NA 3 4\nERROR: boom\n");
    writeFileSync(it[1]!.log_path, "second\n");
    const a = h.q.snapshot({ logCursor: 0 }).log;
    expect(a.lines.map((l) => l.text)).toEqual(["TUVA downloading 1 2 NA 3 4", "ERROR: boom", "second"]);
    expect(a.cursor).toBe(3);
    writeFileSync(it[1]!.log_path, "second\nthird\npartial no newline");
    const b = h.q.snapshot({ logCursor: a.cursor }).log;
    expect(b.lines.map((l) => l.text)).toEqual(["third"]);
    expect(b.cursor).toBe(4);
    const c = h.q.snapshot({ logCursor: 999 }).log;
    expect(c.reset).toBe(true);
    expect(c.lines).toHaveLength(4);
    expect(h.q.itemLog(it[0]!.id, 200)).toMatchObject({ errorAt: 1 });
  });
});

describe("routes (§6)", () => {
  const call = (path: string, init: RequestInit & { origin?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "localhost:4400");
    if (init.origin) headers.set("origin", init.origin);
    return downloadRoutes(new Request(`http://localhost:4400${path}`, { ...init, headers }), new URL(`http://localhost:4400${path}`), h.q);
  };
  const post = (path: string, body?: unknown, origin?: string) => call(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), origin });

  test("jobs, snapshot, pause/resume, report, items: the whole surface", async () => {
    const v = h.vids(3);
    h.stub.plan(v[0]!.sid, { ok: false, reason: "private", errorLine: "Private video" });
    h.stub.plan(v[1]!.sid, "hang");
    const res = (await post("/api/downloads/jobs", { option: "random", quality: "1080p", destDir: h.rootDir, videoIds: v.map((x) => x.id) }, "http://localhost:4400"))!;
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ jobId: 1, added: 3 });
    await flush();
    const snap = await (await call("/api/downloads"))!.json();
    expect(snap.job.id).toBe(1);
    expect(snap.items).toHaveLength(3);
    expect((await post("/api/downloads/pause"))!.status).toBe(200);
    expect((await (await call("/api/downloads"))!.json()).paused).toBe(true);
    expect((await post("/api/downloads/resume"))!.status).toBe(200);
    await flush();
    const rep = (await call("/api/downloads/jobs/1/report.txt"))!;
    expect(rep.headers.get("content-disposition")).toMatch(/^attachment; filename="TuvaVideos failed downloads \d{4}-\d\d-\d\d\.txt"$/);
    expect(await rep.text()).toContain("1 of 3 Videos failed");
    const failed = h.item(v[0]!.id);
    expect((await post(`/api/downloads/items/${failed.id}/retry`))!.status).toBe(200);
    expect((await post(`/api/downloads/items/${failed.id}/retry`))!.status).toBe(409);
    const log = await (await call(`/api/downloads/items/${failed.id}/log?tail=5`))!.json();
    expect(log).toHaveProperty("lines");
    expect((await post("/api/downloads/jobs/1/retry-failed"))!.status).toBe(200);
    expect((await post("/api/downloads/jobs/99/cancel"))!.status).toBe(404);
    expect((await post("/api/downloads/jobs/1/cancel"))!.status).toBe(200);
    expect((await post("/api/downloads/items/99/dismiss"))!.status).toBe(404);
  });

  test("refusals: a foreign Host or Origin, bad bodies; other tickets' paths are not answered", async () => {
    const bad = await downloadRoutes(new Request("http://evil.example/api/downloads", { headers: { host: "evil.example" } }), new URL("http://evil.example/api/downloads"), h.q);
    expect(bad!.status).toBe(403);
    expect((await post("/api/downloads/pause", undefined, "http://evil.example"))!.status).toBe(403);
    expect((await post("/api/downloads/jobs", { option: "x", quality: "1080", destDir: h.rootDir, videoIds: ["a"] }))!.status).toBe(400);
    expect((await post("/api/downloads/jobs", { option: "random", quality: "4k", destDir: h.rootDir, videoIds: ["a"] }))!.status).toBe(400);
    expect((await post("/api/downloads/jobs", { option: "random", quality: "720", destDir: "relative/dir", videoIds: ["a"] }))!.status).toBe(400);
    expect((await post("/api/downloads/card", { videoId: "nope" }))!.status).toBe(404);
    for (const p of ["/api/downloads/plan", "/api/downloads/settings", "/api/downloads/tools", "/api/choose-folder"]) expect(await call(p, { method: p.endsWith("plan") ? "POST" : "GET" })).toBeNull();
  });

  test("an unmounted destination Root is refused", async () => {
    const [a] = h.vids(1);
    h.state.mounted = false;
    const r = (await post("/api/downloads/jobs", { option: "random", quality: "720", destDir: h.rootDir, videoIds: [a!.id] }))!;
    expect(r.status).toBe(409);
  });
});

describe("before a job starts", () => {
  test("the yt-dlp self-update runs before the first item, and a missing yt-dlp fails the item plainly", async () => {
    const x = setup({ tools: async () => null });
    const [a] = x.vids(1);
    x.bulk([a!]);
    await x.q.settled();
    expect(x.state.prepared).toBe(1);
    expect(x.item(a!.id)).toMatchObject({ state: "failed", reason: "unknown", error_line: "yt-dlp is not installed" });
  });
});

