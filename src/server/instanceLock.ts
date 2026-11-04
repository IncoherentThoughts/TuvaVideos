// One writer per data dir (audit PLAY-2): `bun run start` takes `<dataDir>/instance.lock` before it serves, so a
// relaunch while the previous process is still shutting down waits for it instead of starting a second
// FallbackQueue, scanner and Thumbnail pool on the same `remux/`, `thumbs/` and `library.db`. The lock is a file
// holding the owner's pid; one whose pid is gone is stale and taken over. A passive server (Config.passive) shares
// the data dir by design and takes no lock.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "./proc";

export interface LockHolder {
  pid: number;
  port: number;
  state: "running" | "stopping";
  startedAt: string;
}

export type LockResult = { ok: true } | { ok: false; holder: LockHolder };

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

export class InstanceLock {
  readonly path: string;
  private held = false;
  private info: LockHolder;

  constructor(dataDir: string, port: number) {
    this.path = join(dataDir, "instance.lock");
    this.info = { pid: process.pid, port, state: "running", startedAt: new Date().toISOString() };
    mkdirSync(dataDir, { recursive: true });
  }

  /** The current holder, or null when the lock is free or stale. */
  holder(): LockHolder | null {
    let h: LockHolder;
    try {
      h = JSON.parse(readFileSync(this.path, "utf8")) as LockHolder;
    } catch {
      return null;
    }
    return h && h.pid !== process.pid && pidAlive(h.pid) ? h : null;
  }

  acquire(): LockResult {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        writeFileSync(this.path, JSON.stringify(this.info), { flag: "wx" });
        this.held = true;
        return { ok: true };
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") throw e;
      }
      const h = this.holder();
      if (h) return { ok: false, holder: h };
      try {
        unlinkSync(this.path); // stale: its process is gone (or it is this process's own leftover)
      } catch {}
    }
    const h = this.holder();
    return h ? { ok: false, holder: h } : { ok: false, holder: { pid: -1, port: 0, state: "running", startedAt: "" } };
  }

  /** Tries until the holder lets go or `timeoutMs` passes. */
  async acquireWaiting(timeoutMs: number, pollMs = 200): Promise<LockResult> {
    const t0 = Date.now();
    for (;;) {
      const r = this.acquire();
      if (r.ok || Date.now() - t0 >= timeoutMs) return r;
      await sleep(pollMs);
    }
  }

  /** Marks the holder as shutting down, so a relaunch waits for it rather than opening a tab on a dying server. */
  setState(state: LockHolder["state"]) {
    if (!this.held) return;
    this.info.state = state;
    try {
      writeFileSync(this.path, JSON.stringify(this.info));
    } catch {}
  }

  release() {
    if (!this.held) return;
    this.held = false;
    try {
      const h = JSON.parse(readFileSync(this.path, "utf8")) as LockHolder;
      if (h.pid === process.pid) unlinkSync(this.path);
    } catch {}
  }
}
