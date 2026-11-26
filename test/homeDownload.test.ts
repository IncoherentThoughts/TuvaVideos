// Download from the Home Server (docs/home-server-spec.md §8): the pure checks, the Range-resuming fetch against a stub
// Home Server, the queue's Home Server items (retry, failure classes, scan-in, Unshared data) and migration 0028.
// The two-machine run is test/homeDownloadApp.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openDb } from "../src/server/db";
import { checkFetched, contentRangeStart, fallbackRelPath, fetchHomeCopy, freeRelPath, retryDelayMs, safeRelPath, type HomeSnapshot } from "../src/server/downloads/homeFetch";
import { DownloadQueue, QueueError, type ItemRow, type QueueDeps } from "../src/server/downloads/queue";
import { REASON_WORDS } from "../src/server/downloads/report";
import { applyHomeData } from "../src/server/downloads/service";
import { homeUpstream } from "../src/server/homeProxy";
import { homeDownloadSnapshot, preferredHomeCopy } from "../src/server/homeVideos";
import type { HomeCopyRow, HomeVideoRow, HomeView } from "../src/server/homeServer";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const base = mkdtempSync(join(tmpdir(), "tuva-homedl-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

describe("pure", () => {
  test("safeRelPath keeps a Root-relative path and refuses anything that could leave the Root", () => {
    expect(safeRelPath("Concerts/2019/a.mp4")).toBe("Concerts/2019/a.mp4");
    expect(safeRelPath("./a//b.mp4")).toBe("a/b.mp4");
    expect(safeRelPath("/etc/passwd")).toBe("etc/passwd"); // absolute becomes relative: it can only land inside the Root
    for (const bad of ["../x.mp4", "a/../../x.mp4", "", "..", "a\0b", null, undefined]) expect(safeRelPath(bad as string)).toBeNull();
  });
  test("fallbackRelPath: the title, safe characters, the container's extension", () => {
    expect(fallbackRelPath('A/B: "C"', "mov,mp4,m4a")).toBe("A_B_ _C_.mov");
    expect(fallbackRelPath("", null)).toBe("Video.mp4");
  });
  test("freeRelPath picks the first free name", () => {
    const taken = new Set(["a/x.mp4", "a/x (home).mp4"]);
    expect(freeRelPath("a/x.mp4", (r) => taken.has(r))).toBe("a/x (home 2).mp4");
    expect(freeRelPath("y.mp4", (r) => taken.has(r))).toBe("y.mp4");
  });
  test("checkFetched: size first, then SHA-256 when the Video has one", () => {
    expect(checkFetched({ size: 5, expectedSize: 5 })).toBeNull();
    expect(checkFetched({ size: 4, expectedSize: 5 })?.reason).toBe("size_mismatch");
    expect(checkFetched({ size: 5, expectedSize: 5, hash: "AB", expectedHash: "ab" })).toBeNull();
    expect(checkFetched({ size: 5, expectedSize: 5, hash: "aa", expectedHash: "bb" })?.reason).toBe("hash_mismatch");
    expect(checkFetched({ size: 5, expectedSize: 5, hash: "aa", expectedHash: null })).toBeNull();
  });
  test("retryDelayMs grows and stops at five minutes; contentRangeStart reads the first byte", () => {
    expect([0, 1, 2, 3, 4, 9].map(retryDelayMs)).toEqual([30_000, 30_000, 60_000, 120_000, 300_000, 300_000]);
    expect(contentRangeStart("bytes 100-199/200")).toBe(100);
    expect(contentRangeStart("bytes */200")).toBeNull();
    expect(contentRangeStart(null)).toBeNull();
  });
  test("the proxy allows ?download=1 on the Copy route only", () => {
    expect(homeUpstream("/home/copy/7", "?download=1")).toBe("/copy/7?download=1");
    expect(homeUpstream("/home/copy/7", "")).toBe("/copy/7");
    expect(homeUpstream("/home/copy/7", "?download=1&x=2")).toBe("/copy/7");
    expect(homeUpstream("/home/copy/7", "?download=0")).toBe("/copy/7");
    expect(homeUpstream("/home/api/copies/7", "?download=1")).toBe("/api/copies/7");
    expect(homeUpstream("/home/live/7/index.m3u8", "?download=1")).toBe("/live/7/index.m3u8");
    expect(homeUpstream("/home/api/health", "?download=1")).toBeNull();
  });
  test("the new failure classes have words", () => {
    expect(REASON_WORDS.home_unreachable).toBe("Home Server unreachable");
    expect(REASON_WORDS.size_mismatch).toBe("size mismatch");
    expect(REASON_WORDS.hash_mismatch).toBe("hash mismatch");
  });

  const copy = (id: number, o: Partial<HomeCopyRow> = {}): HomeCopyRow => ({ id, video_id: "r1", youtube_id: null, content_hash: null, size: 100, container: "mp4", video_codec: "h264", audio_codec: "aac", width: 1280, height: 720, duration_s: 60, available: 1, playback: "native", rel_path: `Videos/${id}.mp4`, ...o });
  test("homeDownloadSnapshot: a matched Video keeps its own data; a home_video brings the Home Server's", () => {
    const row: HomeVideoRow = { id: "r2", youtube_id: null, content_hash: "h", shared: 0, title: "Mini title", title_latin: "Mini latin", type: "concert", created_at: "x", thumb: null, chapters: "[]" };
    const view: HomeView = {
      matched: new Map([["l1", [copy(1, { height: 720 }), copy(2, { height: 1080, rel_path: "Big/b.mp4" })]]]),
      homeOnly: [{ row, copies: [copy(3, { video_id: "r2", content_hash: "h" })], chapters: [{ startS: 5, title: "Ch", titleLatin: null }] }],
    };
    const m = homeDownloadSnapshot(view, "l1", "Local title")!;
    expect(m).toMatchObject({ copyId: 2, relPath: "Big/b.mp4", homeOnly: false, title: "Local title", chapters: [] }); // the better Copy
    const h = homeDownloadSnapshot(view, "r2", null)!;
    expect(h).toMatchObject({ copyId: 3, homeOnly: true, title: "Mini title", titleLatin: "Mini latin", type: "concert", contentHash: "h", chapters: [{ startS: 5, title: "Ch", titleLatin: null }] });
    expect(homeDownloadSnapshot(view, "nobody", null)).toBeNull();
    expect(preferredHomeCopy([copy(1), copy(2, { height: 1080 })]).id).toBe(2);
  });
});

// ---- a stub Home Server -------------------------------------------------------------------------------------------

const payload = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 251));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Serves `/copy/:id?download=1` with Range; `dropAfter` cuts the first response short with an error. */
function homeFetch(o: { data?: Buffer; status?: () => number | null; dropAfter?: { n: number }; ranges?: string[]; ignoreRange?: boolean } = {}): typeof fetch {
  const data = o.data ?? payload;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!/^\/copy\/\d+$/.test(url.pathname) || url.search !== "?download=1") return new Response("no", { status: 400 });
    const forced = o.status?.() ?? null;
    if (forced) return new Response(JSON.stringify({ error: "x" }), { status: forced });
    const range = (init?.headers as Record<string, string> | undefined)?.range ?? null;
    if (range) o.ranges?.push(range);
    let start = 0;
    const m = range?.match(/^bytes=(\d+)-$/);
    if (m && !o.ignoreRange) start = Number(m[1]);
    let body = data.subarray(start);
    const headers: Record<string, string> = { "content-type": "video/mp4", "accept-ranges": "bytes" };
    let status = 200;
    if (m && !o.ignoreRange) {
      status = 206;
      headers["content-range"] = `bytes ${start}-${data.length - 1}/${data.length}`;
    }
    const drop = o.dropAfter && o.dropAfter.n > 0 ? o.dropAfter.n : 0;
    if (drop) o.dropAfter!.n = 0;
    let sent = false;
    const stream = new ReadableStream({
      pull(c) {
        if (sent && drop) return c.error(new Error("connection reset"));
        c.enqueue(new Uint8Array(drop ? body.subarray(0, drop) : body));
        sent = true;
        if (!drop) c.close();
      },
    });
    return new Response(stream, { status, headers });
  }) as typeof fetch;
}

