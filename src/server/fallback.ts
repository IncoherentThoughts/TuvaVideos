import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { extensionOf } from "./filename";
import { pidAlive } from "./instanceLock";
import { log } from "./log";
import type { Playback } from "./playback";
import { onMissingFile } from "./stream";

export type FallbackState = "none" | "ready" | "queued" | "preparing" | "failed";

export interface FallbackStatus {
  state: FallbackState;
  /** 0..1 while preparing; null when ffmpeg cannot tell (no duration) */
  progress: number | null;
  error?: string;
}

interface Job {
  copyId: number;
  priority: "play" | "scan";
  state: "queued" | "running" | "failed";
  progress: number | null;
  error?: string;
  proc?: ChildProcess;
  /** Why the running ffmpeg was killed on purpose: a play request took its turn, or the app is quitting. */
  stopped?: "preempted" | "shutdown";
  /** Rejects the running job at once (a child stuck in the kernel may never close). */
  abort?: (e: Error) => void;
}

interface CopyInfo {
  id: number;
  rel_path: string;
  root_path: string;
  playback: Playback;
  duration_s: number | null;
  fallback_file: string | null;
  missing_since: string | null;
  root_id: number;
  size: number;
  mtime: string;
}

/** The pure part: ffmpeg arguments for a Fallback. `audioSibling` pairs a yt-dlp `.f251` audio file. */
export function fallbackPlan(kind: Playback, src: string, ext: string, audioSibling: string | null, outTmp: string): { args: string[]; outExt: string } {
  const matroska = ext === "mkv" || ext === "webm";
  const common = ["-y", "-v", "error", "-nostdin", "-progress", "pipe:1", "-nostats"];
  if (kind === "transcode") {
    // webm cannot hold AAC
    const outExt = ext === "webm" ? "mkv" : ext;
    return { args: [...common, "-i", src, "-c:v", "copy", "-c:a", "aac", outTmp], outExt };
  }
  const tail = matroska ? ["-c", "copy", "-cues_to_front", "1"] : ["-c", "copy", "-movflags", "+faststart"];
  const inputs = audioSibling ? ["-i", src, "-i", audioSibling, "-map", "0:v", "-map", "1:a"] : ["-i", src];
  return { args: [...common, ...inputs, ...tail, outTmp], outExt: ext };
}

/** A Fallback file's name: `<copyId>.<ext>`; anything else in remux/ (temp files included) is debris. */
const FALLBACK_NAME = /^\d+\.[a-z0-9]+$/;

export interface FallbackOptions {
  /** Kill a job whose ffmpeg reports no progress for this long (a hung drive): audit PLAY-5. */
  stallMs?: number;
}

/**
 * One ffmpeg Fallback job at a time (spec 3.4). Play-requested jobs run before scan-time jobs, and a play request
 * preempts a running scan-time job (it is re-queued; a transcode restarts cheaply).
 * Output goes to a per-job temp name in remux/, is renamed to remux/<copyId>.<ext>, and is recorded only when the
 * Copy is still the file the job read (same root, path, size and mtime); otherwise the result is thrown away.
 */
export class FallbackQueue {
  private jobs = new Map<number, Job>();
  private current: Job | null = null;
  private stopping = false;
  private drained: (() => void)[] = [];
  private stallMs: number;

  constructor(
    private db: Db,
    private cfg: Pick<Config, "ffmpeg" | "remuxDir">,
    private rootAvailable: (rootId: number) => boolean,
    opts: FallbackOptions = {},
  ) {
    this.stallMs = opts.stallMs ?? 120_000;
    mkdirSync(cfg.remuxDir, { recursive: true });
    // A Fallback deleted from remux/ while the app runs: forget it and make it again (audit PLAY-7).
    onMissingFile(cfg.remuxDir, (name) => this.lostFile(name));
  }

