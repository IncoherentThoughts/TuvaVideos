// The Download queue (downloader-spec §4.1–4.2, 4.5–4.8, §5.4): persisted jobs and items in `library.db`, two slots, offline
// and per-site backoff, pause, cancel, retry, resume after a restart, retention. No HTTP and no yt-dlp here: the runner,
// the clock, the timers, the connectivity probe and the scan-in are injected, so the tests drive every branch with stubs
// or with the fake yt-dlp (`test/fixtures/fake-yt-dlp.ts`) and never sleep.

import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Db } from "../db";
import { log } from "../log";
import type { Cookies, Quality, Source } from "./args";
import { normQuality, storedQuality, type StoredQuality } from "../../shared/downloadEstimate";
import type { FailureReason } from "./classify";
import { failureReport, reportFileName, type ReportItem } from "./report";
import { runItem, sizeItem, type ItemEvent, type ItemRun, type ItemSpec } from "./runItem";
import { getSetting, setSetting } from "./toolsInstall";

export type ItemState = "queued" | "sizing" | "downloading" | "merging" | "scanning" | "done" | "waiting" | "failed" | "cancelled" | "skipped" | "done_outside";
export const LIVE_STATES: readonly ItemState[] = ["queued", "sizing", "downloading", "merging", "scanning", "waiting"];
export const ACTIVE_STATES: readonly ItemState[] = ["sizing", "downloading", "merging", "scanning"];
const LIVE_SQL = LIVE_STATES.map((s) => `'${s}'`).join(", ");
const ACTIVE_SQL = ACTIVE_STATES.map((s) => `'${s}'`).join(", ");

export const SLOTS = 2;
export const RATE_LIMIT_MINUTES = [1, 5, 10] as const;
export const PROBE_FIRST_MS = 15_000;
export const PROBE_MAX_MS = 120_000;
export const IG_PAUSE_MIN_MS = 3_000;
export const IG_PAUSE_SPAN_MS = 5_000;
const JS_POLL_MS = 30_000;
const PREPARE_EVERY_MS = 10 * 60_000;
const RECENT_DONE_MS = 30_000;
const LOG_BUFFER = 5000;

export class QueueError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface JobRow {
  id: number;
  kind: "bulk" | "card";
  option: string | null;
  quality: "720" | "1080" | "best";
  dest_dir: string;
  dest_root_id: number | null;
  created_at: string;
  finished_at: string | null;
  cancelled_at: string | null;
}
export interface ItemRow {
  id: number;
  job_id: number;
  video_id: string;
  source: Source;
  source_url: string;
  title: string;
  queue_pos: number;
  state: ItemState;
  reason: string | null;
  error_line: string | null;
  est_bytes: number | null;
  exact_bytes: number | null;
  done_bytes: number | null;
  speed_bps: number | null;
  eta_s: number | null;
  attempts: number;
  not_before: string | null;
  file_path: string | null;
  log_path: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Runner {
  size: typeof sizeItem;
  run(spec: ItemSpec, onEvent: (e: ItemEvent) => void): ItemRun;
}
export const realRunner: Runner = { size: sizeItem, run: runItem };

export interface ToolSet {
  ytDlpPath: string;
  ffmpegLocation: string;
  /** A deno binary for `--js-runtimes deno:<path>`; null when there is none. */
  jsRuntime: string | null;
  env?: Record<string, string>;
}

export interface QueueDeps {
  db: Db;
  dataDir: string;
  runner?: Runner;
  /** yt-dlp and friends, or null when yt-dlp is not installed. */
  tools: () => Promise<ToolSet | null>;
  /** Called when the runner goes from idle to busy (`updateYtDlpIfDue`, §2.3); never beside a live yt-dlp. */
  beforeJob?: () => Promise<unknown>;
  /** `HEAD https://www.youtube.com/generate_204` with a 5 s timeout (§4.5). */
  probe: () => Promise<boolean>;
  /** The Root that contains `dir`, or null when it is outside every Root. */
  rootFor: (dir: string) => { id: number; path: string } | null;
  rootAvailable: (rootId: number) => boolean;
  /** The first mounted Root in Root order (a card's destination). */
  defaultRoot: () => { id: number; path: string } | null;
  scanFile: (rootId: number, relPath: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** A Copy appeared by other means (§4.2 `skipped`). Default: a non-Missing Copy of the Video. */
  hasCopy?: (videoId: string) => boolean;
  /** Is a JS runtime installed now (§4.4 `no_js_runtime`). Default: always true. */
  jsRuntimeAvailable?: () => Promise<boolean>;
  /** The Instagram cookies for the one retry after a login wall (§5.4), or null when none are configured or they expired. */
  instagramCookies?: () => Cookies | null;
  /** The cookies retry's outcome (§5.4): `worked` sets `lastWorkedAt`, `expired` flips the auth row's `expired` (§5.2). */
  onInstagramCookies?: (outcome: "worked" | "expired") => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  windows?: boolean;
}

interface Ctl {
  itemId: number;
  source: Source;
  /** Set when the row has been taken over by whoever killed it: this run must write nothing more. */
  dead: boolean;
  run: ItemRun | null;
}

export type StartReq = { option: string; quality: string; destDir: string; videoIds: string[]; estBytes?: Record<string, number> };
export type CardReq = { videoId: string; quality?: string; destDir?: string };

const OPTIONS = new Set(["full", "random", "type", "artist", "favorites"]);
const iso = (ms: number) => new Date(ms).toISOString();

/** A request's quality in the stored spelling; the wire's canonical `720p` / `1080p` / `best` and the legacy `720` / `1080`. */
export function normStoredQuality(q: unknown): StoredQuality | null {
  const c = normQuality(q);
  return c ? storedQuality(c) : null;
}

export function sourceUrlOf(source: Source, id: string): string {
  if (source === "youtube") return `https://www.youtube.com/watch?v=${id}`;
  if (source === "instagram") return `https://www.instagram.com/p/${id}/`;
  return `https://rutube.ru/video/${id}/`;
}

/** The source's own id out of an item's URL: what the file name carries in `[...]` (§4.3). */
export function fileTagOf(source: Source, url: string): string | null {
  try {
    const u = new URL(url);
    if (source === "youtube") return u.searchParams.get("v");
    if (source === "instagram") {
      const m = u.pathname.match(/\/(?:p|reel|tv)\/([^/]+)/);
      return m ? `instagram-${m[1]}` : null;
    }
    const m = u.pathname.match(/\/video\/([0-9a-f]{32})/i);
    return m ? `rutube-${m[1]}` : null;
  } catch {
    return null;
  }
}

/**
 * `abs` relative to `rootPath` with `/` separators, or null when it is not inside. yt-dlp reports the path from its
 * working directory, which the OS resolves (macOS `/var` is `/private/var`), so a plain prefix check is tried first and
 * the real paths second.
 */
export function relInRoot(rootPath: string, abs: string): string | null {
  const inside = (root: string, p: string) => {
    const r = relative(root, p);
    return r && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r) ? r.split(sep).join("/") : null;
  };
  const direct = inside(rootPath, abs);
  if (direct) return direct;
  try {
    return inside(realpathSync(rootPath), join(realpathSync(dirname(abs)), basename(abs)));
  } catch {
    return null;
  }
}

const PARTIAL_SEGMENT = /^(f\d+|part|part-frag\d+|temp|ytdl)$/i;

export class DownloadQueue {
  private readonly db: Db;
  private readonly runner: Runner;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private running = new Map<number, Ctl>();
  private paused: boolean;
  /** False after a restart until Resume, a Confirm or a card click (§4.7). */
  private started = false;
  private offline: { since: number; delay: number; nextProbeAt: number } | null = null;
  private diskFull: { dir: string } | null = null;
  private sitePause = new Map<Source, number>();
  private siteStrikes = new Map<Source, number>();
  private rlCount = new Map<number, number>();
  private jsTried = new Set<number>();
  private igNextAt = 0;
  private preparing: Promise<unknown> | null = null;
  private lastPrepare = -Infinity;
  private wakeTimer: unknown = null;
  private probeTimer: unknown = null;
  private jsTimer: unknown = null;
  private closed = false;
  private waiters: (() => void)[] = [];
  private resumeJobId: number | null = null;
  private recent = new Map<string, { itemId: number; at: number }>();
  private logs = new Map<number, { lines: { itemId: number; text: string }[]; base: number; offsets: Map<number, number> }>();

