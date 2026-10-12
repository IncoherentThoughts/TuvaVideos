import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { log } from "./log";

export interface RootRow {
  id: number;
  path: string;
  kind: "local" | "external";
}

const READ_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("read timed out"), { code: "ETIMEDOUT" })), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

async function readOneByte(path: string): Promise<void> {
  const fh = await open(path, "r");
  try {
    await fh.read(Buffer.alloc(1), 0, 1, 0);
  } finally {
    await fh.close();
  }
}

/**
 * Root availability (spec 3.2): a 1-byte read of a known Copy, never readdir.
 * Holds the in-memory availability state and fires `onBecameAvailable` on every transition to
 * Available, including the first check after startup.
 */
export class Roots {
  private state = new Map<number, boolean>();
  private listeners: ((r: RootRow) => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private db: Db,
    private cfg: Pick<Config, "localRoot" | "externalRoot">,
  ) {}

  seed() {
    const ins = this.db.prepare("INSERT OR IGNORE INTO root (path, kind) VALUES (?, ?)");
    ins.run(this.cfg.localRoot, "local");
    if (this.cfg.externalRoot) ins.run(this.cfg.externalRoot, "external");
  }

  list(): RootRow[] {
    return this.db.query("SELECT id, path, kind FROM root ORDER BY id").all() as RootRow[];
  }

  get(id: number): RootRow | undefined {
    return this.db.query("SELECT id, path, kind FROM root WHERE id = ?").get(id) as RootRow | undefined;
  }

  isAvailable(rootId: number): boolean {
    return this.state.get(rootId) === true;
  }

  onBecameAvailable(cb: (r: RootRow) => void) {
    this.listeners.push(cb);
  }

  /** Probe one Root now and update its state. Any failure, EIO included, means "not available right now". */
  async check(rootId: number): Promise<boolean> {
    const root = this.get(rootId);
    if (!root) return false;
    const known = this.db
      .query("SELECT rel_path FROM copy WHERE root_id = ? AND missing_since IS NULL ORDER BY id LIMIT 3")
      .all(rootId) as { rel_path: string }[];
    let ok = false;
    if (known.length === 0) {
      // Nothing to read yet (first run): the Root directory itself must exist.
      ok = await stat(root.path).then((s) => s.isDirectory(), () => false);
    } else {
      let allGone = true;
      for (const k of known) {
        try {
          await withTimeout(readOneByte(join(root.path, k.rel_path)), READ_TIMEOUT_MS);
          ok = true;
          break;
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") allGone = false;
        }
      }
      // Files deleted from a mounted drive give ENOENT; the Root directory still answering proves it is mounted.
      if (!ok && allGone) ok = await stat(root.path).then((s) => s.isDirectory(), () => false);
    }
    const was = this.state.get(rootId);
    this.state.set(rootId, ok);
    if (ok && was !== true) {
      log(`root ${root.kind} available: ${root.path}`);
      for (const cb of this.listeners) cb(root);
    } else if (!ok && was === true) {
      log(`root ${root.kind} UNAVAILABLE: ${root.path}`);
    } else if (!ok && was === undefined) {
      log(`root ${root.kind} not available at startup: ${root.path}`);
    }
    return ok;
  }

  async pollAll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await Promise.all(this.list().map((r) => this.check(r.id)));
    } finally {
      this.polling = false;
    }
  }

  start(intervalMs = 10_000) {
    this.timer = setInterval(() => void this.pollAll(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