  /**
   * Startup: forget Fallback files that vanished from remux/ (spec: cached, so rebuildable), and remove every file no
   * Copy names, the temp files a crash or kill left behind included (audit PLAY-9).
   */
  async verifyFiles() {
    const rows = this.db.query("SELECT id, fallback_file FROM copy WHERE fallback_file IS NOT NULL").all() as { id: number; fallback_file: string }[];
    for (const r of rows) {
      if (!existsSync(join(this.cfg.remuxDir, r.fallback_file))) {
        this.db.prepare("UPDATE copy SET fallback_file = NULL WHERE id = ?").run(r.id);
        log(`fallback file missing, cleared: ${r.fallback_file}`);
      }
    }
    await this.sweep();
  }

  /** Deletes the files in remux/ that no Copy row names. Never touches a file a job of this process is writing. */
  async sweep(): Promise<number> {
    const named = new Set((this.db.query("SELECT fallback_file FROM copy WHERE fallback_file IS NOT NULL").all() as { fallback_file: string }[]).map((r) => r.fallback_file));
    let names: string[];
    try {
      names = await readdir(this.cfg.remuxDir);
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names) {
      if (named.has(name)) continue;
      // another process's temp file (a passive second server) is left alone while that process lives
      const owner = name.match(/^\d+\.(\d+)\.[0-9a-f]+\.tmp\./);
      if (owner && Number(owner[1]) !== process.pid && pidAlive(Number(owner[1]))) continue;
      if (owner && Number(owner[1]) === process.pid && this.current) continue;
      if (!FALLBACK_NAME.test(name) && !name.includes(".tmp.")) continue; // not ours
      await rm(join(this.cfg.remuxDir, name), { force: true }).catch(() => {});
      n++;
    }
    if (n) log(`fallback: removed ${n} orphan file(s) from remux/`);
    return n;
  }

  status(copyId: number): FallbackStatus {
    const row = this.db.query("SELECT playback, fallback_file FROM copy WHERE id = ?").get(copyId) as { playback: Playback; fallback_file: string | null } | null;
    if (!row || row.playback === "native") return { state: "none", progress: null };
    if (row.fallback_file) return { state: "ready", progress: 1 };
    const j = this.jobs.get(copyId);
    if (!j) return { state: "none", progress: null };
    if (j.state === "running") return { state: "preparing", progress: j.progress };
    if (j.state === "failed") return { state: "failed", progress: null, error: j.error };
    return { state: "queued", progress: 0 };
  }

  /** True while a play-requested job is the one ffmpeg is running: Thumbnails pause (spec 3.5). */
  playJobRunning(): boolean {
    return this.current?.priority === "play";
  }

  /**
   * Queue a job. A play request jumps the queue, upgrades an already-queued scan job, and preempts a running scan-time
   * job of another Copy (audit PLAY-4).
   */
  request(copyId: number, priority: "play" | "scan"): FallbackStatus {
    const st = this.status(copyId);
    if (st.state === "ready" || st.state === "none" && !this.needsFallback(copyId)) return st;
    const existing = this.jobs.get(copyId);
    if (existing && existing.state !== "failed") {
      if (priority === "play") existing.priority = "play";
    } else if (!this.stopping) {
      this.jobs.set(copyId, { copyId, priority, state: "queued", progress: 0 });
    }
    const cur = this.current;
    if (priority === "play" && cur && cur.copyId !== copyId && cur.priority === "scan" && !cur.stopped && this.jobs.get(copyId)?.state === "queued") {
      log(`fallback: play request for copy ${copyId} preempts the scan-time job of copy ${cur.copyId}`);
      this.stopJob(cur, "preempted");
    }
    void this.pump();
    return this.status(copyId);
  }

  private needsFallback(copyId: number): boolean {
    const row = this.db.query("SELECT playback FROM copy WHERE id = ?").get(copyId) as { playback: Playback } | null;
    return !!row && row.playback !== "native";
  }

  /** Queue scan-time jobs: every Copy that needs a transcode, is not made yet, and can be read now. */
  enqueueScanJobs() {
    const rows = this.db
      .query("SELECT id FROM copy WHERE playback = 'transcode' AND fallback_file IS NULL AND missing_since IS NULL ORDER BY id")
      .all() as { id: number }[];
    for (const r of rows) this.request(r.id, "scan");
  }

  private next(): Job | undefined {
    const queued = [...this.jobs.values()].filter((j) => j.state === "queued");
    return queued.find((j) => j.priority === "play") ?? queued[0];
  }

