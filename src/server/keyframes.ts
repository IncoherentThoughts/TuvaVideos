// The keyframe index of a Copy (spec 4.1): the timestamps the Player's keyframe seeks snap to, so a seek decodes one
// frame instead of up to a whole GOP (about 5 s in this library). One ffprobe pass over the packets, no decode; made
// lazily on the first play of a Copy (one job at a time) or ahead of time by `bun run index-keyframes`. Stored on
// `copy.keyframes` as little-endian uint32 milliseconds.
import { join } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { log } from "./log";
import type { ChildProcess } from "node:child_process";
import { run } from "./proc";

export type KeyframeStatus = { state: "ready"; keyframes: number[] } | { state: "indexing" } | { state: "none" };

/** ffprobe `-show_entries packet=pts_time,dts_time,flags -of csv=p=0` -> sorted, deduplicated keyframe times in ms. Pure. */
export function parseKeyframes(csv: string): number[] {
  const ms = new Set<number>();
  for (const line of csv.split("\n")) {
    const cells = line.trim().split(",");
    if (cells.length < 3 || !cells[2]!.includes("K")) continue;
    const t = cells[0] !== "N/A" && cells[0] !== "" ? Number(cells[0]) : Number(cells[1]);
    if (Number.isFinite(t) && t >= 0) ms.add(Math.round(t * 1000));
  }
  return [...ms].sort((a, b) => a - b);
}

export function encodeKeyframes(ms: number[]): Uint8Array {
  const buf = new Uint8Array(ms.length * 4);
  const view = new DataView(buf.buffer);
  ms.forEach((m, i) => view.setUint32(i * 4, m, true));
  return buf;
}

/** The stored blob back to seconds. */
export function decodeKeyframes(blob: Uint8Array | ArrayBuffer | null | undefined): number[] {
  if (!blob) return [];
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength - (u8.byteLength % 4));
  const out: number[] = [];
  for (let o = 0; o + 4 <= view.byteLength; o += 4) out.push(view.getUint32(o, true) / 1000);
  return out;
}


/** The facts of a Copy a keyframe index belongs to: the index is recorded only if they still hold when ffprobe ends. */
interface CopyFile {
  id: number;
  path: string;
  rootId: number;
  missing: boolean;
  keyframes: Uint8Array | null;
  relPath: string;
  size: number;
  mtime: string;
  fallbackFile: string | null;
}

export class KeyframeIndex {
  private queue: number[] = [];
  private inFlight = new Set<number>();
  private running = false;
  private stopping = false;
  private child: ChildProcess | null = null;

  constructor(
    private db: Db,
    private cfg: Pick<Config, "ffprobe" | "remuxDir">,
    private rootAvailable: (rootId: number) => boolean,
  ) {}

  private file(copyId: number): CopyFile | null {
    const row = this.db
      .query(
        `SELECT c.id, c.rel_path, c.root_id, c.missing_since, c.fallback_file, c.keyframes, c.size, c.mtime, r.path AS root_path
         FROM copy c JOIN root r ON r.id = c.root_id WHERE c.id = ?`,
      )
      .get(copyId) as
      | { id: number; rel_path: string; root_id: number; missing_since: string | null; fallback_file: string | null; keyframes: Uint8Array | null; size: number; mtime: string; root_path: string }
      | null;
    if (!row) return null;
    // a Fallback is the same video stream (`-c:v copy`), always local: probe it when it is what plays
    const path = row.fallback_file ? join(this.cfg.remuxDir, row.fallback_file) : join(row.root_path, row.rel_path);
    return {
      id: row.id, path, rootId: row.root_id, missing: !!row.missing_since, keyframes: row.keyframes,
      relPath: row.rel_path, size: row.size, mtime: row.mtime, fallbackFile: row.fallback_file,
    };
  }

  /** Readable now: a local Fallback plays whether or not its Copy's Root is mounted (audit PLAY-12). */
  private readable(f: CopyFile): boolean {
    return !f.missing && (!!f.fallbackFile || this.rootAvailable(f.rootId));
  }