describe("fetchHomeCopy", () => {
  const run = (partPath: string, fetchFn: typeof fetch, extra: Partial<Parameters<typeof fetchHomeCopy>[0]> = {}) =>
    fetchHomeCopy({ base: "http://home:4401", copyId: 9, partPath, expectedSize: payload.length, signal: new AbortController().signal, onProgress: () => {}, doFetch: fetchFn, ...extra });

  test("a whole file", async () => {
    const part = join(base, "f1", "a.part");
    const seen: number[] = [];
    const r = await run(part, homeFetch(), { onProgress: (d) => seen.push(d) });
    expect(r).toEqual({ ok: true, bytes: payload.length });
    expect(readFileSync(part).equals(payload)).toBe(true);
    expect(seen.at(-1)).toBe(payload.length);
  });

  test("a drop is unreachable and keeps the partial; the next attempt continues with Range", async () => {
    const part = join(base, "f2", "a.part");
    const ranges: string[] = [];
    const f = homeFetch({ dropAfter: { n: 1200 }, ranges });
    const first = await run(part, f);
    expect(first).toMatchObject({ ok: false, kind: "unreachable" });
    expect(statSync(part).size).toBe(1200);
    const second = await run(part, f);
    expect(second).toEqual({ ok: true, bytes: payload.length });
    expect(ranges).toEqual(["bytes=1200-"]);
    expect(readFileSync(part).equals(payload)).toBe(true);
  });

  test("a server that ignores Range sends the whole file again; it replaces the partial", async () => {
    const part = join(base, "f3", "a.part");
    mkdirSync(join(base, "f3"));
    writeFileSync(part, payload.subarray(0, 700));
    const r = await run(part, homeFetch({ ignoreRange: true }));
    expect(r.ok).toBe(true);
    expect(readFileSync(part).equals(payload)).toBe(true);
  });

  test("a partial that is already whole is not fetched again; a longer one starts over", async () => {
    const whole = join(base, "f4", "a.part");
    mkdirSync(join(base, "f4"));
    writeFileSync(whole, payload);
    expect(await run(whole, (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch)).toEqual({ ok: true, bytes: payload.length });
    const long = join(base, "f4", "b.part");
    writeFileSync(long, Buffer.concat([payload, payload]));
    expect((await run(long, homeFetch())).ok).toBe(true);
    expect(statSync(long).size).toBe(payload.length);
  });

  test("failure kinds: 404 gone, 502 and 503 unreachable, a short body unreachable, no room disk_full", async () => {
    let st: number | null = 404;
    expect(await run(join(base, "f5", "a.part"), homeFetch({ status: () => st }))).toMatchObject({ ok: false, kind: "gone" });
    st = 502;
    expect(await run(join(base, "f5", "a.part"), homeFetch({ status: () => st }))).toMatchObject({ ok: false, kind: "unreachable" });
    st = 503;
    expect(await run(join(base, "f5", "a.part"), homeFetch({ status: () => st }))).toMatchObject({ ok: false, kind: "unreachable" });
    const short = await run(join(base, "f6", "a.part"), homeFetch({ data: payload.subarray(0, 100) }));
    expect(short).toMatchObject({ ok: false, kind: "unreachable" });
    const full = await run(join(base, "f7", "a.part"), homeFetch(), { free: () => 10 });
    expect(full).toMatchObject({ ok: false, kind: "disk_full" });
    expect(await run(join(base, "f8", "a.part"), (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)).toMatchObject({ ok: false, kind: "unreachable" });
  });

  test("a body that stalls counts as a drop", async () => {
    const f = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); } }), { status: 200 })) as unknown as typeof fetch;
    const r = await run(join(base, "f9", "a.part"), f, { stallMs: 50 });
    expect(r).toMatchObject({ ok: false, kind: "unreachable" });
  });

  test("cancelling stops it", async () => {
    const ac = new AbortController();
    const f = (async (_u: unknown, init?: RequestInit) => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); init?.signal?.addEventListener("abort", () => c.error(new Error("aborted"))); } }), { status: 200 })) as unknown as typeof fetch;
    const p = run(join(base, "f10", "a.part"), f, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    expect(await p).toMatchObject({ ok: false, kind: "cancelled" });
  });
});

