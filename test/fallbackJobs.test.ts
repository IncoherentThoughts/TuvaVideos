// The Fallback and keyframe job lifecycle (audit PLAY-2..5, PLAY-7, PLAY-9, PLAY-12, DB-12): per-job temp files, a
// result thrown away when its Copy changed, a stall watchdog, play preempting a scan-time job, shutdown killing the
// job, a vanished Fallback rebuilt, and remux/ swept of debris. ffmpeg and ffprobe are small shell stand-ins whose
// timing the test controls through files next to them.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { FallbackQueue, KEEPS_CHANGING, MAX_CHANGED_RUNS } from "../src/server/fallback";
import { KeyframeIndex } from "../src/server/keyframes";
import { serveFile } from "../src/server/stream";
import { sleep } from "../src/server/proc";
import { insertCopy, insertVideo } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Prints ffmpeg-style progress every 0.1 s for `delay` tenths of a second (silent when `quiet` exists), then writes the
// output file (its last argument).
const FAKE_FFMPEG = `#!/bin/sh
here=$(dirname "$0")
for out; do :; done
: > "$out"
n=$(cat "$here/delay" 2>/dev/null || echo 0)
i=0
while [ "$i" -lt "$n" ]; do
  [ -e "$here/quiet" ] || echo "out_time_us=$((i * 100000))"
  sleep 0.1
  i=$((i + 1))
done
echo fallback > "$out"
echo progress=end
`;

// ffprobe -show_entries packet=...: two keyframes, after `delay` tenths of a second.
const FAKE_FFPROBE = `#!/bin/sh
here=$(dirname "$0")
n=$(cat "$here/delay" 2>/dev/null || echo 0)
i=0
while [ "$i" -lt "$n" ]; do sleep 0.1; i=$((i + 1)); done
echo "0.000000,0.000000,K__"
echo "2.000000,2.000000,K__"
`;

function setup(copies = 1, opts: { stallMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tuva-fbjobs-"));
  dirs.push(dir);
  const lib = join(dir, "lib");
  const bin = join(dir, "bin");
  const remuxDir = join(dir, "remux");
  mkdirSync(lib);
  mkdirSync(bin);
  writeFileSync(join(bin, "ffmpeg"), FAKE_FFMPEG, { mode: 0o755 });
  writeFileSync(join(bin, "ffprobe"), FAKE_FFPROBE, { mode: 0o755 });
  const db = openDb(":memory:", MIGRATIONS);
  db.query("INSERT INTO root (id, path, kind) VALUES (1, ?, 'local')").run(lib);
  for (let i = 1; i <= copies; i++) {
    insertVideo(db, { id: i, content_hash: `h${i}`, title: `T${i}`, created_at: "x" });
    insertCopy(db, { id: i, video_id: i, root_id: 1, rel_path: `v${i}.mkv`, size: 10, mtime: "m", playback: "transcode", duration_s: 10 });
    writeFileSync(join(lib, `v${i}.mkv`), "source");
  }
  const cfg = { ffmpeg: join(bin, "ffmpeg"), ffprobe: join(bin, "ffprobe"), remuxDir };
  const q = new FallbackQueue(db, cfg, () => true, { stallMs: opts.stallMs ?? 10_000 });
  const delay = (tenths: number) => writeFileSync(join(bin, "delay"), String(tenths));
  const quiet = () => writeFileSync(join(bin, "quiet"), "");
  return { dir, lib, bin, remuxDir, db, cfg, q, delay, quiet };
}

async function until(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await sleep(20);
  }
}

const fallbackFile = (db: any, id: number) => (db.query("SELECT fallback_file FROM copy WHERE id = ?").get(id) as { fallback_file: string | null } | null)?.fallback_file;

