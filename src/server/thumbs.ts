import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { copyFile, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { log } from "./log";
import type { Playback } from "./playback";
import { IO_RE, run, sleep } from "./proc";
import { rankCopies } from "./ranking";
import type { Roots } from "./roots";
import { sliceCentre, stripGeometry, STRIP_FRAME_WIDTH, type StripGeometry } from "./stripGeometry";
import { isUuid, legacyUuid } from "./localCopy/ids";

/** Writes a Video's Thumbnail facts (this machine's: `video_local`). Parameters in column order, the Video id last. */
const SET_THUMB = `INSERT INTO video_local (thumbnail_generated_at, thumbnail_copy_id, strip_frames, strip_columns, strip_rows, strip_frame_w, strip_frame_h, video_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(video_id) DO UPDATE SET thumbnail_generated_at = excluded.thumbnail_generated_at, thumbnail_copy_id = excluded.thumbnail_copy_id,
    strip_frames = excluded.strip_frames, strip_columns = excluded.strip_columns, strip_rows = excluded.strip_rows,
    strip_frame_w = excluded.strip_frame_w, strip_frame_h = excluded.strip_frame_h`;

/**
 * Thumbnail files from before migration 0015 are named by the Video's integer id (`<n>.poster.webp`, what the server
 * wrote) or, for the #21 seed cache that `adoptSeed` copied from, by the Video's `content_hash` (64 hex) or `youtube_id`.
 * Each becomes `<uuid>.{poster,strip}.webp`: integer ids under the migration's deterministic map (`legacyUuid`), the
 * other two through one query on the Videos. Idempotent (an existing target is never overwritten, integer names go first,
 * uuid names are left alone); a file whose name matches no Video stays in place. Returns the counts moved per naming style.
 */
export function renameLegacyThumbnails(db: Db, thumbsDir: string): { integer: number; contentHash: number; youtubeId: number } {
  const n = { integer: 0, contentHash: 0, youtubeId: 0 };
  let names: string[] = [];
  try {
    names = readdirSync(thumbsDir);
  } catch {
    return n;
  }
  // The server's own integer-named files first: when a seed file maps to the same Video, the one whose strip geometry
  // `video_local` records wins and the seed file stays.
  const intFirst = (f: string) => (/^\d+\./.test(f) ? 0 : 1);
  names.sort((a, b) => intFirst(a) - intFirst(b) || (a < b ? -1 : a > b ? 1 : 0));
  let maps: { byHash: Map<string, string>; byYoutube: Map<string, string> } | undefined;
  const lookups = () => {
    if (maps) return maps;
    maps = { byHash: new Map(), byYoutube: new Map() };
    const rows = db.query("SELECT id, youtube_id, content_hash FROM video_full").all() as { id: string; youtube_id: string | null; content_hash: string | null }[];
    for (const r of rows) {
      if (r.content_hash) maps.byHash.set(r.content_hash.toLowerCase(), r.id);
      if (r.youtube_id) maps.byYoutube.set(r.youtube_id, r.id);
    }
    return maps;
  };
  for (const f of names) {
    const m = /^(.+)\.(poster|strip)\.webp$/.exec(f);
    if (!m) continue;
    const key = m[1]!;
    if (isUuid(m[1])) continue; // already renamed (tested on m[1]: the type guard would narrow `key` to never below)
    let uuid: string | undefined;
    let style: keyof typeof n;
    if (/^\d+$/.test(key) && Number.isSafeInteger(Number(key)) && Number(key) <= 0xffffffffffff) {
      uuid = legacyUuid("video", Number(key));
      style = "integer";
    } else if (/^[0-9a-f]{64}$/i.test(key)) {
      uuid = lookups().byHash.get(key.toLowerCase());
      style = "contentHash";
    } else {
      uuid = lookups().byYoutube.get(key);
      style = "youtubeId";
    }
    if (!uuid) continue;
    const to = join(thumbsDir, `${uuid}.${m[2]}.webp`);
    if (existsSync(to)) continue;
    try {
      renameSync(join(thumbsDir, f), to);
      n[style]++;
    } catch (e) {
      log(`thumbs: could not rename ${f}: ${e}`);
    }
  }
  return n;
}

// Settings from spec 3.5 / docs/research/thumbnail-pilot.md
const POSTER_W = 480;
const POSTER_Q = 75;
const POSTER_AT = 0.1;
const STRIP_Q = 40;
const SINGLE_PASS_MAX_S = 30 * 60;
const POOL_SIZE = 4;
const RETRIES = 3;

interface SourceCopy {
  id: number;
  root_id: number;
  root_kind: "local" | "external";
  root_path: string;
  rel_path: string;
  size: number;
  duration_s: number | null;
  video_codec: string | null;
  width: number | null;
  height: number | null;
  playback: Playback;
}

type Outcome = { ok: true } | { ok: false; error: string; io: boolean };

async function fileSize(f: string): Promise<number> {
  try {
    return (await stat(f)).size;
  } catch {
    return 0;
  }
}

/** Width/height from the RIFF header of a WebP (VP8, VP8L, VP8X). */
export async function webpSize(file: string): Promise<{ w: number; h: number } | null> {
  const fh = await open(file, "r");
  try {
    const b = Buffer.alloc(40);
    await fh.read(b, 0, 40, 0);
    const fmt = b.toString("ascii", 12, 16);
    if (fmt === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (fmt === "VP8L") {
      const v = b.readUInt32LE(21);
      return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
    }
    if (fmt === "VP8X") return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
    return null;
  } finally {
    await fh.close();
  }
}

export class Thumbnails {
  private children = new Set<ChildProcess>();
  private stopping = false;
  private draining: Promise<void> | null = null;
  private again = false;
  private failedThisRun = new Set<string>();
  stats = { generated: 0, adopted: 0, failed: 0, pending: 0, running: false };

  constructor(
    private db: Db,
    private cfg: Pick<Config, "thumbsDir" | "ffmpeg" | "cwebp">,
    private roots: Roots,
    private shouldPause: () => boolean,
  ) {
    mkdirSync(cfg.thumbsDir, { recursive: true });
    const r = renameLegacyThumbnails(db, cfg.thumbsDir);
    if (r.integer + r.contentHash + r.youtubeId)
      log(`thumbs: renamed Thumbnail files to uuids (migration 0015): ${r.integer} by integer id, ${r.contentHash} by content_hash, ${r.youtubeId} by youtube_id`);
  }

  /** Adopt the #21 cache: copy `<youtubeId|sha256>.{poster,strip}.webp` to `<videoId>.*` and record geometry. */
  adoptSeed(): number {
    const manifestPath = join(this.cfg.thumbsDir, "manifest.json");
    if (!existsSync(manifestPath)) return 0;
    let entries: any[];
    try {
      entries = JSON.parse(readFileSync(manifestPath, "utf8")).videos ?? [];
    } catch (e) {
      log(`thumbs: seed manifest unreadable: ${e}`);
      return 0;
    }
    const byId = new Map<string, any>(entries.map((e) => [e.id, e]));
    const todo = this.db
      .query("SELECT id, youtube_id, content_hash FROM video_full WHERE thumbnail_generated_at IS NULL")
      .all() as { id: string; youtube_id: string | null; content_hash: string | null }[];
    const upd = this.db.prepare(SET_THUMB);
    const findCopy = this.db.prepare(
      "SELECT c.id FROM copy c JOIN root r ON r.id = c.root_id WHERE c.video_id = ? AND r.kind = ? AND c.rel_path = ?",
    );
    let n = 0;
    for (const v of todo) {
      const e = byId.get((v.youtube_id ?? v.content_hash) as string);
      if (!e) continue;
      const seedPoster = join(this.cfg.thumbsDir, `${e.id}.poster.webp`);
      const seedStrip = join(this.cfg.thumbsDir, `${e.id}.strip.webp`);
      if (!existsSync(seedPoster) || (e.strip && !existsSync(seedStrip))) continue;
      try {
        copyFileSync(seedPoster, this.posterPath(v.id));
        if (e.strip) copyFileSync(seedStrip, this.stripPath(v.id));
      } catch (err) {
        log(`thumbs: seed copy failed for video ${v.id}: ${err}`);
        continue;
      }
      const copy = e.source ? (findCopy.get(v.id, e.source.root, e.source.relPath) as { id: number } | null) : null;
      const s = e.strip;
      upd.run(new Date().toISOString(), copy?.id ?? null, s ? s.frames : 0, s ? s.columns : 0, s ? s.rows : 0, s ? Math.round(s.frameWidth) : null, s ? Math.round(s.frameHeight) : null, v.id);
      n++;
    }
    this.stats.adopted += n;
    if (n) log(`thumbs: adopted ${n} Thumbnails from the seed cache`);
    return n;
  }

  /** The Video has a Shared poster: its `poster_path` is set (§6.5), so the pool must not generate one. */
  hasSharedPoster(videoId: string): boolean {
    return !!(this.db.query("SELECT poster_path FROM videos WHERE id = ?").get(videoId) as { poster_path: string | null } | null)?.poster_path;
  }

  posterPath(videoId: string) {
    return join(this.cfg.thumbsDir, `${videoId}.poster.webp`);
  }
  stripPath(videoId: string) {
    return join(this.cfg.thumbsDir, `${videoId}.strip.webp`);
  }

  /** Generate whatever is missing. Safe to call at any time; overlapping calls coalesce. */
  kick(fresh = false) {
    if (this.stopping) return;
    if (fresh) this.failedThisRun.clear();
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = this.drain().finally(() => {
      this.draining = null;
      this.stats.running = false;
      if (this.again && !this.stopping) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** Videos still needing a Thumbnail that have at least one readable Copy, newest first. */
  private pendingJobs(): { videoId: string; src: SourceCopy }[] {
    const vids = this.db
      .query(
        `SELECT v.id, MAX(c.mtime) AS newest FROM video_full v JOIN copy c ON c.video_id = v.id
         WHERE v.thumbnail_generated_at IS NULL GROUP BY v.id ORDER BY newest DESC, v.id DESC`,
      )
      .all() as { id: string }[];
    const copiesOf = this.db.prepare(
      `SELECT c.id, c.root_id, r.kind AS root_kind, r.path AS root_path, c.rel_path, c.size, c.duration_s, c.video_codec,
              c.width, c.height, c.playback
       FROM copy c JOIN root r ON r.id = c.root_id WHERE c.video_id = ? AND c.missing_since IS NULL`,
    );
    const jobs: { videoId: string; src: SourceCopy }[] = [];
    for (const v of vids) {
      if (this.failedThisRun.has(v.id)) continue;
      const usable = (copiesOf.all(v.id) as SourceCopy[]).filter((c) => this.roots.isAvailable(c.root_id));
      if (!usable.length) continue; // only unavailable Copies: wait for the next scan
      jobs.push({ videoId: v.id, src: rankCopies(usable.map((c) => ({ ...c, rootKind: c.root_kind })))[0]! });
    }
    return jobs;
  }

  private async drain() {
    const jobs = this.pendingJobs();
    this.stats.pending = jobs.length;
    if (!jobs.length) return;
    this.stats.running = true;
    log(`thumbs: ${jobs.length} Videos to do, pool of ${POOL_SIZE}`);
    const t0 = Date.now();
    let i = 0;
    const worker = async () => {
      while (!this.stopping && i < jobs.length) {
        const job = jobs[i++]!;
        await this.gate();
        if (this.stopping) return;
        if (!this.roots.isAvailable(job.src.root_id)) continue; // drive dropped meanwhile: waits for the remount scan
        try {
          await this.generate(job.videoId, job.src);
        } catch (e) {
          this.failedThisRun.add(job.videoId);
          this.stats.failed++;
          log(`thumbs: video ${job.videoId} crashed: ${e}`);
        }
        this.stats.pending = Math.max(0, jobs.length - i);
      }
    };
    await Promise.all(Array.from({ length: POOL_SIZE }, worker));
    log(`thumbs: pass finished in ${((Date.now() - t0) / 1000).toFixed(0)}s (generated ${this.stats.generated}, failed ${this.stats.failed})`);
  }

  /** Paused while a play-requested Fallback job runs. */
  private async gate() {
    while (this.shouldPause() && !this.stopping) await sleep(300);
  }

  async shutdown() {
    this.stopping = true;
    for (const c of this.children) c.kill("SIGKILL");
    if (this.draining) await this.draining.catch(() => {});
  }

  // ---------- ffmpeg plumbing ----------

  /** ffmpeg ... PNG on stdout | cwebp -> outFile. */
  private pipeToWebp(ffArgs: string[], q: number, outFile: string, timeoutMs: number): Promise<Outcome> {
    return new Promise((resolve) => {
      const ff = spawn(this.cfg.ffmpeg, ffArgs, { stdio: ["ignore", "pipe", "pipe"] });
      const cw = spawn(this.cfg.cwebp, ["-quiet", "-q", String(q), "-m", "4", "-o", outFile, "--", "-"], { stdio: ["pipe", "ignore", "pipe"] });
      this.children.add(ff).add(cw);
      let err = "";
      const add = (d: Buffer) => {
        if (err.length < 20000) err += d;
      };
      ff.stderr.on("data", add);
      cw.stderr.on("data", add);
      ff.stdout.pipe(cw.stdin);
      cw.stdin.on("error", () => {});
      let ffCode: number | null = null;
      let cwCode: number | null = null;
      const t = setTimeout(() => (ff.kill("SIGKILL"), cw.kill("SIGKILL")), timeoutMs);
      const done = () => {
        if (ffCode === null || cwCode === null) return;
        clearTimeout(t);
        this.children.delete(ff);
        this.children.delete(cw);
        resolve(ffCode === 0 && cwCode === 0 ? { ok: true } : { ok: false, error: `ffmpeg=${ffCode} cwebp=${cwCode} ${err}`.trim(), io: IO_RE.test(err) });
      };
      ff.on("error", (e) => (err += String(e)));
      ff.on("close", (c, s) => ((ffCode = s ? -1 : c), done()));
      cw.on("close", (c, s) => ((cwCode = s ? -1 : c), done()));
    });
  }

  private async frame(src: string, ss: number, scale: number, out: string): Promise<Outcome> {
    await this.gate();
    const r = await run(this.cfg.ffmpeg, ["-v", "error", "-y", "-ss", ss.toFixed(3), "-i", src, "-an", "-sn", "-dn", "-frames:v", "1", "-vf", `scale=${scale}:-2,setsar=1`, "-c:v", "png", "-compression_level", "1", out], { timeout: 120_000 });
    if (r.code === 0 && (await fileSize(out)) > 0) return { ok: true };
    return { ok: false, error: r.err.trim().slice(-300) || "no frame produced", io: IO_RE.test(r.err) };
  }

  /** Retry I/O trouble (waiting for the drive), give up at once on anything else. */
  private async retry(label: string, rootId: number, fn: () => Promise<Outcome>): Promise<Outcome> {
    let last: Outcome = { ok: false, error: "not run", io: false };
    for (let a = 1; a <= RETRIES; a++) {
      last = await fn();
      if (last.ok || !last.io) return last;
      // Re-check the drive now (1-byte read); if it is gone, stop hammering it. A remount scan retries.
      if (!(await this.roots.check(rootId))) return last;
      if (a < RETRIES) {
        log(`thumbs: I/O error, retry ${a}/${RETRIES - 1}: ${label}`);
        await sleep(5000 * a);
      }
    }
    return last;
  }

  private async makePoster(src: string, dur: number | null, out: string, rootId: number): Promise<Outcome> {
    const t = dur ? dur * POSTER_AT : 5;
    return this.retry("poster " + src, rootId, async () => {
      let last: Outcome = { ok: false, error: "no attempt", io: false };
      for (const ss of [t, 0]) {
        await rm(out, { force: true });
        await this.gate();
        last = await this.pipeToWebp(["-v", "error", "-y", "-ss", ss.toFixed(3), "-i", src, "-an", "-sn", "-dn", "-frames:v", "1", "-vf", `scale=${POSTER_W}:-2,setsar=1`, "-f", "image2pipe", "-c:v", "png", "-"], POSTER_Q, out, 120_000);
        if (last.ok && (await fileSize(out)) > 0) return { ok: true };
        if (!last.ok && last.io) return last;
      }
      return last.ok ? { ok: false, error: "empty poster", io: false } : last;
    });
  }

  private async stripSingle(src: string, dur: number, g: StripGeometry, out: string, rootId: number): Promise<Outcome> {
    return this.retry("strip " + src, rootId, async () => {
      await rm(out, { force: true });
      await this.gate();
      const r = await this.pipeToWebp(
        ["-v", "error", "-y", "-skip_frame", "nokey", "-i", src, "-an", "-sn", "-dn", "-vf", `fps=${g.frames}/${dur},scale=${STRIP_FRAME_WIDTH}:-2,setsar=1,tile=${g.columns}x${g.rows}`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-compression_level", "1", "-"],
        STRIP_Q, out, 900_000,
      );
      return r.ok && (await fileSize(out)) === 0 ? { ok: false, error: "empty strip", io: false } : r;
    });
  }

  /** One ffmpeg process at a time per Video, so the pool of 4 means at most 4 ffmpeg processes. */
  private async stripSeek(src: string, dur: number, g: StripGeometry, out: string, work: string, rootId: number): Promise<Outcome> {
    const n = g.frames;
    const file = (i: number) => join(work, `f${String(i).padStart(4, "0")}.png`);
    const good: boolean[] = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      if (this.stopping) return { ok: false, error: "stopping", io: false };
      const t = sliceCentre(dur, n, i);
      const r = await this.retry(`frame ${i} ${src}`, rootId, async () => {
        let last: Outcome = { ok: false, error: "no frame", io: false };
        for (const ss of [t, t * 0.9, Math.max(0, t - 5)]) {
          await rm(file(i), { force: true });
          last = await this.frame(src, ss, STRIP_FRAME_WIDTH, file(i));
          if (last.ok || last.io) return last;
        }
        return last;
      });
      if (r.ok) good[i] = true;
      else if (r.io) return { ok: false, error: `I/O error during seek frames: ${r.error}`.slice(0, 400), io: true };
    }
    const nGood = good.filter(Boolean).length;
    if (nGood < n * 0.5) return { ok: false, error: `only ${nGood}/${n} frames could be extracted`, io: false };
    let prev = good.indexOf(true);
    for (let i = 0; i < n; i++) {
      if (good[i]) {
        prev = i;
        continue;
      }
      await copyFile(file(prev), file(i)); // fill a hole with the nearest earlier good frame
    }
    await this.gate();
    const r = await this.pipeToWebp(
      ["-v", "error", "-y", "-framerate", "1", "-i", join(work, "f%04d.png"), "-vf", `tile=${g.columns}x${g.rows}`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-compression_level", "1", "-"],
      STRIP_Q, out, 300_000,
    );
    return r.ok && (await fileSize(out)) === 0 ? { ok: false, error: "empty strip", io: false } : r;
  }

  private async generate(videoId: string, src: SourceCopy) {
    const abs = join(src.root_path, src.rel_path);
    const tmpRoot = join(this.cfg.thumbsDir, ".tmp");
    mkdirSync(tmpRoot, { recursive: true });
    const work = await mkdtemp(join(tmpRoot, `v${videoId}-`));
    const posterTmp = join(work, "poster.webp");
    const stripTmp = join(work, "strip.webp");
    const fail = (stage: string, r: Outcome) => {
      if (!(!r.ok && r.io)) this.failedThisRun.add(videoId); // I/O trouble is retryable, never final
      this.stats.failed++;
      log(`thumbs: video ${videoId} ${stage} failed${!r.ok && r.io ? " (I/O, retryable)" : ""}: ${!r.ok ? r.error.slice(-200) : ""}`);
    };
    try {
      const t0 = Date.now();
      const dur = src.duration_s;
      // §6.5: a Video with a Shared poster (`poster_path`) gets its poster from Sync's download; the pool makes only
      // its strip. A local poster is generated only when there is no `poster_path`.
      const shared = this.hasSharedPoster(videoId);
      if (!shared) {
        const p = await this.makePoster(abs, dur, posterTmp, src.root_id);
        if (!p.ok) return fail("poster", p);
      }
      const g = stripGeometry(dur);
      let frameH: number | null = null;
      if (g && dur) {
        const single = src.video_codec === "h264" && dur < SINGLE_PASS_MAX_S;
        let s: Outcome = single ? await this.stripSingle(abs, dur, g, stripTmp, src.root_id) : { ok: false, error: "seek", io: false };
        // -skip_frame nokey yields nothing for a clip with too few keyframes: fall back to seek-per-frame
        if (!s.ok && !s.io) s = await this.stripSeek(abs, dur, g, stripTmp, work, src.root_id);
        if (!s.ok) return fail("strip", s);
        const dims = await webpSize(stripTmp);
        frameH = dims ? Math.round(dims.h / g.rows) : null;
      }
      if (!shared) await rename(posterTmp, this.posterPath(videoId));
      if (g) await rename(stripTmp, this.stripPath(videoId));
      else await rm(this.stripPath(videoId), { force: true });
      this.db
        .prepare(SET_THUMB)
        .run(new Date().toISOString(), src.id, g?.frames ?? 0, g?.columns ?? 0, g?.rows ?? 0, g ? STRIP_FRAME_WIDTH : null, frameH, videoId);
      this.stats.generated++;
      log(`thumbs: video ${videoId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${g ? g.frames + " frames" : "poster only"})`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