// ---- the queue ----------------------------------------------------------------------------------------------------

class Clock {
  t = Date.parse("2026-11-26T12:00:00.000Z");
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private n = 0;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const id = ++this.n;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  };
  clearTimer = (h: unknown) => void (this.timers = this.timers.filter((x) => x.id !== h));
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

const snap = (o: Partial<HomeSnapshot> = {}): HomeSnapshot => ({ copyId: 9, relPath: "Concerts/2019/clip.mp4", size: payload.length, contentHash: null, container: "mp4", homeOnly: true, title: "Mini title", titleLatin: "Mini latin", type: "concert", chapters: [{ startS: 10, title: "First", titleLatin: null }], ...o });

function setup(o: { snap?: HomeSnapshot | null; fetchFn?: typeof fetch; scanOk?: boolean; homeUp?: boolean; free?: number | null } = {}) {
  const dir = mkdtempSync(join(base, "q-"));
  const rootDir = join(dir, "root");
  mkdirSync(rootDir);
  const db = openDb(":memory:", MIGRATIONS);
  db.prepare("INSERT INTO root (path, kind) VALUES (?, 'local')").run(rootDir);
  const clock = new Clock();
  const st = { snap: o.snap === undefined ? snap() : o.snap, fetchFn: o.fetchFn ?? homeFetch(), scanned: [] as string[], applied: [] as string[], homeUp: o.homeUp ?? true, free: o.free ?? null, scanOk: o.scanOk ?? true };
  const deps: QueueDeps = {
    db,
    dataDir: join(dir, "data"),
    tools: async () => null,
    probe: async () => true,
    rootFor: (d) => (d === rootDir || d.startsWith(rootDir + "/") ? { id: 1, path: rootDir } : null),
    rootAvailable: () => true,
    defaultRoot: () => ({ id: 1, path: rootDir }),
    scanFile: async (_r, rel) => {
      st.scanned.push(rel);
      return st.scanOk ? { ok: true, videoId: "new-video" } : { ok: false, error: "ffprobe: moov atom not found" };
    },
    homeResolve: () => st.snap,
    homeBase: () => (st.homeUp ? "http://home:4401" : null),
    homeFetch: ((u: RequestInfo | URL, i?: RequestInit) => st.fetchFn(u, i)) as typeof fetch,
    homeFree: () => st.free,
    applyHomeData: (vid) => void st.applied.push(vid),
    now: clock.now,
    random: () => 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };
  const q = new DownloadQueue(deps);
  const item = () => db.query("SELECT * FROM download_item ORDER BY id DESC").get() as ItemRow;
  /** A successful card item is not kept (§4.8): its state is the per-Video map's. */
  const vstate = (id = "remote-1") => (q.snapshot() as unknown as { videos: Record<string, { state: string } | undefined> }).videos[id]?.state;
  const add = (videoId = "remote-1", destDir = rootDir) => q.addCard({ videoId, source: "home", destDir });
  return { dir, rootDir, db, clock, st, q, item, vstate, add, deps };
}