  constructor(private deps: QueueDeps) {
    this.db = deps.db;
    this.runner = deps.runner ?? realRunner;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.paused = getSetting(this.db, "queue_paused") === "1";
    this.recover();
  }

  // ---- startup (§4.7) -------------------------------------------------------------------------------------------

  /** At startup the runner starts nothing: live items go back to `queued` and the first tab is offered Resume or Discard. */
  private recover() {
    try {
      this.db
        .prepare(`UPDATE download_item SET state = 'queued', reason = NULL, not_before = NULL, speed_bps = NULL, eta_s = NULL WHERE state IN ('sizing', 'downloading', 'merging', 'scanning', 'waiting')`)
        .run();
      for (const j of this.db.query("SELECT id FROM download_job WHERE finished_at IS NULL AND cancelled_at IS NULL").all() as { id: number }[]) this.checkJobFinished(j.id);
      const row = this.db
        .query(
          `SELECT j.id FROM download_job j WHERE j.finished_at IS NULL AND j.cancelled_at IS NULL
             AND EXISTS (SELECT 1 FROM download_item i WHERE i.job_id = j.id AND i.state IN (${LIVE_SQL}))
           ORDER BY (j.kind = 'bulk') DESC, j.id LIMIT 1`,
        )
        .get() as { id: number } | null;
      this.resumeJobId = row?.id ?? null;
    } catch (e) {
      log(`downloads: recover failed: ${e}`);
    }
  }

  // ---- reading rows ---------------------------------------------------------------------------------------------

