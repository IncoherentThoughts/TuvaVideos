import { readdir, stat, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { containerFor, parseFilename } from "./filename";
import { loadSeedHashes, seedKey, sha256File } from "./hash";
import { log } from "./log";
import { applyPerformanceDefaults } from "./defaults";
import { suggestArtists } from "./artistSuggest";
import { suggestSongsFromTitles } from "./songSuggest";
import { fillLatinTitles } from "./latin";
import { decidePlayback } from "./playback";
import { probeFile } from "./probe";
import { isDeleted } from "./deleteVideo";
import { isIoError, sleep } from "./proc";
import type { RootRow, Roots } from "./roots";
import { rebuildSearchIndex } from "./search";
import { judgeStaleCopies } from "./tvJudge";
import { judgeBrowserCopies } from "./browserJudge";
import { newUuid } from "./localCopy/ids";
import { machineMode, readSessionRecord } from "./localCopy/meta";

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
  video_id: string;
  rel_path: string;
  size: number;
  mtime: string;
  missing_since: string | null;
  fallback_file: string | null;
  playback: string;
  content_hash: string | null;
}

/** The matcher passes for new Videos run in chunks of this many, yielding to the event loop between them (audit DB-4). */
const MATCH_CHUNK = 25;

export interface RootScanSummary {
  rootId: number;
  filesSeen: number;
  newCopies: number;
  updatedCopies: number;
  revived: number;
  markedMissing: number;
  skippedNotVideo: number;
  /** Symlinked files and folders, which the scan does not follow (audit DB-8). */
  skippedSymlinks: number;
  /** Files of a deleted Video (a `deleted_video` tombstone), left out on purpose (audit DB-11). */
  skippedDeleted: number;
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
  /** The last probe failure `processEntry` logged, for `scanFile` to report. */
  private lastProbeError: string | null = null;