  /** What the Player can use now. Asking for an unindexed Copy queues its job. */
  status(copyId: number): KeyframeStatus {
    const f = this.file(copyId);
    if (!f) return { state: "none" };
    if (f.keyframes) return f.keyframes.byteLength ? { state: "ready", keyframes: decodeKeyframes(f.keyframes) } : { state: "none" };
    if (!this.readable(f)) return { state: "none" };
    this.request(copyId);
    return { state: "indexing" };
  }

  request(copyId: number) {
    if (this.stopping || this.inFlight.has(copyId)) return;
    this.inFlight.add(copyId);
    this.queue.push(copyId);
    if (!this.running) void this.pump();
  }

  /** Every unindexed Copy on a mounted Root, oldest first; resolves when the queue has drained. */
  async indexAll(onDone?: (copyId: number, ok: boolean, ms: number) => void): Promise<number> {
    const rows = this.db.query("SELECT id, root_id FROM copy WHERE keyframes IS NULL AND missing_since IS NULL ORDER BY id").all() as { id: number; root_id: number }[];
    const ids = rows.filter((r) => this.rootAvailable(r.root_id)).map((r) => r.id);
    this.onDone = onDone ?? null;
    for (const id of ids) this.request(id);
    while (this.running) await new Promise((r) => setTimeout(r, 200));
    this.onDone = null;
    return ids.length;
  }
  private onDone: ((copyId: number, ok: boolean, ms: number) => void) | null = null;

  private async pump() {
    this.running = true;
    try {
      while (!this.stopping && this.queue.length) {
        const id = this.queue.shift()!;
        const t0 = Date.now();
        let ok = false;
        try {
          ok = await this.index(id);
        } catch (e) {
          log(`keyframes: copy ${id} failed: ${String((e as Error).message ?? e).slice(0, 200)}`);
        } finally {
          this.inFlight.delete(id);
        }
        this.onDone?.(id, ok, Date.now() - t0);
      }
    } finally {
      this.running = false;
    }
  }

  /** One ffprobe over the packets of the video stream. A readable file that yields no keyframes is recorded as such. */
  private async index(copyId: number): Promise<boolean> {
    const f = this.file(copyId);
    if (!f || f.keyframes) return !!f?.keyframes?.byteLength;
    if (!this.readable(f)) return false;
    const t0 = Date.now();
    const r = await run(
      this.cfg.ffprobe,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,dts_time,flags", "-of", "csv=p=0", f.path],
      { timeout: 600_000, onSpawn: (p) => (this.child = p) },
    );
    this.child = null;
    if (this.stopping) return false;
    if (r.code !== 0) {
      // the drive hiccuped or the file is gone: leave NULL, so the next play asks again
      log(`keyframes: copy ${copyId} ffprobe exit ${r.code}: ${r.err.trim().slice(0, 200)}`);
      return false;
    }
    const ms = parseKeyframes(r.out);
    // Only over the file that was probed (audit DB-12, PLAY-3): a scan or relocate that changed the Copy meanwhile
    // cleared `keyframes`, and an old index must not land on the new file.
    const wrote = this.db
      .prepare("UPDATE copy SET keyframes = ? WHERE id = ? AND keyframes IS NULL AND root_id = ? AND rel_path = ? AND size = ? AND mtime = ? AND fallback_file IS ?")
      .run(encodeKeyframes(ms), copyId, f.rootId, f.relPath, f.size, f.mtime, f.fallbackFile);
    if (!wrote.changes) {
      log(`keyframes: copy ${copyId} changed while it was indexed; result discarded`);
      return false;
    }
    log(`keyframes: copy ${copyId} ${ms.length} keyframes in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return ms.length > 0;
  }

  /** A rescanned Copy whose file changed starts over. */
  invalidate(copyId: number) {
    this.db.prepare("UPDATE copy SET keyframes = NULL WHERE id = ?").run(copyId);
  }

  /** Quit: drop the queue and kill the ffprobe in flight (an index is rebuilt on the next play). */
  shutdown() {
    this.stopping = true;
    this.queue.length = 0;
    this.child?.kill("SIGKILL");
  }
}