  private item(id: number): ItemRow | null {
    return (this.db.query("SELECT * FROM download_item WHERE id = ?").get(id) as ItemRow | null) ?? null;
  }
  private job(id: number): JobRow | null {
    return (this.db.query("SELECT * FROM download_job WHERE id = ?").get(id) as JobRow | null) ?? null;
  }
  private patch(id: number, p: Record<string, string | number | null>) {
    const keys = Object.keys(p);
    if (!keys.length) return;
    this.db.prepare(`UPDATE download_item SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => p[k]!), id);
  }
  private note(item: Pick<ItemRow, "log_path">, text: string) {
    try {
      mkdirSync(dirname(item.log_path), { recursive: true });
      appendFileSync(item.log_path, `[queue] ${text}\n`);
    } catch {
      /* the log is a convenience */
    }
  }

  runningCount(): number {
    return this.running.size;
  }
  isPaused() {
    return this.paused;
  }

  // ---- adding work (§4.1, §6) -----------------------------------------------------------------------------------

  private minPos(): number {
    return ((this.db.query(`SELECT MIN(queue_pos) AS m FROM download_item WHERE state IN (${LIVE_SQL})`).get() as { m: number | null }).m ?? 0) - 1;
  }
  private maxPos(): number {
    return (this.db.query("SELECT MAX(queue_pos) AS m FROM download_item").get() as { m: number | null }).m ?? 0;
  }

  private videosFor(ids: string[]) {
    const out = new Map<string, { id: string; youtube_id: string | null; instagram_id: string | null; rutube_id: string | null; title: string; deleted_at: string | null }>();
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      const rows = this.db
        .query(`SELECT id, youtube_id, instagram_id, rutube_id, title, deleted_at FROM videos WHERE id IN (${part.map(() => "?").join(",")})`)
        .all(...part) as any[];
      for (const r of rows) out.set(r.id, r);
    }
    return out;
  }
  private hasCopy(videoId: string): boolean {
    if (this.deps.hasCopy) return this.deps.hasCopy(videoId);
    return !!this.db.query("SELECT 1 FROM copy WHERE video_id = ? AND missing_since IS NULL LIMIT 1").get(videoId);
  }

  private destination(destDir: string): { dir: string; rootId: number | null } {
    if (!isAbsolute(destDir)) throw new QueueError(400, "destDir must be an absolute path");
    const dir = resolve(destDir);
    const root = this.deps.rootFor(dir);
    if (root && !this.deps.rootAvailable(root.id)) throw new QueueError(409, `${root.path} is not mounted`);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new QueueError(400, `cannot use ${dir}: ${(e as Error).message}`);
    }
    return { dir, rootId: root?.id ?? null };
  }

  private newJob(kind: "bulk" | "card", option: string | null, quality: string, dir: string, rootId: number | null): number {
    const r = this.db
      .prepare("INSERT INTO download_job (kind, option, quality, dest_dir, dest_root_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(kind, option, quality, dir, rootId, iso(this.now()));
    return Number(r.lastInsertRowid);
  }
  /** Confirm in the download dialog (§6 `POST /jobs`). Videos already live in another job move into this one. */
  addBulk(req: StartReq): { jobId: number; added: number; moved: number; alreadyRunning: number; rejected: { videoId: string; why: string }[] } {
    if (!OPTIONS.has(req.option)) throw new QueueError(400, "option must be full, random, type, artist or favorites");
    const quality = normStoredQuality(req.quality);
    if (!quality) throw new QueueError(400, "quality must be 720p, 1080p or best");
    if (!Array.isArray(req.videoIds) || !req.videoIds.length) throw new QueueError(400, "no Videos picked");
    const { dir, rootId } = this.destination(req.destDir);
    const ids = [...new Set(req.videoIds.map(String))];
    const videos = this.videosFor(ids);
    const rejected: { videoId: string; why: string }[] = [];
    const picks: { id: string; source: Source; sourceId: string; title: string; est: number | null }[] = [];
    for (const id of ids) {
      const v = videos.get(id);
      if (!v || v.deleted_at) {
        rejected.push({ videoId: id, why: "unknown Video" });
        continue;
      }
      const [source, sourceId] = v.youtube_id ? (["youtube", v.youtube_id] as const) : v.instagram_id ? (["instagram", v.instagram_id] as const) : v.rutube_id ? (["rutube", v.rutube_id] as const) : [null, null];
      if (!source || !sourceId) {
        rejected.push({ videoId: id, why: "no source id" });
        continue;
      }
      if (this.hasCopy(id)) {
        rejected.push({ videoId: id, why: "already on this machine" });
        continue;
      }
      const est = req.estBytes?.[id];
      picks.push({ id, source, sourceId, title: v.title, est: typeof est === "number" && est > 0 ? Math.round(est) : null });
    }
    if (!picks.length) throw new QueueError(400, "nothing to download", { rejected });

    const stale: { id: number; dir: string }[] = [];
    let jobId = 0;
    let added = 0;
    let moved = 0;
    let alreadyRunning = 0;
    const touched = new Set<number>();
    this.db.transaction(() => {
      // Retention (§4.8): only the latest bulk job is kept, so the older finished ones go now.
      for (const j of this.db.query("SELECT id FROM download_job WHERE kind = 'bulk' AND finished_at IS NOT NULL").all() as { id: number }[]) {
        this.db.prepare("DELETE FROM download_item WHERE job_id = ?").run(j.id);
        this.db.prepare("DELETE FROM download_job WHERE id = ?").run(j.id);
        stale.push({ id: j.id, dir: this.jobDir(j.id) });
      }
      jobId = this.newJob("bulk", req.option, quality, dir, rootId);
      let pos = this.maxPos();
      for (const p of picks) {
        const live = this.db.query(`SELECT * FROM download_item WHERE video_id = ? AND state IN (${LIVE_SQL})`).get(p.id) as ItemRow | null;
        if (live) {
          if (live.state === "queued" || live.state === "waiting") {
            this.db.prepare("UPDATE download_item SET job_id = ?, queue_pos = ?, state = 'queued', reason = NULL, not_before = NULL WHERE id = ?").run(jobId, ++pos, live.id);
            touched.add(live.job_id);
            moved++;
          } else alreadyRunning++;
          continue;
        }
        // A failed or finished item of the same Video in an older job is left where it is; this one is new.
        this.insertItemRow(jobId, p.id, p.source, sourceUrlOf(p.source, p.sourceId), p.title, ++pos, p.est);
        added++;
      }
      if (!added && !moved) throw new QueueError(409, "every picked Video is already downloading", { rejected });
    })();
    for (const s of stale) rmSync(s.dir, { recursive: true, force: true });
    for (const j of touched) this.checkJobFinished(j);
    this.started = true;
    this.resumeJobId = null;
    this.tick();
    return { jobId, added, moved, alreadyRunning, rejected };
  }

  private insertItemRow(jobId: number, videoId: string, source: Source, url: string, title: string, pos: number, est: number | null): number {
    const r = this.db
      .prepare("INSERT INTO download_item (job_id, video_id, source, source_url, title, queue_pos, state, est_bytes, log_path) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, '')")
      .run(jobId, videoId, source, url, title, pos, est);
    const id = Number(r.lastInsertRowid);
    this.db.prepare("UPDATE download_item SET log_path = ? WHERE id = ?").run(join(this.jobDir(jobId), `${id}.log`), id);
    return id;
  }
  private jobDir(jobId: number) {
    return join(this.deps.dataDir, "downloads", String(jobId));
  }

  /** A card's download button (§6 `POST /card`): a job of one at the front, or the Video's live item moved to the front. */
  addCard(req: CardReq): { jobId: number; itemId: number; moved: boolean } {
    const id = String(req.videoId ?? "");
    const live = this.db.query(`SELECT * FROM download_item WHERE video_id = ? AND state IN (${LIVE_SQL})`).get(id) as ItemRow | null;
    if (live) {
      if (live.state === "queued" || live.state === "waiting") this.patch(live.id, { queue_pos: this.minPos() });
      this.started = true;
      this.resumeJobId = null;
      this.tick();
      return { jobId: live.job_id, itemId: live.id, moved: true };
    }
    const v = this.videosFor([id]).get(id);
    if (!v || v.deleted_at) throw new QueueError(404, "unknown Video");
    const [source, sourceId] = v.youtube_id ? (["youtube", v.youtube_id] as const) : v.instagram_id ? (["instagram", v.instagram_id] as const) : v.rutube_id ? (["rutube", v.rutube_id] as const) : [null, null];
    if (!source || !sourceId) throw new QueueError(400, "this Video has no source id");
    if (this.hasCopy(id)) throw new QueueError(409, "this Video is already on this machine");
    let quality = req.quality === undefined ? null : normStoredQuality(req.quality);
    if (req.quality !== undefined && !quality) throw new QueueError(400, "quality must be 720p, 1080p or best");
    quality ??= (this.db.query("SELECT quality FROM download_job ORDER BY id DESC LIMIT 1").get() as { quality: "720" | "1080" | "best" } | null)?.quality ?? "1080";
    let dest: { dir: string; rootId: number | null };
    if (req.destDir) dest = this.destination(req.destDir);
    else {
      const root = this.deps.defaultRoot();
      if (!root) throw new QueueError(409, "no Root is mounted");
      dest = this.destination(root.path);
    }
    let jobId = 0;
    let itemId = 0;
    const stale: { id: number; dir: string }[] = [];
    this.db.transaction(() => {
      // An older failed card job for this Video is replaced by the new click.
      for (const o of this.db.query("SELECT i.id, i.job_id FROM download_item i JOIN download_job j ON j.id = i.job_id WHERE i.video_id = ? AND j.kind = 'card' AND i.state IN ('failed', 'cancelled')").all(id) as { id: number; job_id: number }[]) {
        this.db.prepare("DELETE FROM download_item WHERE id = ?").run(o.id);
        if (!(this.db.query("SELECT 1 FROM download_item WHERE job_id = ?").get(o.job_id))) {
          this.db.prepare("DELETE FROM download_job WHERE id = ?").run(o.job_id);
          stale.push({ id: o.job_id, dir: this.jobDir(o.job_id) });
        }
      }
      jobId = this.newJob("card", null, quality!, dest.dir, dest.rootId);
      itemId = this.insertItemRow(jobId, id, source, sourceUrlOf(source, sourceId), v.title, this.minPos(), null);
    })();
    for (const s of stale) rmSync(s.dir, { recursive: true, force: true });
    this.started = true;
    this.resumeJobId = null;
    this.tick();
    return { jobId, itemId, moved: false };
  }

  // ---- the scheduler (§4.5) -------------------------------------------------------------------------------------

  private promoteWaiting() {
    const t = iso(this.now());
    this.db.prepare("UPDATE download_item SET state = 'queued', reason = NULL, not_before = NULL WHERE state = 'waiting' AND not_before IS NOT NULL AND not_before <= ?").run(t);
  }

  private pickNext(): (ItemRow & { dest_dir: string; dest_root_id: number | null; quality: JobRow["quality"] }) | null {
    const now = this.now();
    const t = iso(now);
    const igRunning = [...this.running.values()].some((c) => c.source === "instagram");
    const rows = this.db
      .query(
        `SELECT i.*, j.dest_dir, j.dest_root_id, j.quality FROM download_item i JOIN download_job j ON j.id = i.job_id
         WHERE i.state = 'queued' AND j.cancelled_at IS NULL ORDER BY i.queue_pos, i.id`,
      )
      .all() as (ItemRow & { dest_dir: string; dest_root_id: number | null; quality: JobRow["quality"] })[];
    for (const r of rows) {
      if (r.not_before && r.not_before > t) continue;
      if ((this.sitePause.get(r.source) ?? 0) > now) continue;
      if (r.source === "instagram" && (igRunning || this.igNextAt > now)) continue;
      if (r.dest_root_id !== null && !this.deps.rootAvailable(r.dest_root_id)) continue;
      return r;
    }
    return null;
  }

  /** Fills the slots. Synchronous: everything slow happens in `execute`. */
  tick() {
    if (this.closed || !this.started || this.paused || this.offline) {
      this.clearWake();
      this.checkSettled();
      return;
    }
    if (this.preparing) return;
    this.promoteWaiting();
    if (this.running.size === 0 && this.deps.beforeJob && this.now() - this.lastPrepare >= PREPARE_EVERY_MS && this.pickNext()) {
      this.lastPrepare = this.now();
      this.preparing = Promise.resolve()
        .then(() => this.deps.beforeJob!())
        .catch((e) => log(`downloads: pre-job update failed: ${e}`))
        .finally(() => {
          this.preparing = null;
          this.tick();
        });
      return;
    }
    while (this.running.size < SLOTS) {
      const next = this.pickNext();
      if (!next) break;
      this.start(next);
    }
    this.scheduleWake();
    this.checkSettled();
  }

  private clearWake() {
    if (this.wakeTimer !== null) this.clearTimer(this.wakeTimer);
    this.wakeTimer = null;
  }
  private scheduleWake() {
    this.clearWake();
    const now = this.now();
    let next = Infinity;
    for (const u of this.sitePause.values()) if (u > now) next = Math.min(next, u);
    if (this.igNextAt > now && this.db.query("SELECT 1 FROM download_item WHERE source = 'instagram' AND state = 'queued' LIMIT 1").get()) next = Math.min(next, this.igNextAt);
    const nb = (this.db.query("SELECT MIN(not_before) AS m FROM download_item WHERE state IN ('queued', 'waiting') AND not_before IS NOT NULL").get() as { m: string | null }).m;
    if (nb) next = Math.min(next, Date.parse(nb));
    if (Number.isFinite(next)) this.wakeTimer = this.setTimer(() => ((this.wakeTimer = null), this.tick()), Math.max(0, next - now) + 1);
  }

  /** Resolves when nothing is running and nothing more can start (for tests and for a graceful shutdown). */
  settled(): Promise<void> {
    return this.running.size === 0 && !this.preparing ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
  }
  private checkSettled() {
    if (this.running.size === 0 && !this.preparing) for (const w of this.waiters.splice(0)) w();
  }

  private start(item: ItemRow & { dest_dir: string; dest_root_id: number | null; quality: JobRow["quality"] }) {
    if (this.hasCopy(item.video_id)) {
      this.note(item, "skipped: a Copy of this Video appeared by other means");
      this.patch(item.id, { state: "skipped", finished_at: iso(this.now()) });
      this.checkJobFinished(item.job_id);
      return;
    }
    const ctl: Ctl = { itemId: item.id, source: item.source, dead: false, run: null };
    this.running.set(item.id, ctl);
    this.patch(item.id, { state: "sizing", reason: null, error_line: null, not_before: null, attempts: item.attempts + 1, speed_bps: null, eta_s: null });
    this.launch(item, ctl, null);
  }

  private launch(item: ItemRow & { dest_dir: string; quality: JobRow["quality"] }, ctl: Ctl, cookies: Cookies | null) {
    void this.execute(item, ctl, cookies).catch((e) => {
      log(`downloads: item ${item.id} crashed: ${e}`);
      if (!ctl.dead) this.fail(item, ctl, "unknown", `internal error: ${(e as Error).message ?? e}`);
    });
  }

  private release(ctl: Ctl) {
    ctl.dead = true;
    this.running.delete(ctl.itemId);
  }

  /** `cookies`: the Instagram retry after a login wall (§5.4); every first run is signed out (§5.1). */
  private async execute(item: ItemRow & { dest_dir: string; quality: JobRow["quality"] }, ctl: Ctl, cookies: Cookies | null) {
    const tools = await this.deps.tools();
    if (ctl.dead) return;
    if (!tools) return this.fail(item, ctl, "unknown", "yt-dlp is not installed");
    const quality: Quality = item.quality === "best" ? "best" : (`${item.quality}p` as Quality);
    const base = {
      url: item.source_url,
      source: item.source,
      quality,
      ffmpegLocation: tools.ffmpegLocation,
      jsRuntime: tools.jsRuntime,
      ytDlpPath: tools.ytDlpPath,
      cwd: item.dest_dir,
      logPath: item.log_path,
      env: tools.env,
      windows: this.deps.windows ?? process.platform === "win32",
      cookies,
    } satisfies Omit<ItemSpec, "mergeFormat" | "exactBytes">;

    const sized = await this.runner.size(base);
    if (ctl.dead) return;
    if (!sized.ok) return this.onFailure(item, ctl, sized.reason, sized.errorLine, cookies);
    this.patch(item.id, { state: "downloading", exact_bytes: sized.sizing.exactBytes, started_at: iso(this.now()), done_bytes: 0 });
    const run = this.runner.run({ ...base, exactBytes: sized.sizing.exactBytes, mergeFormat: sized.sizing.mergeFormat }, (e) => {
      if (ctl.dead) return;
      if (e.type === "progress") {
        const p: Record<string, number | null> = { done_bytes: e.doneBytes, speed_bps: e.speed, eta_s: e.eta };
        if (sized.sizing.exactBytes === null && e.totalBytes !== null) p.exact_bytes = e.totalBytes;
        this.patch(item.id, p);
      } else if (e.type === "merging") this.patch(item.id, { state: "merging", speed_bps: null, eta_s: null });
      else this.patch(item.id, { file_path: e.path });
    });
    ctl.run = run;
    const out = await run.done;
    if (ctl.dead) return;
    if (!out.ok) return this.onFailure(item, ctl, out.reason, out.errorLine, cookies);
    if (cookies) this.deps.onInstagramCookies?.("worked");

    // §4.6: the file becomes a Copy.
    this.patch(item.id, { state: "scanning", file_path: out.filePath, speed_bps: null, eta_s: null });
    const abs = isAbsolute(out.filePath) ? out.filePath : join(item.dest_dir, out.filePath);
    const root = this.job(item.job_id)?.dest_root_id ?? null;
    const rootPath = root === null ? null : this.rootPathOf(root);
    const rel = rootPath ? relInRoot(rootPath, abs) : null;
    let size: number | null = null;
    try {
      size = statSync(abs).size;
    } catch {
      /* gone: the scan says so */
    }
    if (root === null || rel === null) {
      return this.finishOk(item, ctl, "done_outside", abs, size);
    }
    const res = await this.deps.scanFile(root, rel);
    if (ctl.dead) return;
    if (!res.ok) return this.fail(item, ctl, "unknown", res.error);
    return this.finishOk(item, ctl, "done", abs, size);
  }

  private rootPathOf(rootId: number): string | null {
    return (this.db.query("SELECT path FROM root WHERE id = ?").get(rootId) as { path: string } | null)?.path ?? null;
  }

  private finishOk(item: ItemRow, ctl: Ctl, state: "done" | "done_outside", abs: string, size: number | null) {
    this.release(ctl);
    const t = this.now();
    this.patch(item.id, { state, file_path: abs, done_bytes: size ?? this.item(item.id)?.exact_bytes ?? null, speed_bps: null, eta_s: null, finished_at: iso(t) });
    this.siteStrikes.delete(item.source);
    this.rlCount.delete(item.id);
    this.afterRun(item, t);
    this.recent.set(item.video_id, { itemId: item.id, at: t });
    this.checkJobFinished(item.job_id);
    this.tick();
  }

  /** Common tail of every run that ended on its own (not killed): the Instagram pause (§5.4). */
  private afterRun(item: ItemRow, t = this.now()) {
    if (item.source === "instagram") this.igNextAt = t + IG_PAUSE_MIN_MS + Math.floor(this.random() * IG_PAUSE_SPAN_MS);
  }

  private fail(item: ItemRow, ctl: Ctl, reason: FailureReason, errorLine: string | null) {
    this.release(ctl);
    const t = this.now();
    this.note(item, `failed: ${reason}${errorLine ? ` — ${errorLine}` : ""}`);
    this.patch(item.id, { state: "failed", reason, error_line: errorLine, speed_bps: null, eta_s: null, finished_at: iso(t) });
    this.afterRun(item, t);
    this.checkJobFinished(item.job_id);
    this.tick();
  }

  /** A run or sizing pass ended in failure (§4.4 → §4.5, §5.4). */
  private onFailure(item: ItemRow & { dest_dir: string; quality: JobRow["quality"] }, ctl: Ctl, reason: FailureReason, errorLine: string | null, usedCookies: Cookies | null) {
    switch (reason) {
      case "network":
        return this.goOffline(item, ctl);
      case "rate_limited":
      case "youtube_signin":
        return this.rateLimited(item, ctl, errorLine);
      case "disk_full":
        this.pauseForDisk(item, ctl);
        return this.fail(item, ctl, "disk_full", errorLine);
      case "no_js_runtime":
        return this.noRuntime(item, ctl, errorLine);
      case "login_wall":
        if (item.source === "instagram" && !usedCookies) {
          // §5.4: one immediate retry with cookies when they are configured; without them the rest of the job's
          // Instagram items would only hit the same wall.
          const c = this.deps.instagramCookies?.() ?? null;
          if (c) {
            this.note(item, `login wall: trying once more with cookies (${"file" in c ? "cookies.txt" : `from ${c.browser}`})`);
            this.patch(item.id, { state: "sizing", reason: null, error_line: null, speed_bps: null, eta_s: null });
            return this.launch(item, ctl, c);
          }
          this.markNeedsSignin(item.job_id);
        }
        return this.fail(item, ctl, "login_wall", errorLine);
      case "cookies_expired":
        if (usedCookies) this.deps.onInstagramCookies?.("expired");
        return this.fail(item, ctl, "cookies_expired", errorLine);
      default:
        return this.fail(item, ctl, reason, errorLine);
    }
  }

  /** §5.4: the first login wall of a job without cookies: every Instagram Video still waiting is marked, not tried. */
  private markNeedsSignin(jobId: number) {
    const t = iso(this.now());
    const rows = this.db.query("SELECT * FROM download_item WHERE job_id = ? AND source = 'instagram' AND state IN ('queued', 'waiting')").all(jobId) as ItemRow[];
    for (const r of rows) {
      this.note(r, "needs sign-in: not tried");
      this.patch(r.id, { state: "failed", reason: "needs_signin", error_line: null, finished_at: t, not_before: null });
    }
    this.checkJobFinished(jobId);
  }

  // ---- offline, rate limits, disk, runtime ------------------------------------------------------------------------

  private requeue(item: ItemRow, to: "queued" | "waiting", p: Record<string, string | number | null> = {}) {
    this.patch(item.id, { state: to, attempts: Math.max(0, item.attempts), speed_bps: null, eta_s: null, ...p });
  }

  private goOffline(item: ItemRow, ctl: Ctl) {
    this.release(ctl);
    this.note(item, "network failure: waiting for a connection");
    this.requeue(item, "waiting", { reason: "network", attempts: Math.max(0, item.attempts - 1), not_before: null });
    if (!this.offline) {
      const t = this.now();
      this.offline = { since: t, delay: PROBE_FIRST_MS, nextProbeAt: t + PROBE_FIRST_MS };
      // The rest would only burn their retries against a dead line: stop them (partials stay) and wait with the others.
      for (const c of [...this.running.values()]) void this.stop(c, "waiting", { reason: "network" });
      this.armProbe();
    }
    this.tick();
  }

  private armProbe() {
    if (this.probeTimer !== null) this.clearTimer(this.probeTimer);
    const o = this.offline;
    if (!o || this.closed) return;
    this.probeTimer = this.setTimer(() => {
      this.probeTimer = null;
      void this.runProbe();
    }, Math.max(0, o.nextProbeAt - this.now()));
  }

  private async runProbe() {
    const o = this.offline;
    if (!o) return;
    let ok = false;
    try {
      ok = await this.deps.probe();
    } catch {
      ok = false;
    }
    if (!this.offline || this.closed) return;
    if (ok) {
      this.offline = null;
      this.db.prepare("UPDATE download_item SET state = 'queued', reason = NULL, not_before = NULL WHERE state = 'waiting' AND reason = 'network'").run();
      this.tick();
    } else {
      o.delay = Math.min(o.delay * 2, PROBE_MAX_MS);
      o.nextProbeAt = this.now() + o.delay;
      this.armProbe();
    }
  }

  private rateLimited(item: ItemRow, ctl: Ctl, errorLine: string | null) {
    const now = this.now();
    const c = (this.rlCount.get(item.id) ?? 0) + 1;
    this.rlCount.set(item.id, c);
    // A second item of the same site hitting the limit while it is already paused does not escalate the backoff.
    let until = this.sitePause.get(item.source) ?? 0;
    if (until <= now) {
      const s = (this.siteStrikes.get(item.source) ?? 0) + 1;
      this.siteStrikes.set(item.source, s);
      until = now + RATE_LIMIT_MINUTES[Math.min(s, RATE_LIMIT_MINUTES.length) - 1]! * 60_000;
      this.sitePause.set(item.source, until);
    }
    if (c >= 3) {
      this.rlCount.delete(item.id);
      return this.fail(item, ctl, "rate_limited", errorLine);
    }
    this.release(ctl);
    this.afterRun(item, now);
    this.note(item, `rate limited (${c}/3): ${item.source} paused until ${iso(until)}`);
    this.requeue(item, "waiting", { reason: "rate_limited", error_line: errorLine, not_before: iso(until) });
    this.tick();
  }

  /** Disk full (§4.5): the queue pauses before anything else can start; the other runs are stopped, partials kept. */
  private pauseForDisk(item: ItemRow, failing: Ctl) {
    this.diskFull = { dir: this.job(item.job_id)?.dest_dir ?? "" };
    this.paused = true;
    setSetting(this.db, "queue_paused", "1");
    for (const c of [...this.running.values()]) if (c !== failing) void this.stop(c, "queued");
  }

  private async noRuntime(item: ItemRow, ctl: Ctl, errorLine: string | null) {
    if (this.jsTried.has(item.id)) {
      this.jsTried.delete(item.id);
      return this.fail(item, ctl, "no_js_runtime", errorLine);
    }
    this.jsTried.add(item.id);
    const have = this.deps.jsRuntimeAvailable ? await this.deps.jsRuntimeAvailable() : true;
    if (ctl.dead) return;
    this.release(ctl);
    if (have) {
      // A runtime exists now: one more try.
      this.requeue(item, "queued", { reason: null, error_line: errorLine, attempts: Math.max(0, item.attempts - 1) });
    } else {
      this.note(item, "no JavaScript runtime: waiting until one is installed");
      this.requeue(item, "waiting", { reason: "no_js_runtime", error_line: errorLine, not_before: null, attempts: Math.max(0, item.attempts - 1) });
      this.armJsPoll();
    }
    this.tick();
  }

  private armJsPoll() {
    if (this.jsTimer !== null || this.closed) return;
    this.jsTimer = this.setTimer(() => {
      this.jsTimer = null;
      void (async () => {
        if (!this.db.query("SELECT 1 FROM download_item WHERE state = 'waiting' AND reason = 'no_js_runtime' LIMIT 1").get()) return;
        if (this.deps.jsRuntimeAvailable && (await this.deps.jsRuntimeAvailable())) {
          this.db.prepare("UPDATE download_item SET state = 'queued', reason = NULL WHERE state = 'waiting' AND reason = 'no_js_runtime'").run();
          this.tick();
        } else this.armJsPoll();
      })();
    }, JS_POLL_MS);
  }

  // ---- stopping things (§4.5) ---------------------------------------------------------------------------------------

  /**
   * Takes a running item over from its run: no more writes from it, the process gone (partials stay), the row set to
   * `to`. The attempt does not count.
   */
  private async stop(ctl: Ctl, to: "queued" | "waiting", extra: Record<string, string | number | null> = {}) {
    const item = this.item(ctl.itemId);
    this.release(ctl);
    if (item) this.requeue(item, to, { attempts: Math.max(0, item.attempts - 1), not_before: null, reason: null, ...extra });
    await ctl.run?.kill();
  }

  /** Kills every process and puts its item back in line; partials are kept. Returns how many were running. */
  async killAll(): Promise<number> {
    const all = [...this.running.values()];
    await Promise.all(all.map((c) => this.stop(c, "queued")));
    this.checkSettled();
    return all.length;
  }

  async shutdown() {
    this.closed = true;
    this.clearWake();
    for (const t of [this.probeTimer, this.jsTimer]) if (t !== null) this.clearTimer(t);
    this.probeTimer = this.jsTimer = null;
    await this.killAll();
  }

  async pause() {
    this.paused = true;
    setSetting(this.db, "queue_paused", "1");
    await Promise.all([...this.running.values()].map((c) => this.stop(c, "queued")));
    this.clearWake();
    this.checkSettled();
  }

  resume() {
    if (this.resumeJobId !== null && !this.started) {
      const j = this.job(this.resumeJobId);
      if (j?.dest_root_id != null && !this.deps.rootAvailable(j.dest_root_id)) throw new QueueError(409, `waiting for ${this.rootPathOf(j.dest_root_id) ?? "the Root"}`);
    }
    this.paused = false;
    setSetting(this.db, "queue_paused", "0");
    this.started = true;
    this.resumeJobId = null;
    if (this.diskFull) {
      // "free space and press Resume": the item the full disk stopped goes again.
      this.db.prepare("UPDATE download_item SET state = 'queued', reason = NULL, error_line = NULL, finished_at = NULL WHERE state = 'failed' AND reason = 'disk_full' AND job_id IN (SELECT id FROM download_job WHERE cancelled_at IS NULL)").run();
      this.diskFull = null;
      for (const j of this.db.query("SELECT id FROM download_job WHERE finished_at IS NOT NULL AND cancelled_at IS NULL").all() as { id: number }[]) {
        if (this.db.query(`SELECT 1 FROM download_item WHERE job_id = ? AND state IN (${LIVE_SQL})`).get(j.id)) this.db.prepare("UPDATE download_job SET finished_at = NULL WHERE id = ?").run(j.id);
      }
    }
    if (this.offline) void this.runProbe();
    this.tick();
  }

  /** Partial files of one Video (§4.5 Cancel): yt-dlp's leftovers whose name carries the item's id. Finished files stay. */
  private deletePartials(item: ItemRow, dir: string) {
    const tag = fileTagOf(item.source, item.source_url);
    if (!tag) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.includes(`[${tag}]`)) continue;
      if (!n.split(".").slice(1).some((s) => PARTIAL_SEGMENT.test(s))) continue;
      try {
        unlinkSync(join(dir, n));
      } catch {
        /* already gone */
      }
    }
  }

  private async cancelRow(item: ItemRow, job: JobRow) {
    const ctl = this.running.get(item.id);
    if (ctl) {
      this.release(ctl);
      await ctl.run?.kill();
    }
    this.deletePartials(item, job.dest_dir);
    this.note(item, "cancelled");
    this.patch(item.id, { state: "cancelled", speed_bps: null, eta_s: null, finished_at: iso(this.now()) });
    this.rlCount.delete(item.id);
    this.jsTried.delete(item.id);
  }

  async cancelItem(itemId: number) {
    const item = this.item(itemId);
    if (!item) throw new QueueError(404, "no such item");
    if (!LIVE_STATES.includes(item.state)) throw new QueueError(409, `the item is ${item.state}`);
    const job = this.job(item.job_id)!;
    await this.cancelRow(item, job);
    this.checkJobFinished(job.id);
    this.tick();
  }

  /** Cancel job (§4.5) and Discard (§4.7): running items killed, partials of every live item deleted, the job closed. */
  async cancelJob(jobId: number) {
    const job = this.job(jobId);
    if (!job) throw new QueueError(404, "no such job");
    const live = this.db.query(`SELECT * FROM download_item WHERE job_id = ? AND state IN (${LIVE_SQL})`).all(jobId) as ItemRow[];
    await Promise.all(live.map((i) => this.cancelRow(i, job)));
    const t = iso(this.now());
    this.db.prepare("UPDATE download_job SET cancelled_at = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?").run(t, t, jobId);
    if (this.resumeJobId === jobId) this.resumeJobId = null;
    this.checkJobFinished(jobId);
    this.tick();
  }

  retryFailed(jobId: number): number {
    const job = this.job(jobId);
    if (!job) throw new QueueError(404, "no such job");
    if (job.cancelled_at) throw new QueueError(409, "the job was cancelled");
    let n = 0;
    this.db.transaction(() => {
      for (const i of this.db.query("SELECT * FROM download_item WHERE job_id = ? AND state = 'failed'").all(jobId) as ItemRow[]) {
        if (this.db.query(`SELECT 1 FROM download_item WHERE video_id = ? AND state IN (${LIVE_SQL})`).get(i.video_id)) continue;
        this.patch(i.id, { state: "queued", reason: null, error_line: null, attempts: 0, not_before: null, finished_at: null, done_bytes: null });
        this.rlCount.delete(i.id);
        this.jsTried.delete(i.id);
        n++;
      }
      if (n) this.db.prepare("UPDATE download_job SET finished_at = NULL WHERE id = ?").run(jobId);
    })();
    if (n) {
      this.started = true;
      this.resumeJobId = null;
    }
    this.tick();
    return n;
  }

  /** Item retry (a card's Retry): the failed item goes again, at the front. */
  retryItem(itemId: number) {
    const item = this.item(itemId);
    if (!item) throw new QueueError(404, "no such item");
    if (item.state !== "failed") throw new QueueError(409, `the item is ${item.state}`);
    if (this.db.query(`SELECT 1 FROM download_item WHERE video_id = ? AND state IN (${LIVE_SQL})`).get(item.video_id)) throw new QueueError(409, "this Video is already queued");
    this.patch(item.id, { state: "queued", reason: null, error_line: null, attempts: 0, not_before: null, finished_at: null, done_bytes: null, queue_pos: this.minPos() });
    this.db.prepare("UPDATE download_job SET finished_at = NULL WHERE id = ?").run(item.job_id);
    this.started = true;
    this.resumeJobId = null;
    this.tick();
  }

  /** Dismiss: a finished item leaves the list; a card job with nothing left goes with it. */
  dismissItem(itemId: number) {
    const item = this.item(itemId);
    if (!item) throw new QueueError(404, "no such item");
    if (LIVE_STATES.includes(item.state)) throw new QueueError(409, "the item is still live");
    this.db.prepare("DELETE FROM download_item WHERE id = ?").run(itemId);
    try {
      unlinkSync(item.log_path);
    } catch {
      /* none */
    }
    this.dropJobIfEmpty(item.job_id);
  }

  private dropJobIfEmpty(jobId: number) {
    const job = this.job(jobId);
    if (!job) return;
    if (!this.db.query("SELECT 1 FROM download_item WHERE job_id = ? LIMIT 1").get(jobId)) {
      this.db.prepare("DELETE FROM download_job WHERE id = ?").run(jobId);
      rmSync(this.jobDir(jobId), { recursive: true, force: true });
    }
  }

  // ---- job bookkeeping (§4.2, §4.5 throughput, §4.8 retention) -------------------------------------------------------

  private checkJobFinished(jobId: number) {
    const job = this.job(jobId);
    if (!job) return;
    if (!this.db.query("SELECT 1 FROM download_item WHERE job_id = ? LIMIT 1").get(jobId)) return this.dropJobIfEmpty(jobId);
    if (this.db.query(`SELECT 1 FROM download_item WHERE job_id = ? AND state IN (${LIVE_SQL}) LIMIT 1`).get(jobId)) return;
    if (job.finished_at === null) this.finishJob(job);
    // A card job that finished without a failure is not kept (§4.8); a failed one waits for Retry or Dismiss.
    if (job.kind === "card" && !this.db.query("SELECT 1 FROM download_item WHERE job_id = ? AND state = 'failed' LIMIT 1").get(jobId)) {
      this.db.prepare("DELETE FROM download_item WHERE job_id = ?").run(jobId);
      this.db.prepare("DELETE FROM download_job WHERE id = ?").run(jobId);
      rmSync(this.jobDir(jobId), { recursive: true, force: true });
    }
  }

  private finishJob(job: JobRow) {
    const jobId = job.id;
    this.db.prepare("UPDATE download_job SET finished_at = ? WHERE id = ?").run(iso(this.now()), jobId);
    // Throughput: Σ bytes ÷ Σ downloading seconds over the job's done items.
    const rows = this.db.query("SELECT COALESCE(exact_bytes, done_bytes) AS b, started_at, finished_at FROM download_item WHERE job_id = ? AND state = 'done'").all(jobId) as { b: number | null; started_at: string | null; finished_at: string | null }[];
    let bytes = 0;
    let secs = 0;
    for (const r of rows) {
      if (!r.b || !r.started_at || !r.finished_at) continue;
      const s = (Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000;
      if (s > 0) {
        bytes += r.b;
        secs += s;
      }
    }
    if (bytes > 0 && secs > 0) setSetting(this.db, "last_throughput_bps", String(Math.round(bytes / secs)));
  }

  // ---- reading for the API (§6) -------------------------------------------------------------------------------------

  private counts(jobId: number) {
    const rows = this.db.query("SELECT state, COUNT(*) AS n, SUM(COALESCE(exact_bytes, est_bytes, 0)) AS total, SUM(CASE WHEN state IN ('done', 'done_outside') THEN COALESCE(done_bytes, exact_bytes, est_bytes, 0) ELSE COALESCE(done_bytes, 0) END) AS done, SUM(COALESCE(speed_bps, 0)) AS speed FROM download_item WHERE job_id = ? GROUP BY state").all(jobId) as { state: ItemState; n: number; total: number; done: number; speed: number }[];
    const c = { total: 0, queued: 0, waiting: 0, running: 0, done: 0, failed: 0, cancelled: 0, skipped: 0 };
    let totalBytes = 0;
    let doneBytes = 0;
    let speedBps = 0;
    for (const r of rows) {
      c.total += r.n;
      if (r.state === "queued") c.queued += r.n;
      else if (r.state === "waiting") c.waiting += r.n;
      else if (ACTIVE_STATES.includes(r.state)) c.running += r.n;
      else if (r.state === "done" || r.state === "done_outside") c.done += r.n;
      else if (r.state === "failed") c.failed += r.n;
      else if (r.state === "cancelled") c.cancelled += r.n;
      else if (r.state === "skipped") c.skipped += r.n;
      if (r.state !== "cancelled") {
        totalBytes += r.total ?? 0;
        doneBytes += r.done ?? 0;
      }
      speedBps += r.speed ?? 0;
    }
    return { counts: c, totalBytes, doneBytes, speedBps };
  }

  private jobDto(j: JobRow) {
    const { counts, totalBytes, doneBytes, speedBps } = this.counts(j.id);
    return {
      id: j.id,
      kind: j.kind,
      option: j.option,
      quality: normQuality(j.quality) ?? "1080p",
      destDir: j.dest_dir,
      destRootId: j.dest_root_id,
      createdAt: j.created_at,
      finishedAt: j.finished_at,
      cancelledAt: j.cancelled_at,
      running: j.finished_at === null,
      counts,
      totalBytes,
      doneBytes,
      speedBps,
    };
  }

  private itemDto(i: ItemRow) {
    return {
      id: i.id,
      jobId: i.job_id,
      videoId: i.video_id,
      source: i.source,
      sourceUrl: i.source_url,
      title: i.title,
      state: i.state,
      reason: i.reason,
      errorLine: i.error_line,
      estBytes: i.est_bytes,
      exactBytes: i.exact_bytes,
      doneBytes: i.done_bytes,
      speedBps: i.speed_bps,
      etaS: i.eta_s,
      attempts: i.attempts,
      notBefore: i.not_before,
      queuePos: i.queue_pos,
      filePath: i.file_path,
    };
  }

  resumePrompt() {
    if (this.started || this.resumeJobId === null) return null;
    const job = this.job(this.resumeJobId);
    if (!job) return null;
    const r = this.db.query(`SELECT COUNT(*) AS n, SUM(MAX(COALESCE(exact_bytes, est_bytes, 0) - COALESCE(done_bytes, 0), 0)) AS b FROM download_item WHERE job_id = ? AND state IN (${LIVE_SQL})`).get(job.id) as { n: number; b: number | null };
    if (!r.n) return null;
    const waiting = job.dest_root_id !== null && !this.deps.rootAvailable(job.dest_root_id);
    return { jobId: job.id, left: r.n, estBytes: r.b ?? 0, waitingForRoot: waiting ? (this.rootPathOf(job.dest_root_id!) ?? "the Root") : null };
  }

  snapshot(opts: { job?: number | null; logCursor?: number | null } = {}) {
    const now = this.now();
    for (const [k, v] of this.recent) if (now - v.at > RECENT_DONE_MS) this.recent.delete(k);
    const lastBulk = this.db.query("SELECT * FROM download_job WHERE kind = 'bulk' ORDER BY id DESC LIMIT 1").get() as JobRow | null;
    const liveJobs = this.db.query("SELECT * FROM download_job WHERE finished_at IS NULL ORDER BY id").all() as JobRow[];
    let sel: JobRow | null = null;
    if (opts.job) sel = this.job(opts.job);
    sel ??= liveJobs.find((j) => j.kind === "bulk") ?? lastBulk ?? liveJobs[0] ?? (this.db.query("SELECT * FROM download_job ORDER BY id DESC LIMIT 1").get() as JobRow | null);
    const jobs = new Map<number, JobRow>();
    for (const j of [...liveJobs, ...(lastBulk ? [lastBulk] : []), ...(sel ? [sel] : [])]) jobs.set(j.id, j);

    // The per-Video map for cards: live items, failed card items, and a fresh success until the next poll shows the Copy.
    const videos: Record<string, unknown> = {};
    const queuedOrder = (this.db.query("SELECT i.video_id FROM download_item i JOIN download_job j ON j.id = i.job_id WHERE i.state = 'queued' AND j.cancelled_at IS NULL ORDER BY i.queue_pos, i.id").all() as { video_id: string }[]).map((r) => r.video_id);
    const mapRows = this.db
      .query(
        `SELECT i.* FROM download_item i JOIN download_job j ON j.id = i.job_id
         WHERE i.state IN (${LIVE_SQL}) OR (j.kind = 'card' AND i.state = 'failed') ORDER BY i.id`,
      )
      .all() as ItemRow[];
    for (const i of mapRows) {
      videos[i.video_id] = { ...this.itemDto(i), rank: i.state === "queued" ? queuedOrder.indexOf(i.video_id) + 1 : null };
    }
    for (const [vid, r] of this.recent) if (!videos[vid]) videos[vid] = { id: r.itemId, videoId: vid, state: "done" };

    const sites = [...this.sitePause].filter(([, u]) => u > now).map(([site, u]) => ({ site, until: iso(u) }));
    return {
      started: this.started,
      paused: this.paused,
      offline: this.offline ? { since: iso(this.offline.since), nextProbeAt: iso(this.offline.nextProbeAt) } : null,
      diskFull: this.diskFull,
      sitePauses: sites,
      resumePrompt: this.resumePrompt(),
      runningCount: this.running.size,
      lastBulkJobId: lastBulk?.id ?? null,
      jobs: [...jobs.values()].sort((a, b) => a.id - b.id).map((j) => this.jobDto(j)),
      job: sel ? this.jobDto(sel) : null,
      items: sel ? (this.db.query("SELECT * FROM download_item WHERE job_id = ? ORDER BY queue_pos, id").all(sel.id) as ItemRow[]).map((i) => this.itemDto(i)) : [],
      videos,
      log: sel ? this.pullLog(sel.id, opts.logCursor ?? 0) : { lines: [], cursor: 0, reset: false },
    };
  }

  /** New yt-dlp output lines of a job since `cursor`, across its items' log files (read once, kept in a bounded buffer). */
  private pullLog(jobId: number, cursor: number) {
    let buf = this.logs.get(jobId);
    if (!buf) this.logs.set(jobId, (buf = { lines: [], base: 0, offsets: new Map() }));
    for (const it of this.db.query("SELECT id, log_path FROM download_item WHERE job_id = ? ORDER BY id").all(jobId) as { id: number; log_path: string }[]) {
      let size = 0;
      try {
        size = statSync(it.log_path).size;
      } catch {
        continue;
      }
      const off = buf.offsets.get(it.id) ?? 0;
      if (size <= off) continue;
      const data = Buffer.alloc(size - off);
      const fd = openSync(it.log_path, "r");
      try {
        readSync(fd, data, 0, data.length, off);
      } finally {
        closeSync(fd);
      }
      const end = data.lastIndexOf(10);
      if (end < 0) continue;
      buf.offsets.set(it.id, off + end + 1);
      for (const text of data.subarray(0, end).toString("utf8").split(/\r?\n/)) buf.lines.push({ itemId: it.id, text });
    }
    if (buf.lines.length > LOG_BUFFER) {
      const drop = buf.lines.length - LOG_BUFFER;
      buf.lines.splice(0, drop);
      buf.base += drop;
    }
    const end = buf.base + buf.lines.length;
    const reset = cursor < buf.base || cursor > end;
    const from = reset ? buf.base : cursor;
    return { lines: buf.lines.slice(from - buf.base), cursor: end, reset: reset && cursor !== 0 };
  }

  /** The tail of one item's own log, for the card's pop-up: `errorAt` is the index of the last ERROR line or -1. */
  itemLog(itemId: number, tail: number): { lines: string[]; errorAt: number; state: string; reason: string | null } {
    const item = this.item(itemId);
    if (!item) throw new QueueError(404, "no such item");
    let lines: string[] = [];
    try {
      const size = statSync(item.log_path).size;
      const len = Math.min(size, 256 * 1024);
      const data = Buffer.alloc(len);
      const fd = openSync(item.log_path, "r");
      try {
        readSync(fd, data, 0, len, size - len);
      } finally {
        closeSync(fd);
      }
      lines = data.toString("utf8").split(/\r?\n/).filter(Boolean);
      if (size > len) lines.shift(); // the first line is probably cut
    } catch {
      /* no log yet */
    }
    lines = lines.slice(-Math.max(1, tail));
    let errorAt = -1;
    lines.forEach((l, i) => {
      if (/^(\[err\] )?ERROR:/.test(l)) errorAt = i;
    });
    return { lines, errorAt, state: item.state, reason: item.reason };
  }

  /** The Failure report (§9) of a job: text and the download file name. */
  report(jobId: number): { text: string; fileName: string } {
    const job = this.job(jobId);
    if (!job) throw new QueueError(404, "no such job");
    const total = (this.db.query("SELECT COUNT(*) AS n FROM download_item WHERE job_id = ?").get(jobId) as { n: number }).n;
    const failed = (this.db.query("SELECT title, source_url, reason, error_line FROM download_item WHERE job_id = ? AND state = 'failed' ORDER BY queue_pos, id").all(jobId) as { title: string; source_url: string; reason: string | null; error_line: string | null }[]).map(
      (r): ReportItem => ({ title: r.title, sourceUrl: r.source_url, reason: r.reason, errorLine: r.error_line }),
    );
    const j = { createdAt: job.created_at, quality: job.quality, destDir: job.dest_dir };
    return { text: failureReport(j, total, failed), fileName: reportFileName(j) };
  }
}

export function createDownloadQueue(deps: QueueDeps) {
  return new DownloadQueue(deps);
}