  constructor(
    private db: Db,
    private cfg: Pick<Config, "ffprobe" | "thumbsDir" | "remuxDir" | "ytCacheDir">,
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

  /**
   * One finished file into the library (downloader-spec §4.6): `processEntry` for `relPath`, then the finishing steps
   * scoped to that Video. Takes the scan lock like a Rescan: if one is running (or another file is going in) this waits.
   */
  async scanFile(rootId: number, relPath: string): Promise<{ ok: true; videoId: string } | { ok: false; error: string }> {
    const root = this.roots.get(rootId);
    if (!root) return { ok: false, error: "the Root is gone" };
    while (this.running) await this.whenIdle();
    this.running = true;
    try {
      const abs = join(root.path, relPath);
      const st = await stat(abs);
      const entry: Entry = { rel: relPath, name: relPath.split("/").pop()!, size: st.size, mtimeMs: st.mtimeMs };
      const row = this.db
        .query("SELECT id, video_id, rel_path, size, mtime, missing_since, fallback_file, playback, content_hash FROM copy WHERE root_id = ? AND rel_path = ?")
        .get(rootId, relPath) as CopyRow | null;
      const summary: RootScanSummary = {
        rootId, filesSeen: 1, newCopies: 0, updatedCopies: 0, revived: 0, markedMissing: 0, skippedNotVideo: 0, skippedSymlinks: 0,
        skippedDeleted: 0, probeFailed: 0, ioErrors: 0, dirErrors: [], durationMs: 0,
      };
      const newVideos: string[] = [];
      this.lastProbeError = null;
      await this.processEntry(root, entry, row ?? undefined, summary, { active: 0 }, newVideos);
      const after = this.db.query("SELECT video_id FROM copy WHERE root_id = ? AND rel_path = ?").get(rootId, relPath) as { video_id: string } | null;
      if (!after) {
        const why = this.lastProbeError ?? (summary.skippedDeleted ? "the Video was deleted" : "the file is not a Video");
        return { ok: false, error: why };
      }
      judgeStaleCopies(this.db);
      judgeBrowserCopies(this.db);
      await this.matchNewVideos(newVideos);
      rebuildSearchIndex(this.db);
      this.afterScan(rootId);
      return { ok: true, videoId: after.video_id };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    } finally {
      this.running = false;
      for (const r of this.idle.splice(0)) r();
      if (this.queue.size) void this.loop();
    }
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
      if (e.isSymbolicLink()) {
        summary.skippedSymlinks++; // not followed (no loops, nothing outside the Root), but counted
        continue;
      }
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
        // The spelling on disk: ext4, btrfs and NTFS compare names byte for byte, so only it opens the file (audit DB-2).
        // Matching against recorded Copies is by the NFC form (exFAT listed decomposed names, APFS lists what was written).
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
      skippedNotVideo: 0, skippedSymlinks: 0, skippedDeleted: 0, probeFailed: 0, ioErrors: 0, dirErrors: [], durationMs: 0,
    };
    Object.assign(this.prog, { rootId: root.id, rootPath: root.path, phase: "walking", filesSeen: 0, filesToProbe: 0, filesProbed: 0 });

    const entries: Entry[] = [];
    const failedDirs: string[] = [];
    await this.walk(root.path, root.path, entries, failedDirs, summary);
    summary.filesSeen = entries.length;

    // A listed file matches the Copy recorded under its exact spelling, else one recorded under another spelling of the
    // same NFC form (a Copy recorded from a decomposed listing), which is then respelled to the name on disk.
    const existing = this.db
      .query("SELECT id, video_id, rel_path, size, mtime, missing_since, fallback_file, playback, content_hash FROM copy WHERE root_id = ?")
      .all(root.id) as CopyRow[];
    const byPath = new Map(existing.map((c) => [c.rel_path, c]));
    const byKey = new Map<string, CopyRow[]>();
    for (const c of existing) {
      const k = c.rel_path.normalize("NFC");
      (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(c);
    }
    const matched = new Set<number>();
    const seenKeys = new Set<string>();
    const rowOf = new Map<Entry, CopyRow>();
    for (const entry of entries) {
      seenKeys.add(entry.rel.normalize("NFC"));
      const r = byPath.get(entry.rel);
      if (r) (matched.add(r.id), rowOf.set(entry, r));
    }
    const todo: { entry: Entry; row: CopyRow | undefined }[] = [];
    const revive = this.db.prepare("UPDATE copy SET missing_since = NULL WHERE id = ?");
    const respell = this.db.prepare("UPDATE copy SET rel_path = ? WHERE id = ?");
    for (const entry of entries) {
      let row = rowOf.get(entry);
      if (!row) {
        row = byKey.get(entry.rel.normalize("NFC"))?.find((c) => !matched.has(c.id));
        if (row) {
          matched.add(row.id);
          respell.run(entry.rel, row.id);
          row.rel_path = entry.rel;
        }
      }
      const mtime = new Date(entry.mtimeMs).toISOString();
      if (row && row.size === entry.size && row.mtime === mtime) {
        if (row.missing_since) {
          revive.run(row.id);
          summary.revived++;
        }
        continue;
      }
      // A deleted Video's file left on disk (deleteVideo.ts): skipped before the probe when the name carries its id.
      if (!row && isDeleted(this.db, { youtubeId: parseFilename(entry.name).youtubeId, contentHash: null })) {
        summary.skippedDeleted++;
        continue;
      }
      todo.push({ entry, row });
    }

    this.prog.phase = "probing";
    this.prog.filesToProbe = todo.length;
    // Probing is concurrent; id-less hashing is throttled separately inside processEntry.
    const hashSlots = { active: 0 };
    const newVideos: string[] = [];
    await pool(todo, PROBE_CONCURRENCY, async (t) => {
      try {
        await this.processEntry(root, t.entry, t.row, summary, hashSlots, newVideos);
      } catch (e) {
        if (isIoError(e)) summary.ioErrors++;
        else summary.probeFailed++;
        log(`scan: ${t.entry.rel}: ${e}`);
      } finally {
        this.prog.filesProbed++;
      }
    });

    this.prog.phase = "finishing";
    judgeStaleCopies(this.db); // new and changed Copies, and any judged under an older TV profile version (tv-spec 3.1)
    judgeBrowserCopies(this.db); // stamps the browser profile version on new and changed Copies (audit PLAY-8)
    await this.markMissing(root, existing, matched, seenKeys, failedDirs, summary);
    await this.matchNewVideos(newVideos);
    rebuildSearchIndex(this.db);
    summary.durationMs = Date.now() - t0;
    return summary;
  }

  private async processEntry(root: RootRow, entry: Entry, row: CopyRow | undefined, summary: RootScanSummary, hashSlots: { active: number }, newVideos: string[]) {
    const abs = join(root.path, entry.rel);
    const parsed = parseFilename(entry.name);
    const probe = await probeFile(this.cfg, abs);
    if (!probe.ok) {
      if (probe.io) summary.ioErrors++; // retryable: the row (if any) stays as it was, nothing is inserted
      else summary.probeFailed++;
      this.lastProbeError = probe.error;
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

    if (!row && contentHash && isDeleted(this.db, { youtubeId: null, contentHash })) {
      summary.skippedDeleted++;
      return;
    }

    const facts = [
      f.duration, containerFor(parsed.ext), f.videoCodec, f.audioCodec, f.width, f.height, f.rFrameRate, playback,
    ] as const;

    if (row) {
      if (row.fallback_file) await unlink(join(this.cfg.remuxDir, row.fallback_file)).catch(() => {});
      this.db
        .prepare(
          `UPDATE copy SET size = ?, mtime = ?, duration_s = ?, container = ?, video_codec = ?, audio_codec = ?, width = ?, height = ?,
             r_frame_rate = ?, playback = ?, tv_playback = NULL, tv_profile_version = NULL, fallback_file = NULL, keyframes = NULL, content_hash = COALESCE(?, content_hash), missing_since = NULL WHERE id = ?`,
        )
        .run(entry.size, mtime, ...facts, contentHash, row.id);
      if (contentHash && row.content_hash && contentHash !== row.content_hash) this.reidentify(row, contentHash);
      summary.updatedCopies++;
      return;
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      // No YouTube id: the same bytes, else (ADR 0005, ADR 0008) another download of the same Instagram post or Rutube video.
      type Found = { id: string; deleted_at: string | null; delete_reason: string | null };
      const one = (sql: string, v: string) => this.db.query(`SELECT id, deleted_at, delete_reason FROM videos WHERE ${sql}`).get(v) as Found | null;
      const found = parsed.youtubeId
        ? one("youtube_id = ?", parsed.youtubeId)
        : ((contentHash ? one("content_hash = ?", contentHash) : null) ??
          (parsed.instagramId ? one("instagram_id = ? ORDER BY created_at, id LIMIT 1", parsed.instagramId) : null) ??
          (parsed.rutubeId ? one("rutube_id = ? ORDER BY created_at, id LIMIT 1", parsed.rutubeId) : null));
      // A soft-deleted Shared Video (sharing-spec §4.5): the file joins it and stays unlisted; a Video Editor may restore it.
      if (found?.deleted_at) log(`scan: ${entry.rel} belongs to a deleted Video (${found.delete_reason ?? "no reason"}); kept unlisted`);
      // Defaults (spec 2.3): a new Video starts as Type `song`, then gets its Type/Song from the Performances of its id, if any.
      const videoId = found?.id ?? newUuid();
      if (!found) {
        this.db
          .prepare("INSERT INTO videos (id, youtube_id, content_hash, instagram_id, rutube_id, title, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'song', ?, ?)")
          .run(videoId, parsed.youtubeId, parsed.youtubeId ? null : contentHash, parsed.instagramId, parsed.rutubeId, parsed.title, now, now);
        // On a Video Editor's machine a Video the Local copy does not know waits to be shared (§6.6); elsewhere it is Unshared.
        const editor = machineMode(readSessionRecord(this.db)) === "editor";
        this.db.prepare("INSERT INTO video_local (video_id, pending_share) VALUES (?, ?)").run(videoId, editor ? 1 : 0);
      } else {
        // A provenance id the held Video lacks is picked up from the file (ADR 0005, ADR 0008); on a Shared Video through the archive (#116).
        if (parsed.instagramId) this.db.prepare("UPDATE videos SET instagram_id = ? WHERE id = ? AND instagram_id IS NULL AND id NOT IN (SELECT video_id FROM video_local WHERE shared = 1)").run(parsed.instagramId, videoId);
        if (parsed.rutubeId) this.db.prepare("UPDATE videos SET rutube_id = ? WHERE id = ? AND rutube_id IS NULL AND id NOT IN (SELECT video_id FROM video_local WHERE shared = 1)").run(parsed.rutubeId, videoId);
      }
      if (!found) newVideos.push(videoId); // its Song, Artist and Latin title passes run after the probing (matchNewVideos)
      this.db
        .prepare(
          `INSERT INTO copy (video_id, root_id, rel_path, size, mtime, duration_s, container, video_codec, audio_codec, width, height,
             r_frame_rate, playback, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(videoId, root.id, entry.rel, entry.size, mtime, ...facts, contentHash);
    })();
    summary.newCopies++;
  }

  /**
   * An id-less Copy's bytes changed (a file finished copying after a scan took it in half-written, or was replaced in
   * place): when it is the only Copy of its Unshared Video, that Video's identity follows the new bytes, unless another
   * Video already holds them (audit DB-3). Otherwise an identical file found later became a second Video.
   */
  private reidentify(row: CopyRow, newHash: string) {
    const r = this.db
      .prepare(
        `UPDATE videos SET content_hash = ? WHERE id = ? AND youtube_id IS NULL AND content_hash = ?
           AND NOT EXISTS (SELECT 1 FROM copy WHERE video_id = videos.id AND id != ?)
           AND NOT EXISTS (SELECT 1 FROM videos v2 WHERE v2.content_hash = ?)
           AND id NOT IN (SELECT video_id FROM video_local WHERE shared = 1)`,
      )
      .run(newHash, row.video_id, row.content_hash, row.id, newHash);
    if (r.changes) log(`scan: ${row.rel_path} changed; its Video now goes by the new content hash`);
    else if (this.db.query("SELECT 1 FROM videos WHERE content_hash = ? AND id != ?").get(newHash, row.video_id))
      log(`scan: ${row.rel_path} changed and now has the same bytes as another Video; left as it is`);
  }

  /**
   * Songs, Artists, Performance defaults and Latin titles for the Videos this scan added (spec 2.3), in chunks that
   * yield to the event loop so playback and the UI keep answering (audit DB-4). Archive changes re-run the full passes
   * themselves (localCopy/followUps.ts), so the scan only needs its own new Videos.
   */
  private async matchNewVideos(ids: string[]) {
    for (let i = 0; i < ids.length; i += MATCH_CHUNK) {
      const videoIds = ids.slice(i, i + MATCH_CHUNK);
      applyPerformanceDefaults(this.db, { videoIds });
      suggestSongsFromTitles(this.db, { videoIds });
      suggestArtists(this.db, { videoIds, cacheDir: this.cfg.ytCacheDir });
      fillLatinTitles(this.db, { videoIds });
      await sleep(0);
    }
  }

  /** Spec 2.3 / CONTEXT.md "Missing": only for a Root that is still mounted, only when the file is provably gone. */
  private async markMissing(root: RootRow, existing: CopyRow[], matched: Set<number>, seenKeys: Set<string>, failedDirs: string[], summary: RootScanSummary) {
    const candidates = existing.filter((c) => !matched.has(c.id) && !c.missing_since);
    if (!candidates.length) return;
    if (!(await this.roots.check(root.id))) {
      log(`scan: ${root.path} went away during the scan; not marking anything missing`);
      return;
    }
    const mark = this.db.prepare("UPDATE copy SET missing_since = ? WHERE id = ?");
    const now = new Date().toISOString();
    for (const c of candidates) {
      if (failedDirs.some((d) => d === "" || c.rel_path === d || c.rel_path.startsWith(d + "/"))) continue;
      // A second row for another spelling of a listed file (audit DB-2): the file is the other row's; this one is a
      // phantom that would otherwise look available for good (on APFS its path even opens).
      if (seenKeys.has(c.rel_path.normalize("NFC"))) {
        mark.run(now, c.id);
        summary.markedMissing++;
        continue;
      }
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
