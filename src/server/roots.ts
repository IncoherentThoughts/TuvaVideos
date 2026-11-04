import { open, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { log } from "./log";

export interface RootRow {
  id: number;
  path: string;
  kind: "local" | "external";
}

const READ_TIMEOUT_MS = 5000;
/** When the sampled Copies all read ENOENT, this many more known Copies are stat'ed before the Root itself is judged. */
const WIDER_SAMPLE = 50;

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
    if (this.cfg.localRoot) ins.run(this.cfg.localRoot, "local");
    if (this.cfg.externalRoot) ins.run(this.cfg.externalRoot, "external");
  }

  /** The first-launch Root (§8.4): one `local` row, chosen in the UI. The caller checks it and starts the first scan. */
  add(path: string): RootRow {
    const id = Number(this.db.query("INSERT INTO root (path, kind) VALUES (?, 'local')").run(path).lastInsertRowid);
    log(`root local added: ${path}`);
    return this.get(id)!;
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
    let revived = false;
    if (known.length === 0) {
      // Nothing to read yet (first run, or every Copy is Missing): the Root directory itself must exist.
      ok = await stat(root.path).then((s) => s.isDirectory(), () => false);
      // Every Copy Missing and one of them readable again: the drive came back while its mount point kept answering,
      // so `ok` alone shows no transition. Fire the remount scan once, so the Copies revive (audit DB-1).
      if (ok) revived = await this.missingCopyReadable(root);
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
      if (ok) await this.learnDevice(root);
      // Files deleted from a mounted drive give ENOENT. The Root directory still answering proves nothing by itself: an
      // unmounted drive leaves its mount point behind as an empty directory (Linux fstab mounts, a stale /Volumes/Name).
      if (!ok && allGone) ok = await this.stillMounted(root);
    }
    const was = this.state.get(rootId);
    this.state.set(rootId, ok);
    const revival = revived && !this.revivalFired.has(rootId);
    if (revived) this.revivalFired.add(rootId);
    else this.revivalFired.delete(rootId);
    if (ok && (was !== true || revival)) {
      log(`root ${root.kind} available${was === true ? " again (a Missing Copy is readable)" : ""}: ${root.path}`);
      for (const cb of this.listeners) cb(root);
    } else if (!ok && was === true) {
      log(`root ${root.kind} UNAVAILABLE: ${root.path}`);
    } else if (!ok && was === undefined) {
      log(`root ${root.kind} not available at startup: ${root.path}`);
    }
    return ok;
  }

  /** The device the Root directory was on the last time one of its Copies read fine (this process only). */
  private devices = new Map<number, number>();
  /** Roots whose "a Missing Copy is readable again" event already fired, so the poll fires it once. */
  private revivalFired = new Set<number>();

  private async learnDevice(root: RootRow) {
    const st = await stat(root.path).catch(() => null);
    if (st) this.devices.set(root.id, st.dev);
  }

  /**
   * The sampled Copies are all gone. The Root counts as mounted only when (1) another known Copy is still there, or
   * (2) the directory is on the device a Copy was last read from, or, with no device learned yet, (3) the directory is
   * a live mount point (another device than its parent) or holds anything at all. An empty directory on its parent's
   * device is what an unmounted drive leaves behind: unavailable, so nothing is marked Missing (CONTEXT.md "Missing").
   */
  private async stillMounted(root: RootRow): Promise<boolean> {
    const st = await withTimeout(stat(root.path), READ_TIMEOUT_MS).catch(() => null);
    if (!st?.isDirectory()) return false;
    const more = this.db
      .query("SELECT rel_path FROM copy WHERE root_id = ? AND missing_since IS NULL ORDER BY id LIMIT ? OFFSET 3")
      .all(root.id, WIDER_SAMPLE) as { rel_path: string }[];
    for (const k of more) {
      if (await withTimeout(stat(join(root.path, k.rel_path)), READ_TIMEOUT_MS).then(() => true, () => false)) return true;
    }
    const dev = this.devices.get(root.id);
    if (dev !== undefined) return st.dev === dev;
    const parent = await stat(dirname(root.path)).catch(() => null);
    if (parent && parent.dev !== st.dev) return true;
    const names = await withTimeout(readdir(root.path), READ_TIMEOUT_MS).catch(() => [] as string[]);
    return names.some((n) => n !== ".DS_Store" && n !== "lost+found");
  }

  /** True when one of the first few Missing Copies of a Root is readable again. */
  private async missingCopyReadable(root: RootRow): Promise<boolean> {
    const missing = this.db
      .query("SELECT rel_path FROM copy WHERE root_id = ? AND missing_since IS NOT NULL ORDER BY id LIMIT 3")
      .all(root.id) as { rel_path: string }[];
    for (const k of missing) {
      if (await withTimeout(readOneByte(join(root.path, k.rel_path)), READ_TIMEOUT_MS).then(() => true, () => false)) return true;
    }
    return false;
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