  private stopJob(job: Job, why: "preempted" | "shutdown") {
    job.stopped = why;
    job.proc?.kill("SIGKILL");
    job.abort?.(new Error(`ffmpeg stopped (${why})`));
  }

  private async pump() {
    if (this.current) return;
    const job = this.stopping ? undefined : this.next();
    if (!job) {
      for (const r of this.drained.splice(0)) r();
      return;
    }
    this.current = job;
    job.state = "running";
    job.stopped = undefined;
    try {
      const again = await this.runJob(job);
      if (again && !this.stopping) Object.assign(job, { state: "queued", progress: 0, proc: undefined });
      else this.jobs.delete(job.copyId);
    } catch (e) {
      if (job.stopped === "preempted" && !this.stopping) {
        Object.assign(job, { state: "queued", progress: 0, proc: undefined, stopped: undefined });
      } else if (job.stopped === "shutdown") {
        this.jobs.delete(job.copyId);
        log(`fallback job for copy ${job.copyId} stopped at shutdown (rebuilt on the next play or scan)`);
      } else {
        job.state = "failed";
        job.error = String((e as Error).message ?? e).slice(0, 300);
        log(`fallback job for copy ${job.copyId} failed: ${job.error}`);
      }
    } finally {
      job.abort = undefined;
      this.current = null;
      void this.pump();
    }
  }

  private info(copyId: number): CopyInfo | null {
    return this.db
      .query(
        `SELECT c.id, c.rel_path, r.path AS root_path, c.playback, c.duration_s, c.fallback_file, c.missing_since, c.root_id, c.size, c.mtime
         FROM copy c JOIN root r ON r.id = c.root_id WHERE c.id = ?`,
      )
      .get(copyId) as CopyInfo | null;
  }

  private async findAudioSibling(src: string): Promise<string | null> {
    // yt-dlp leaves `<stem>.f251.<ext>` next to an unmerged video; pair it when present.
    try {
      const stem = basename(src).replace(/\.[^.]+$/, "").replace(/\.f\d+$/, "");
      const names = await readdir(dirname(src));
      const hit = names.find((n) => n.startsWith(stem + ".f251."));
      return hit ? join(dirname(src), hit) : null;
    } catch {
      return null;
    }
  }