describe("queue: Home Server items", () => {
  test("a Download lands in the Root at the Home Server's rel_path, is scanned, and takes the Home Server's data", async () => {
    const h = setup();
    h.add();
    await h.q.settled();
    expect(h.vstate()).toBe("done");
    expect(readFileSync(join(h.rootDir, "Concerts/2019/clip.mp4")).equals(payload)).toBe(true);
    expect(h.st.scanned).toEqual(["Concerts/2019/clip.mp4"]);
    expect(h.st.applied).toEqual(["new-video"]);
    expect(existsSync(join(h.dir, "data", "downloads"))).toBe(true);
    expect(readdirPart(h.dir)).toEqual([]); // the temp file was moved, not copied
  });

  test("a matched Video does not take the Home Server's data (it has its own)", async () => {
    const h = setup({ snap: snap({ homeOnly: false }) });
    h.add("local-1");
    await h.q.settled();
    expect(h.vstate("local-1")).toBe("done");
    expect(h.st.applied).toEqual([]);
  });

  test("the Home Server unreachable: the item waits, then continues from the partial file with Range", async () => {
    const ranges: string[] = [];
    const h = setup({ fetchFn: homeFetch({ dropAfter: { n: 1500 }, ranges }) });
    h.add();
    await flush();
    expect(h.item()).toMatchObject({ state: "waiting", reason: "home_unreachable" });
    expect(h.item().not_before).toBe(new Date(h.clock.t + 30_000).toISOString());
    await h.clock.advance(31_000);
    await h.q.settled();
    expect(h.vstate()).toBe("done");
    expect(ranges).toEqual(["bytes=1500-"]);
    expect(readFileSync(join(h.rootDir, "Concerts/2019/clip.mp4")).equals(payload)).toBe(true);
  });

  test("no Home Server set (or a 502 from the proxy): waits too", async () => {
    const h = setup({ homeUp: false });
    h.add();
    await flush();
    expect(h.item()).toMatchObject({ state: "waiting", reason: "home_unreachable" });
    h.st.homeUp = true;
    await h.clock.advance(31_000);
    await h.q.settled();
    expect(h.vstate()).toBe("done");
  });

  test("size mismatch fails and leaves nothing in the Root", async () => {
    const h = setup({ snap: snap({ size: payload.length + 10 }), fetchFn: homeFetch({ data: Buffer.concat([payload, Buffer.alloc(20)]) }) });
    h.add();
    await h.q.settled();
    expect(h.item()).toMatchObject({ state: "failed", reason: "size_mismatch" });
    expect(h.st.scanned).toEqual([]);
    expect(existsSync(join(h.rootDir, "Concerts"))).toBe(false);
  });

  test("hash mismatch fails; the right hash passes", async () => {
    const bad = setup({ snap: snap({ contentHash: "0".repeat(64) }) });
    bad.add();
    await bad.q.settled();
    expect(bad.item()).toMatchObject({ state: "failed", reason: "hash_mismatch" });
    expect(bad.st.scanned).toEqual([]);
    const good = setup({ snap: snap({ contentHash: sha(payload) }) });
    good.add();
    await good.q.settled();
    expect(good.vstate()).toBe("done");
  });

  test("disk full pauses the queue and fails the item; 404 is unavailable", async () => {
    const full = setup({ free: 10 });
    full.add();
    await full.q.settled();
    expect(full.item()).toMatchObject({ state: "failed", reason: "disk_full" });
    expect(full.q.isPaused()).toBe(true);
    const gone = setup({ fetchFn: homeFetch({ status: () => 404 }) });
    gone.add();
    await gone.q.settled();
    expect(gone.item()).toMatchObject({ state: "failed", reason: "unavailable" });
  });

  test("a scan that refuses the file fails the item", async () => {
    const h = setup({ scanOk: false });
    h.add();
    await h.q.settled();
    expect(h.item()).toMatchObject({ state: "failed", reason: "unknown", error_line: "ffprobe: moov atom not found" });
  });

  test("a name already taken in the Root is not overwritten", async () => {
    const h = setup();
    mkdirSync(join(h.rootDir, "Concerts/2019"), { recursive: true });
    writeFileSync(join(h.rootDir, "Concerts/2019/clip.mp4"), "other");
    h.add();
    await h.q.settled();
    expect(readFileSync(join(h.rootDir, "Concerts/2019/clip.mp4"), "utf8")).toBe("other");
    expect(h.st.scanned).toEqual(["Concerts/2019/clip (home).mp4"]);
  });

  test("a hostile rel_path cannot leave the Root", async () => {
    const h = setup({ snap: snap({ relPath: "../../escape.mp4", title: "Safe" }) });
    h.add();
    await h.q.settled();
    expect(h.st.scanned).toEqual(["Safe.mp4"]);
    expect(existsSync(join(h.dir, "escape.mp4"))).toBe(false);
  });

  test("destination must be a Root; an unknown Video is refused; cancel removes the partial", async () => {
    const h = setup();
    expect(() => h.add("remote-1", join(h.rootDir, "sub"))).toThrow(QueueError);
    const none = setup({ snap: null });
    expect(() => none.add()).toThrow(/does not have this Video/);
    const slow = setup({ fetchFn: (async (_u: unknown, init?: RequestInit) => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); init?.signal?.addEventListener("abort", () => c.error(new Error("aborted"))); } }), { status: 200 })) as unknown as typeof fetch });
    slow.add();
    await flush();
    expect(slow.item().state).toBe("downloading");
    await slow.q.cancelItem(slow.item().id);
    expect(slow.vstate()).toBeUndefined();
    expect(slow.item()).toBeNull();
    expect(readdirPart(slow.dir)).toEqual([]);
  });
});

