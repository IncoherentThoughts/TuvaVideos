import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { extensionOf } from "./filename";
import { log } from "./log";
import type { Playback } from "./playback";

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

/**
 * One ffmpeg Fallback job at a time (spec 3.4). Play-requested jobs run before scan-time jobs.
 * Output goes to remux/<copyId>.<ext> via a temp name, then the copy row records it.
 */
export class FallbackQueue {
  private jobs = new Map<number, Job>();
  private current: Job | null = null;
  private stopping = false;
  private drained: (() => void)[] = [];

  constructor(
    private db: Db,
    private cfg: Pick<Config, "ffmpeg" | "remuxDir">,
    private rootAvailable: (rootId: number) => boolean,
  ) {
    mkdirSync(cfg.remuxDir, { recursive: true });
  }

  /** Forget Fallback files that vanished from remux/ (spec: cached, so rebuildable). */
  async verifyFiles() {
    const rows = this.db.query("SELECT id, fallback_file FROM copy WHERE fallback_file IS NOT NULL").all() as { id: number; fallback_file: string }[];
    for (const r of rows) {
      if (!existsSync(join(this.cfg.remuxDir, r.fallback_file))) {
        this.db.prepare("UPDATE copy SET fallback_file = NULL WHERE id = ?").run(r.id);
        log(`fallback file missing, cleared: ${r.fallback_file}`);
      }
    }
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

  /** Queue a job. A play request jumps the queue and upgrades an already-queued scan job. */
  request(copyId: number, priority: "play" | "scan"): FallbackStatus {
    const st = this.status(copyId);
    if (st.state === "ready" || st.state === "none" && !this.needsFallback(copyId)) return st;
    const existing = this.jobs.get(copyId);
    if (existing && existing.state !== "failed") {
      if (priority === "play") existing.priority = "play";
    } else if (!this.stopping) {
      this.jobs.set(copyId, { copyId, priority, state: "queued", progress: 0 });
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

  private async pump() {
    if (this.current) return;
    const job = this.stopping ? undefined : this.next();
    if (!job) {
      for (const r of this.drained.splice(0)) r();
      return;
    }
    this.current = job;
    job.state = "running";
    try {
      await this.runJob(job);
      this.jobs.delete(job.copyId);
    } catch (e) {
      job.state = "failed";
      job.error = String((e as Error).message ?? e).slice(0, 300);
      log(`fallback job for copy ${job.copyId} failed: ${job.error}`);
    } finally {
      this.current = null;
      void this.pump();
    }
  }

  private info(copyId: number): CopyInfo | null {
    return this.db
      .query(
        `SELECT c.id, c.rel_path, r.path AS root_path, c.playback, c.duration_s, c.fallback_file, c.missing_since, c.root_id
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

  private async runJob(job: Job) {
    const c = this.info(job.copyId);
    if (!c || c.playback === "native") return;
    if (c.fallback_file) return;
    if (c.missing_since || !this.rootAvailable(c.root_id)) throw new Error("Copy is not available");
    const src = join(c.root_path, c.rel_path);
    const ext = extensionOf(src);
    const sibling = c.playback === "remux" ? await this.findAudioSibling(src) : null;
    const tmpBase = join(this.cfg.remuxDir, `${c.id}.tmp`);
    const plan = fallbackPlan(c.playback, src, ext, sibling, `${tmpBase}.${ext === "webm" && c.playback === "transcode" ? "mkv" : ext}`);
    const tmpOut = plan.args[plan.args.length - 1]!;
    const finalName = `${c.id}.${plan.outExt}`;
    log(`fallback ${c.playback} start (${job.priority}): copy ${c.id} ${c.rel_path}${sibling ? " + " + basename(sibling) : ""}`);
    const t0 = Date.now();
    await rm(tmpOut, { force: true });
    await new Promise<void>((resolve, reject) => {
      const p = spawn(this.cfg.ffmpeg, plan.args, { stdio: ["ignore", "pipe", "pipe"] });
      job.proc = p;
      let err = "";
      let buf = "";
      p.stdout.on("data", (d) => {
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
      p.on("error", reject);
      p.on("close", (code, sig) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${sig ?? code}: ${err.trim().slice(-250)}`))));
    }).catch(async (e) => {
      await rm(tmpOut, { force: true });
      throw e;
    });
    const st = await stat(tmpOut);
    if (st.size === 0) throw new Error("ffmpeg produced an empty file");
    await rename(tmpOut, join(this.cfg.remuxDir, finalName));
    this.db.prepare("UPDATE copy SET fallback_file = ? WHERE id = ?").run(finalName, c.id);
    job.progress = 1;
    log(`fallback ${c.playback} done: copy ${c.id} -> ${finalName} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  /** SIGINT: let the job in flight finish, drop the rest. */
  async shutdown() {
    this.stopping = true;
    for (const [id, j] of this.jobs) if (j.state === "queued") this.jobs.delete(id);
    if (this.current) await new Promise<void>((r) => this.drained.push(r));
  }
}
