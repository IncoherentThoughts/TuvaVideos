// One server per data dir and a quit that cannot hang (audit PLAY-2, PLAY-6), and validators on streamed files so a
// file replaced under the same URL is never spliced into a running play (PLAY-13).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceLock } from "../src/server/instanceLock";
import { shutdownHandler } from "../src/server/launch";
import { sleep } from "../src/server/proc";
import { serveFile } from "../src/server/stream";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "tuva-lock-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("instance lock", () => {
  test("a second taker is refused while the holder lives, and gets the lock once it lets go", async () => {
    const dir = tmp();
    const holder = Bun.spawn(["sleep", "30"]);
    try {
      // another live process holds it, shutting down
      writeFileSync(join(dir, "instance.lock"), JSON.stringify({ pid: holder.pid, port: 4604, state: "stopping", startedAt: "x" }));
      const lock = new InstanceLock(dir, 4604);
      const r = lock.acquire();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.holder).toMatchObject({ pid: holder.pid, state: "stopping" });
      const waiting = lock.acquireWaiting(5000, 50);
      await sleep(150);
      holder.kill();
      await holder.exited;
      expect((await waiting).ok).toBe(true);
      lock.setState("stopping");
      expect(JSON.parse(await Bun.file(lock.path).text())).toMatchObject({ pid: process.pid, state: "stopping" });
      lock.release();
      expect(await Bun.file(lock.path).exists()).toBe(false);
    } finally {
      holder.kill();
    }
  });

  test("a lock left by a dead process is taken over", () => {
    const dir = tmp();
    writeFileSync(join(dir, "instance.lock"), JSON.stringify({ pid: 99999999, port: 1, state: "running", startedAt: "x" }));
    const lock = new InstanceLock(dir, 4604);
    expect(lock.acquire().ok).toBe(true);
    lock.release();
  });

  test("setState replaces the file whole and leaves no temp file; a second taker still sees the live holder", () => {
    const dir = tmp();
    const lock = new InstanceLock(dir, 4604);
    expect(lock.acquire().ok).toBe(true);
    lock.setState("stopping");
    expect(readdirSync(dir)).toEqual(["instance.lock"]);
    // the same pid reads as "this process" in holder(): fake another live owner by rewriting the pid
    const holder = Bun.spawn(["sleep", "30"]);
    try {
      writeFileSync(join(dir, "instance.lock"), JSON.stringify({ pid: holder.pid, port: 4604, state: "stopping", startedAt: "x" }));
      const r = new InstanceLock(dir, 4605).acquire();
      expect(r.ok).toBe(false);
      expect(readdirSync(dir)).toEqual(["instance.lock"]);
    } finally {
      holder.kill();
    }
  });

  test("gives up after the wait when the holder never lets go", async () => {
    const dir = tmp();
    const holder = Bun.spawn(["sleep", "30"]);
    try {
      writeFileSync(join(dir, "instance.lock"), JSON.stringify({ pid: holder.pid, port: 1, state: "stopping", startedAt: "x" }));
      expect((await new InstanceLock(dir, 4604).acquireWaiting(200, 50)).ok).toBe(false);
    } finally {
      holder.kill();
    }
  });
});

describe("shutdown signals", () => {
  test("the first signal stops cleanly; a second one kills the jobs and exits at once", async () => {
    const calls: string[] = [];
    const exits: number[] = [];
    const app = { stop: () => (calls.push("stop"), new Promise<void>(() => {})), kill: () => void calls.push("kill") };
    const lock = { setState: (s: string) => void calls.push(`state:${s}`), release: () => void calls.push("release") };
    const h = shutdownHandler(app, lock as any, (c) => exits.push(c));
    void h("SIGINT");
    await sleep(10);
    expect(calls).toEqual(["state:stopping", "stop"]);
    expect(exits).toEqual([]); // stop() is still running
    await h("SIGINT");
    expect(calls).toEqual(["state:stopping", "stop", "kill", "release"]);
    expect(exits).toEqual([1]);
  });

  test("a clean stop releases the lock and exits 0", async () => {
    const calls: string[] = [];
    const exits: number[] = [];
    const h = shutdownHandler({ stop: async () => void calls.push("stop"), kill: () => {} }, { setState: () => {}, release: () => void calls.push("release") } as any, (c) => exits.push(c));
    await h("SIGTERM");
    expect(calls).toEqual(["stop", "release"]);
    expect(exits).toEqual([0]);
  });
});

describe("validators on served files (PLAY-13)", () => {
  test("ETag and Last-Modified are sent; If-Range with the current ETag gets the range, a stale one the whole new file", async () => {
    const dir = tmp();
    const f = join(dir, "a.mp4");
    writeFileSync(f, "0123456789");
    const first = await serveFile(new Request("http://x/copy/1", { headers: { range: "bytes=0-3" } }), f);
    expect(first.status).toBe(206);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+-[0-9a-f]+"$/);
    expect(first.headers.get("last-modified")).toBeTruthy();

    const same = await serveFile(new Request("http://x/copy/1", { headers: { range: "bytes=4-5", "if-range": etag } }), f);
    expect(same.status).toBe(206);
    expect(await same.text()).toBe("45");

    // the file is replaced under the same URL (a rescan, a new Fallback)
    rmSync(f);
    writeFileSync(f, "abcdefghijklmnop");
    const replaced = await serveFile(new Request("http://x/copy/1", { headers: { range: "bytes=4-5", "if-range": etag } }), f);
    expect(replaced.status).toBe(200);
    expect(await replaced.text()).toBe("abcdefghijklmnop");
    expect(replaced.headers.get("etag")).not.toBe(etag);

    const weak = await serveFile(new Request("http://x/copy/1", { headers: { range: "bytes=0-0", "if-range": `W/${etag}` } }), f);
    expect(weak.status).toBe(200);
    const byDate = await serveFile(new Request("http://x/copy/1", { headers: { range: "bytes=0-0", "if-range": replaced.headers.get("last-modified")! } }), f);
    expect(byDate.status).toBe(206);
  });
});