function readdirPart(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of require("node:fs").readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith(".part")) out.push(join(d, e.name));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// ---- Unshared data and the migration ------------------------------------------------------------------------------

describe("applyHomeData", () => {
  const mk = (db: ReturnType<typeof openDb>, id: string, createdAt: string, shared = 0) => {
    db.prepare("INSERT INTO videos (id, youtube_id, content_hash, title, created_at, updated_at) VALUES (?, NULL, ?, 'file name', ?, ?)").run(id, `h${id}`, createdAt, createdAt);
    db.prepare("INSERT INTO video_local (video_id, shared) VALUES (?, ?)").run(id, shared);
  };
  const snapshot = snap({ chapters: [{ startS: 10, title: "First", titleLatin: "Persvyi" }, { startS: 30, title: "Second", titleLatin: null }] });

  test("a new Unshared Video takes the titles, Type and Chapters", () => {
    const db = openDb(":memory:", MIGRATIONS);
    mk(db, "v1", "2026-11-26T12:00:05.000Z");
    expect(applyHomeData(db, "v1", snapshot, "2026-11-26T12:00:00.000Z")).toBe(true);
    const v = db.query("SELECT title, title_latin, title_latin_source, type, song_id, version_id FROM videos WHERE id = 'v1'").get() as any;
    expect(v).toMatchObject({ title: "Mini title", title_latin: "Mini latin", title_latin_source: "manual", type: "concert", song_id: null, version_id: null });
    const ch = db.query("SELECT start_s, title, title_latin, suggested, song_id, source FROM video_chapters WHERE video_id = 'v1' ORDER BY start_s").all();
    expect(ch).toEqual([
      { start_s: 10, title: "First", title_latin: "Persvyi", suggested: 0, song_id: null, source: "manual" },
      { start_s: 30, title: "Second", title_latin: null, suggested: 0, song_id: null, source: "manual" },
    ]);
  });

  test("a Video that existed before the run, or a Shared one, is left alone", () => {
    const db = openDb(":memory:", MIGRATIONS);
    mk(db, "old", "2026-01-01T00:00:00.000Z");
    mk(db, "sh", "2026-11-26T12:00:05.000Z", 1);
    expect(applyHomeData(db, "old", snapshot, "2026-11-26T12:00:00.000Z")).toBe(false);
    expect(applyHomeData(db, "sh", snapshot, "2026-11-26T12:00:00.000Z")).toBe(false);
    expect(applyHomeData(db, "missing", snapshot, "2026-11-26T12:00:00.000Z")).toBe(false);
    expect((db.query("SELECT title FROM videos WHERE id = 'old'").get() as any).title).toBe("file name");
  });
});