  /** Runs one job. True when the Copy changed under it, so its result was thrown away and the job should run again. */
  private async runJob(job: Job): Promise<boolean> {
    const c = this.info(job.copyId);
    if (!c || c.playback === "native") return false;
    if (c.fallback_file) return false;
    if (c.missing_since || !this.rootAvailable(c.root_id)) throw new Error("Copy is not available");
    const src = join(c.root_path, c.rel_path);
    const ext = extensionOf(src);
    const sibling = c.playback === "remux" ? await this.findAudioSibling(src) : null;
    // Unique per process and job: two writers (a relaunch, a passive server) never share a temp file (audit PLAY-2).
    const tmpBase = join(this.cfg.remuxDir, `${c.id}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    const plan = fallbackPlan(c.playback, src, ext, sibling, `${tmpBase}.${ext === "webm" && c.playback === "transcode" ? "mkv" : ext}`);
    const tmpOut = plan.args[plan.args.length - 1]!;
    const finalName = `${c.id}.${plan.outExt}`;
    log(`fallback ${c.playback} start (${job.priority}): copy ${c.id} ${c.rel_path}${sibling ? " + " + basename(sibling) : ""}`);
    const t0 = Date.now();
    await new Promise<void>((resolve, reject) => {
      const p = spawn(this.cfg.ffmpeg, plan.args, { stdio: ["ignore", "pipe", "pipe"] });
      job.proc = p;
      let settled = false;
      const finish = (e?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        if (e) reject(e);
        else resolve();
      };
      job.abort = (e) => finish(e);
      if (job.stopped) {
        p.kill("SIGKILL");
        finish(new Error(`ffmpeg stopped (${job.stopped})`));
      }
      // ffmpeg's -progress writes a block about twice a second; silence means it is stuck on a read
      let lastOutput = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastOutput < this.stallMs) return;
        p.kill("SIGKILL");
        finish(new Error(`ffmpeg stalled: no progress for ${Math.round(this.stallMs / 100) / 10} s (is the drive hung?)`));
      }, Math.min(5000, Math.max(50, this.stallMs / 4)));
      let err = "";
      let buf = "";
      p.stdout.on("data", (d) => {
        lastOutput = Date.now();
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const m = line.match(/^out_time_(?:us|ms)=(\d+)/); // ffmpeg's out_time_ms is microseconds too
          if (m && c.duration_s) job.progress = Math.min(0.99, Number(m[1]) / 1e6 / c.duration_s);
        }
      });
      p.stderr.on("data", (d) => {
        if (err.length < 5000) err += d;
      });
      p.on("error", (e) => finish(e));
      p.on("close", (code, sig) => finish(code === 0 ? undefined : new Error(`ffmpeg ${sig ?? code}: ${err.trim().slice(-250)}`)));
    }).catch(async (e) => {
      await rm(tmpOut, { force: true });
      throw e;
    });
    job.proc = undefined;
    const st = await stat(tmpOut);
    if (st.size === 0) {
      await rm(tmpOut, { force: true });
      throw new Error("ffmpeg produced an empty file");
    }
    // The Copy must still be the file the job read (audit PLAY-3): a rescan that saw it change cleared the row.
    if (!this.unchanged(c)) {
      await rm(tmpOut, { force: true });
      const still = this.info(c.id);
      log(`fallback ${c.playback}: copy ${c.id} changed or went away while it was made; result discarded`);
      return !!still && still.playback !== "native" && !still.fallback_file;
    }
    await rename(tmpOut, join(this.cfg.remuxDir, finalName));
    const wrote = this.db
      .prepare("UPDATE copy SET fallback_file = ? WHERE id = ? AND fallback_file IS NULL AND root_id = ? AND rel_path = ? AND size = ? AND mtime = ? AND playback = ?")
      .run(finalName, c.id, c.root_id, c.rel_path, c.size, c.mtime, c.playback);
    if (!wrote.changes) {
      const now = this.info(c.id);
      if (now?.fallback_file !== finalName) await unlink(join(this.cfg.remuxDir, finalName)).catch(() => {});
      log(`fallback ${c.playback}: copy ${c.id} changed while it was recorded; result discarded`);
      return false;
    }
    job.progress = 1;
    log(`fallback ${c.playback} done: copy ${c.id} -> ${finalName} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return false;
  }

  private unchanged(c: CopyInfo): boolean {
    const now = this.info(c.id);
    return !!now && !now.fallback_file && now.root_id === c.root_id && now.rel_path === c.rel_path && now.size === c.size && now.mtime === c.mtime && now.playback === c.playback;
  }

  /** `serveFile` found a recorded Fallback gone: clear it, queue it as a play job and answer "preparing". */
  private lostFile(name: string): Response | null {
    const row = this.db.query("SELECT id FROM copy WHERE fallback_file = ?").get(name) as { id: number } | null;
    if (!row) return null;
    this.db.prepare("UPDATE copy SET fallback_file = NULL WHERE id = ? AND fallback_file = ?").run(row.id, name);
    log(`fallback file ${name} vanished from remux/; making it again`);
    const st = this.request(row.id, "play");
    return new Response(JSON.stringify({ state: st.state, progress: st.progress, error: st.error }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "2" },
    });
  }

  /**
   * Quit: drop the queue and kill the job in flight. A Fallback is rebuildable, and a job left running would keep the
   * app alive for minutes after its port closed (audit PLAY-2, PLAY-6). Resolves once the queue is idle.
   */
  async shutdown(maxWaitMs = 5000) {
    this.stopping = true;
    for (const [id, j] of this.jobs) if (j.state === "queued") this.jobs.delete(id);
    if (!this.current) return;
    this.stopJob(this.current, "shutdown");
    await Promise.race([new Promise<void>((r) => this.drained.push(r)), new Promise<void>((r) => setTimeout(r, maxWaitMs).unref?.())]);
  }

  /** The second Ctrl-C: kill the running ffmpeg now, no waiting. */
  kill() {
    this.stopping = true;
    if (this.current) this.stopJob(this.current, "shutdown");
  }
}