describe("Fallback jobs", () => {
  test("a finished job is recorded under <id>.<ext>, through a per-process temp name", async () => {
    const { q, db, remuxDir, delay } = setup();
    delay(5);
    q.request(1, "scan");
    await until(() => readdirSync(remuxDir).length > 0);
    const tmp = readdirSync(remuxDir);
    expect(tmp.length).toBe(1);
    expect(tmp[0]).toMatch(new RegExp(`^1\\.${process.pid}\\.[0-9a-f]{8}\\.tmp\\.mkv$`));
    await until(() => q.status(1).state === "ready");
    expect(fallbackFile(db, 1)).toBe("1.mkv");
    expect(readdirSync(remuxDir)).toEqual(["1.mkv"]);
  });

  test("a Copy that changed while its job ran gets no stale result; the job runs again over the new file (PLAY-3)", async () => {
    const { q, db, remuxDir, delay } = setup();
    delay(5);
    q.request(1, "scan");
    await until(() => q.status(1).state === "preparing");
    db.query("UPDATE copy SET size = 20, mtime = 'm2' WHERE id = 1").run(); // what a rescan does for a replaced file
    delay(1);
    await until(() => fallbackFile(db, 1) != null, 8000);
    expect(fallbackFile(db, 1)).toBe("1.mkv");
    expect(readdirSync(remuxDir)).toEqual(["1.mkv"]);
  });

  test("a Copy that keeps changing (still being written) gives up after MAX_CHANGED_RUNS runs; a new request retries", async () => {
    const { q, db, remuxDir, delay } = setup();
    delay(3);
    q.request(1, "scan");
    for (let run = 1; run <= MAX_CHANGED_RUNS; run++) {
      await until(() => q.status(1).state === "preparing" && (q as any).current?.changedRuns === (run === 1 ? undefined : run - 1));
      db.query("UPDATE copy SET size = ?, mtime = ? WHERE id = 1").run(10 + run, `m${run}`); // the download grew
      if (run < MAX_CHANGED_RUNS) await until(() => (q as any).current?.changedRuns === run, 4000);
    }
    await until(() => q.status(1).state === "failed", 4000);
    expect(q.status(1).error).toBe(KEEPS_CHANGING);
    expect(fallbackFile(db, 1)).toBeNull();
    expect(readdirSync(remuxDir)).toEqual([]);
    q.request(1, "play"); // the file is finished now: a new request starts afresh
    await until(() => q.status(1).state === "ready", 4000);
  });

  test("a Copy deleted while its job ran leaves no file behind", async () => {
    const { q, db, remuxDir, delay } = setup();
    delay(4);
    q.request(1, "scan");
    await until(() => q.status(1).state === "preparing");
    db.query("DELETE FROM copy WHERE id = 1").run();
    await until(() => (q as any).current === null);
    expect(readdirSync(remuxDir)).toEqual([]);
  });

  test("a job whose ffmpeg goes silent is killed and fails as stalled (PLAY-5)", async () => {
    const { q, delay, quiet, remuxDir } = setup(1, { stallMs: 300 });
    delay(50);
    quiet();
    const t0 = Date.now();
    q.request(1, "play");
    await until(() => q.status(1).state === "failed", 4000);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(q.status(1).error).toContain("stalled");
    expect(readdirSync(remuxDir)).toEqual([]);
  });

  test("a play request preempts a running scan-time job, which is re-queued and finishes later (PLAY-4)", async () => {
    const { q, db, delay } = setup(2);
    delay(30);
    q.request(1, "scan");
    await until(() => q.status(1).state === "preparing");
    delay(1);
    const t0 = Date.now();
    q.request(2, "play");
    await until(() => fallbackFile(db, 2) != null, 3000);
    expect(Date.now() - t0).toBeLessThan(2000); // not after copy 1's 3 s
    expect(fallbackFile(db, 1)).toBeNull();
    await until(() => fallbackFile(db, 1) != null, 5000);
  });

  test("shutdown kills the job in flight instead of waiting for it (PLAY-2, PLAY-6)", async () => {
    const { q, db, delay, remuxDir } = setup();
    delay(100);
    q.request(1, "scan");
    await until(() => q.status(1).state === "preparing");
    const t0 = Date.now();
    await q.shutdown();
    expect(Date.now() - t0).toBeLessThan(2000);
    await until(() => readdirSync(remuxDir).length === 0);
    expect(fallbackFile(db, 1)).toBeNull();
    expect(q.request(1, "play").state).toBe("none"); // nothing new starts once stopping
  });

  test("a recorded Fallback gone from remux/ answers 503 preparing and is rebuilt, not a 404 (PLAY-7)", async () => {
    const { q, db, remuxDir, delay } = setup();
    delay(2);
    db.query("UPDATE copy SET fallback_file = '1.mkv' WHERE id = 1").run();
    const res = await serveFile(new Request("http://x/copy/1"), join(remuxDir, "1.mkv"));
    expect(res.status).toBe(503);
    expect(["queued", "preparing"]).toContain(((await res.json()) as any).state);
    await until(() => q.status(1).state === "ready");
    expect(existsSync(join(remuxDir, "1.mkv"))).toBe(true);
  });

  test("startup sweeps remux/ of temp files and files no Copy names, but not a live process's temp file (PLAY-9)", async () => {
    const { q, db, remuxDir } = setup(2);
    db.query("UPDATE copy SET fallback_file = '1.mkv' WHERE id = 1").run();
    const keep = ["1.mkv", `2.${process.ppid}.0123abcd.tmp.mkv`, "notes.txt"];
    const gone = ["2.tmp.mkv", "7.mp4", "2.99999999.0123abcd.tmp.mkv"];
    for (const f of [...keep, ...gone]) writeFileSync(join(remuxDir, f), "x");
    await q.verifyFiles();
    expect(readdirSync(remuxDir).sort()).toEqual(keep.sort());
  });
});