describe("migration 0028", () => {
  test("source accepts 'home', home_json and home_copy.rel_path exist, the index ETag is dropped, live rows survive", () => {
    const db = openDb(":memory:", MIGRATIONS);
    db.prepare("INSERT INTO download_job (kind, quality, dest_dir, created_at) VALUES ('card', 'best', '/r', 'x')").run();
    for (const src of ["youtube", "instagram", "rutube", "home"]) db.prepare("INSERT INTO download_item (job_id, video_id, source, source_url, title, queue_pos, state, log_path, home_json) VALUES (1, ?, ?, 'u', 't', 1, 'done', 'l', ?)").run(`v-${src}`, src, src === "home" ? "{}" : null);
    expect(() => db.prepare("INSERT INTO download_item (job_id, video_id, source, source_url, title, queue_pos, state, log_path) VALUES (1, 'v-x', 'vimeo', 'u', 't', 1, 'done', 'l')").run()).toThrow();
    db.prepare("INSERT INTO home_copy (id, video_id, size, available, playback, rel_path) VALUES (1, 'r', 1, 1, 'native', 'a/b.mp4')").run();
    expect((db.query("SELECT rel_path FROM home_copy").get() as any).rel_path).toBe("a/b.mp4");
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'download_item_one_live'").get()).not.toBeNull();
    // the live-item index still holds: a second live item of one Video is refused
    db.prepare("INSERT INTO download_item (job_id, video_id, source, source_url, title, queue_pos, state, log_path) VALUES (1, 'live', 'home', 'u', 't', 1, 'queued', 'l')").run();
    expect(() => db.prepare("INSERT INTO download_item (job_id, video_id, source, source_url, title, queue_pos, state, log_path) VALUES (1, 'live', 'home', 'u', 't', 2, 'queued', 'l')").run()).toThrow();
  });

  test("a database at 0027-less state carries its queue across the rebuild", () => {
    const dir = mkdtempSync(join(base, "mig-"));
    const only = join(dir, "m");
    mkdirSync(only);
    const fs = require("node:fs");
    for (const f of fs.readdirSync(MIGRATIONS).filter((x: string) => x < "0028")) fs.copyFileSync(join(MIGRATIONS, f), join(only, f));
    const path = join(dir, "lib.db");
    const old = openDb(path, only);
    old.prepare("INSERT INTO download_job (kind, quality, dest_dir, created_at) VALUES ('card', '720', '/r', 'x')").run();
    old.prepare("INSERT INTO download_item (job_id, video_id, source, source_url, title, queue_pos, state, log_path) VALUES (1, 'v', 'youtube', 'u', 'Kept', 1, 'queued', 'l')").run();
    old.prepare("INSERT INTO download_setting (key, value) VALUES ('home_index_etag', '\"abc\"')").run();
    old.close();
    const db = openDb(path, MIGRATIONS);
    expect(db.query("SELECT title, state, home_json FROM download_item").get()).toEqual({ title: "Kept", state: "queued", home_json: null });
    expect(db.query("SELECT 1 FROM download_setting WHERE key = 'home_index_etag'").get()).toBeNull();
  });
});
