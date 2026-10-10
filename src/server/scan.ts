import { readdir, stat, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { containerFor, parseFilename } from "./filename";
import { loadSeedHashes, seedKey, sha256File } from "./hash";
import { log } from "./log";
import { decidePlayback } from "./playback";
import { probeFile } from "./probe";
import { isIoError, sleep } from "./proc";
import type { RootRow, Roots } from "./roots";
import { rebuildVideoSearch } from "./search";

const SKIP_DIRS = new Set(["$RECYCLE.BIN", "System Volume Information", "node_modules"]);
const PROBE_CONCURRENCY = 4;
const HASH_CONCURRENCY = 2;

interface Entry {
  rel: string;
  name: string;
  size: number;
  mtimeMs: number;
}

interface CopyRow {
  id: number;
  video_id: number;
  rel_path: string;
  size: number;
  mtime: string;
  missing_since: string | null;
  fallback_file: string | null;
  playback: string;
}

export interface RootScanSummary {
  rootId: number;
  filesSeen: number;
  newCopies: number;
  updatedCopies: number;
  revived: number;
  markedMissing: number;
  skippedNotVideo: number;
  probeFailed: number;
  ioErrors: number;
  dirErrors: string[];
  durationMs: number;
}

export interface ScanProgress {
  running: boolean;
  rootId: number | null;
  rootPath: string | null;
  phase: "idle" | "walking" | "probing" | "finishing";
  filesSeen: number;
  filesToProbe: number;
  filesProbed: number;
  queued: number[];
  lastFinishedAt: string | null;
  last: RootScanSummary[];
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]!);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export class Scanner {
  private queue = new Set<number>();
  private running = false;
  private prog: ScanProgress = {
    running: false, rootId: null, rootPath: null, phase: "idle",
    filesSeen: 0, filesToProbe: 0, filesProbed: 0, queued: [], lastFinishedAt: null, last: [],
  };
  private seedHashes: Map<string, string>;
  private idle: (() => void)[] = [];

  constructor(
    private db: Db,
    private cfg: Pick<Config, "ffprobe" | "thumbsDir" | "remuxDir">,
    private roots: Roots,
    private afterScan: (rootId: number) => void,
  ) {
    this.seedHashes = loadSeedHashes(cfg.thumbsDir);
  }

  progress(): ScanProgress {
    return { ...this.prog, queued: [...this.queue] };
  }

  /** Resolves when no scan is running or queued. */
  whenIdle(): Promise<void> {
    return this.running || this.queue.size ? new Promise((r) => this.idle.push(r)) : Promise.resolve();
  }

  request(rootId: number) {
    this.queue.add(rootId);
    if (!this.running) void this.loop();
  }

  /** Rescan: refresh availability, then queue every Root that answers. */
  async requestAll(): Promise<number[]> {
    await this.roots.pollAll();
    const ids = this.roots.list().filter((r) => this.roots.isAvailable(r.id)).map((r) => r.id);
    for (const id of ids) this.request(id);
    return ids;
  }

  private async loop() {
    this.running = true;
    this.prog.running = true;
    try {
      while (this.queue.size) {
        const id = this.queue.values().next().value as number;
        this.queue.delete(id);
        const root = this.roots.get(id);
        if (!root) continue;
        try {
          const summary = await this.scanRoot(root);
          if (summary) {
            this.prog.last = [...this.prog.last.filter((s) => s.rootId !== id), summary];
            log(`scan root ${root.kind} done`, summary);
            this.afterScan(id);
          }
        } catch (e) {
          // a drive failure must never abort the scanner or the process
          log(`scan root ${root.kind} failed: ${e}`);
        }
      }
    } finally {
      this.running = false;
      Object.assign(this.prog, { running: false, rootId: null, rootPath: null, phase: "idle", lastFinishedAt: new Date().toISOString() });
      for (const r of this.idle.splice(0)) r();
    }
  }

  private async readdirRetry(dir: string) {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await readdir(dir, { withFileTypes: true });
      } catch (e) {
        last = e;
        const code = (e as { code?: string }).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") break;
        await sleep(2000 * attempt);
      }
    }
    throw last;
  }

  private async walk(rootPath: string, dir: string, out: Entry[], failedDirs: string[], summary: RootScanSummary) {
    let ents;
    try {
      ents = await this.readdirRetry(dir);
    } catch (e) {
      const rel = relative(rootPath, dir);
      failedDirs.push(rel);
      summary.dirErrors.push(`${rel || "."}: ${(e as Error).message}`.slice(0, 200));
      return;
    }
    for (const e of ents) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await this.walk(rootPath, full, out, failedDirs, summary);
        continue;
      }
      if (!e.isFile()) continue;
      const parsed = parseFilename(e.name);
      if (parsed.skip) {
        if (parsed.skip === "not-video") summary.skippedNotVideo++;
        continue;
      }
      try {
        const st = await stat(full);
        out.push({ rel: relative(rootPath, full), name: e.name, size: st.size, mtimeMs: st.mtimeMs });
        this.prog.filesSeen++;
      } catch (err) {
        // can't stat: not seen, but the dir is "uncertain" so nothing under it is marked missing
        failedDirs.push(relative(rootPath, dir));
        summary.dirErrors.push(`${relative(rootPath, full)}: ${(err as Error).message}`.slice(0, 200));
      }
    }
  }

  async scanRoot(root: RootRow): Promise<RootScanSummary | null> {
    // Availability first: an unmounted Root changes nothing.
    if (!(await this.roots.check(root.id))) {
      log(`scan skipped, root not available: ${root.path}`);
      return null;
    }
    const t0 = Date.now();
    const summary: RootScanSummary = {
      rootId: root.id, filesSeen: 0, newCopies: 0, updatedCopies: 0, revived: 0, markedMissing: 0,
      skippedNotVideo: 0, probeFailed: 0, ioErrors: 0, dirErrors: [], durationMs: 0,
    };
    Object.assign(this.prog, { rootId: root.id, rootPath: root.path, phase: "walking", filesSeen: 0, filesToProbe: 0, filesProbed: 0 });

    const entries: Entry[] = [];
    const failedDirs: string[] = [];
    await this.walk(root.path, root.path, entries, failedDirs, summary);
    summary.filesSeen = entries.length;

    const existing = new Map(
      (this.db.query("SELECT id, video_id, rel_path, size, mtime, missing_since, fallback_file, playback FROM copy WHERE root_id = ?").all(root.id) as CopyRow[]).map((c) => [c.rel_path, c]),
    );
    const seen = new Set<string>();
    const todo: { entry: Entry; row: CopyRow | undefined }[] = [];
    const revive = this.db.prepare("UPDATE copy SET missing_since = NULL WHERE id = ?");
    for (const entry of entries) {
      seen.add(entry.rel);
      const row = existing.get(entry.rel);
      const mtime = new Date(entry.mtimeMs).toISOString();
      if (row && row.size === entry.size && row.mtime === mtime) {
        if (row.missing_since) {
          revive.run(row.id);
          summary.revived++;
        }
        continue;
      }
      todo.push({ entry, row });
    }

    this.prog.phase = "probing";
    this.prog.filesToProbe = todo.length;
    // Probing is concurrent; id-less hashing is throttled separately inside processEntry.
    const hashSlots = { active: 0 };
    await pool(todo, PROBE_CONCURRENCY, async (t) => {
      try {
        await this.processEntry(root, t.entry, t.row, summary, hashSlots);
      } catch (e) {
        if (isIoError(e)) summary.ioErrors++;
        else summary.probeFailed++;
        log(`scan: ${t.entry.rel}: ${e}`);
      } finally {
        this.prog.filesProbed++;
      }
    });

    this.prog.phase = "finishing";
    await this.markMissing(root, existing, seen, failedDirs, entries.length, summary);
    rebuildVideoSearch(this.db);
    summary.durationMs = Date.now() - t0;
    return summary;
  }

  private async processEntry(root: RootRow, entry: Entry, row: CopyRow | undefined, summary: RootScanSummary, hashSlots: { active: number }) {
    const abs = join(root.path, entry.rel);
    const parsed = parseFilename(entry.name);
    const probe = await probeFile(this.cfg, abs);
    if (!probe.ok) {
      if (probe.io) summary.ioErrors++; // retryable: the row (if any) stays as it was, nothing is inserted
      else summary.probeFailed++;
      log(`scan: probe ${probe.io ? "I/O error (will retry next scan)" : "failed"}: ${entry.rel}: ${probe.error}`);
      return;
    }
    const f = probe.facts;
    if (!f.hasVideo) return; // audio-only: not a Video
    const playback = decidePlayback(f);
    const mtime = new Date(entry.mtimeMs).toISOString();

    let contentHash: string | null = null;
    if (!parsed.youtubeId) {
      const key = seedKey(abs, entry.size, entry.mtimeMs);
      contentHash = this.seedHashes.get(key) ?? null;
      if (!contentHash) {
        while (hashSlots.active >= HASH_CONCURRENCY) await sleep(50);
        hashSlots.active++;
        try {
          contentHash = await sha256File(abs);
        } finally {
          hashSlots.active--;
        }
      }
    }

    const facts = [
      f.duration, containerFor(parsed.ext), f.videoCodec, f.audioCodec, f.width, f.height, f.rFrameRate, playback,
    ] as const;

    if (row) {
      if (row.fallback_file) await unlink(join(this.cfg.remuxDir, row.fallback_file)).catch(() => {});
      this.db
        .prepare(
          `UPDATE copy SET size = ?, mtime = ?, duration_s = ?, container = ?, video_codec = ?, audio_codec = ?, width = ?, height = ?,
             r_frame_rate = ?, playback = ?, fallback_file = NULL, content_hash = COALESCE(?, content_hash), missing_since = NULL WHERE id = ?`,
        )
        .run(entry.size, mtime, ...facts, contentHash, row.id);
      summary.updatedCopies++;
      return;
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      const found = parsed.youtubeId
        ? (this.db.query("SELECT id FROM video WHERE youtube_id = ?").get(parsed.youtubeId) as { id: number } | null)
        : (this.db.query("SELECT id FROM video WHERE content_hash = ?").get(contentHash) as { id: number } | null);
      // Defaults from the Mirror (spec 2.3) wait for the Mirror import (ticket #26): everything is `other` until then.
      const videoId =
        found?.id ??
        Number(
          this.db
            .prepare("INSERT INTO video (youtube_id, content_hash, title, created_at) VALUES (?, ?, ?, ?)")
            .run(parsed.youtubeId, parsed.youtubeId ? null : contentHash, parsed.title, now).lastInsertRowid,
        );
      this.db
        .prepare(
          `INSERT INTO copy (video_id, root_id, rel_path, size, mtime, duration_s, container, video_codec, audio_codec, width, height,
             r_frame_rate, playback, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(videoId, root.id, entry.rel, entry.size, mtime, ...facts, contentHash);
    })();
    summary.newCopies++;
  }

  /** Spec 2.3 / CONTEXT.md "Missing": only for a Root that is still mounted, only when the file is provably gone. */
  private async markMissing(root: RootRow, existing: Map<string, CopyRow>, seen: Set<string>, failedDirs: string[], listed: number, summary: RootScanSummary) {
    const candidates = [...existing.values()].filter((c) => !seen.has(c.rel_path) && !c.missing_since);
    if (!candidates.length) return;
    if (listed === 0) {
      log(`scan: ${root.path} listed no files but ${existing.size} Copies are known; not marking anything missing`);
      return;
    }
    if (!(await this.roots.check(root.id))) {
      log(`scan: ${root.path} went away during the scan; not marking anything missing`);
      return;
    }
    const mark = this.db.prepare("UPDATE copy SET missing_since = ? WHERE id = ?");
    const now = new Date().toISOString();
    for (const c of candidates) {
      if (failedDirs.some((d) => d === "" || c.rel_path === d || c.rel_path.startsWith(d + "/"))) continue;
      try {
        await stat(join(root.path, c.rel_path));
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          mark.run(now, c.id);
          summary.markedMissing++;
        }
      }
    }
  }
}
