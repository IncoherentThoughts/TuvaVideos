// One writer per data dir (audit PLAY-2): `bun run start` takes `<dataDir>/instance.lock` before it serves, so a
// relaunch while the previous process is still shutting down waits for it instead of starting a second
// FallbackQueue, scanner and Thumbnail pool on the same `remux/`, `thumbs/` and `library.db`. The lock is a file
// holding the owner's pid; one whose pid is gone is stale and taken over. A passive server (Config.passive) shares
// the data dir by design and takes no lock.
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

  /** The lock file's content, written whole: a reader never sees it half written (it would look stale). */
  private writeTemp(): string {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.info));
    return tmp;
  }

  acquire(): LockResult {
    for (let attempt = 0; attempt < 3; attempt++) {
      const tmp = this.writeTemp();
      let linked = false;
      try {
        linkSync(tmp, this.path); // atomic and exclusive: EEXIST while another process holds the lock
        linked = true;
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") throw e;
      } finally {
        try {
          unlinkSync(tmp);
        } catch {}
      }
      // Two launches taking over one stale lock: the later unlink may remove the earlier's fresh file. The file names
      // one owner at a time, so read it back: only the process it names holds the lock.
      if (linked && this.ownerPid() === process.pid) {
        this.held = true;
        return { ok: true };
      }
      const h = this.holder();
      if (h) return { ok: false, holder: h };
      if (linked) continue;
      try {
        unlinkSync(this.path); // stale: its process is gone (or it is this process's own leftover)
      } catch {}
    }
    const h = this.holder();
    return h ? { ok: false, holder: h } : { ok: false, holder: { pid: -1, port: 0, state: "running", startedAt: "" } };
  }

  private ownerPid(): number | null {
    try {
      return (JSON.parse(readFileSync(this.path, "utf8")) as LockHolder).pid;
    } catch {
      return null;
    }
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
      renameSync(this.writeTemp(), this.path); // replaced whole, never truncated in place
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