describe("keyframe index jobs", () => {
  test("an index finished after the Copy changed is not written (DB-12)", async () => {
    const { db, cfg, delay } = setup();
    db.query("UPDATE copy SET playback = 'native' WHERE id = 1").run();
    delay(4);
    const k = new KeyframeIndex(db, cfg, () => true);
    expect(k.status(1)).toEqual({ state: "indexing" });
    await sleep(100);
    db.query("UPDATE copy SET size = 20, keyframes = NULL WHERE id = 1").run();
    await until(() => !(k as any).running, 5000);
    expect((db.query("SELECT keyframes FROM copy WHERE id = 1").get() as any).keyframes).toBeNull();
    delay(0);
    expect(k.status(1)).toEqual({ state: "indexing" });
    await until(() => !(k as any).running, 5000);
    expect(k.status(1)).toEqual({ state: "ready", keyframes: [0, 2] });
  });

  test("a Copy with a local Fallback is indexed while its Root is unmounted (PLAY-12)", async () => {
    const { db, cfg, remuxDir } = setup();
    writeFileSync(join(remuxDir, "1.mkv"), "x");
    db.query("UPDATE copy SET fallback_file = '1.mkv' WHERE id = 1").run();
    const k = new KeyframeIndex(db, cfg, () => false);
    expect(k.status(1)).toEqual({ state: "indexing" });
    await until(() => !(k as any).running, 5000);
    expect(k.status(1)).toEqual({ state: "ready", keyframes: [0, 2] });
    db.query("UPDATE copy SET fallback_file = NULL, keyframes = NULL WHERE id = 1").run();
    expect(k.status(1)).toEqual({ state: "none" }); // no Fallback, Root unmounted
  });

  test("shutdown kills the ffprobe in flight", async () => {
    const { db, cfg, delay } = setup();
    delay(100);
    const k = new KeyframeIndex(db, cfg, () => true);
    k.status(1);
    await sleep(100);
    const t0 = Date.now();
    k.shutdown();
    await until(() => !(k as any).running, 3000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((db.query("SELECT keyframes FROM copy WHERE id = 1").get() as any).keyframes).toBeNull();
  });
});
