// Installing, updating and reporting the Downloader's tools (docs/downloader-spec.md §2.2, §2.3, §2.5).
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findDownloaderBin } from "../config";
import type { Db } from "../db";
import { log } from "../log";
import {
  run,
  DENO_BASE,
  YTDLP_BASE,
  appBinDir,
  checkImpersonation,
  checksumFor,
  denoAsset,
  denoName,
  detectJsRuntime,
  parseVersion,
  singleChecksum,
  unzipFirstFile,
  versionAtLeast,
  ytdlpAsset,
  ytdlpName,
  type JsRuntime,
} from "./tools";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ToolStatus {
  ytdlp: { path: string | null; version: string | null; source: "app" | "found" | "missing"; checkedAt: string | null };
  jsRuntime: { kind: JsRuntime["kind"]; path: string | null; version: string | null };
  impersonation: boolean;
  /** Not in §2.5: what an install is doing now, for the dialog's "Installing yt-dlp… (37 MB)" progress. */
  install: { running: boolean; tool: "yt-dlp" | "deno" | null; receivedBytes: number; totalBytes: number | null; error: string | null };
}

const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;
/** After a failed `-U` (offline, exit 100) the next try waits this long, so every job start does not retry it. */
const RETRY_AFTER_FAILURE_MS = 3600_000;

export function getSetting(db: Db, key: string): string | null {
  return (db.query("SELECT value FROM download_setting WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
}
export function setSetting(db: Db, key: string, value: string) {
  db.prepare("INSERT INTO download_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** True when `iso` is missing, unparseable, or at least `maxAgeMs` before `now`. */
export function isDue(iso: string | null, now: number, maxAgeMs: number): boolean {
  const t = iso ? Date.parse(iso) : NaN;
  return !Number.isFinite(t) || now - t >= maxAgeMs;
}

export interface ToolsOptions {
  dataDir: string;
  db: Db;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: Fetch;
  now?: () => number;
  /** File-exists check for the lookup; tests keep the machine's Homebrew out of it. */
  exists?: (path: string) => boolean;
}

export function createDownloaderTools(o: ToolsOptions) {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? ((u, i) => fetch(u, i));
  const now = o.now ?? Date.now;
  const binDir = appBinDir(o.dataDir);
  const appYtdlp = join(binDir, ytdlpName(platform));
  const appDeno = join(binDir, denoName(platform));

  const install = { running: false, tool: null as "yt-dlp" | "deno" | null, receivedBytes: 0, totalBytes: null as number | null, error: null as string | null };
  let installing: Promise<void> | null = null;
  const versionCache = new Map<string, string | null>();
  const impersonationCache = new Map<string, boolean>();
  let ytdlpRetryAt = 0;

  const ytdlpPath = () => findDownloaderBin(ytdlpName(platform), o.dataDir, env, o.exists);
  const runtime = () => detectJsRuntime(o.dataDir, platform, env, o.exists);
  const isApp = (p: string | null) => p !== null && p === appYtdlp;

  async function versionOf(path: string, flag = "--version"): Promise<string | null> {
    let key = path;
    try {
      const st = statSync(path);
      key = `${path}|${st.mtimeMs}|${st.size}`;
    } catch {
      return null;
    }
    if (versionCache.has(key)) return versionCache.get(key)!;
    const r = await run(path, [flag], { timeout: 30_000 });
    const m = r.code === 0 ? parseVersion(r.out) : null;
    const v = m ? (path.includes("yt-dlp") ? r.out.trim().split(/\s+/)[0] : m.join(".")) : null;
    versionCache.set(key, v);
    return v;
  }

  async function status(): Promise<ToolStatus> {
    const path = ytdlpPath();
    const source = path === null ? "missing" : isApp(path) ? "app" : "found";
    const rt = await runtime();
    let impersonation = false;
    if (path) {
      if (source === "app") impersonation = true; // bundled curl-cffi in every asset (§2.2)
      else {
        if (!impersonationCache.has(path)) impersonationCache.set(path, await checkImpersonation(path));
        impersonation = impersonationCache.get(path)!;
      }
    }
    return {
      ytdlp: { path, version: path ? await versionOf(path) : null, source, checkedAt: getSetting(o.db, "ytdlp_checked_at") },
      jsRuntime: { kind: rt.kind, path: rt.path, version: rt.version },
      impersonation,
      install: { ...install },
    };
  }

  /** GET `url` into memory, counting bytes for the progress report. */
  async function download(url: string, count: boolean): Promise<Uint8Array> {
    const res = await doFetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    const total = Number(res.headers.get("content-length"));
    if (count) {
      install.receivedBytes = 0;
      install.totalBytes = Number.isFinite(total) && total > 0 ? total : null;
    }
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (count) install.receivedBytes = size;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

  /** Writes beside the target and renames over it; a half-written file is never at the final path. */
  function place(target: string, data: Uint8Array) {
    mkdirSync(binDir, { recursive: true });
    const tmp = `${target}.tmp`;
    try {
      writeFileSync(tmp, data);
      chmodSync(tmp, 0o755);
      renameSync(tmp, target);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  async function installYtDlp() {
    const asset = ytdlpAsset(platform, arch);
    if (!asset) throw new Error(`no yt-dlp build for ${platform} ${arch}`);
    install.tool = "yt-dlp";
    const sums = new TextDecoder().decode(await download(`${YTDLP_BASE}/SHA2-256SUMS`, false));
    const want = checksumFor(sums, asset);
    if (!want) throw new Error(`yt-dlp's SHA2-256SUMS has no line for ${asset}`);
    const data = await download(`${YTDLP_BASE}/${asset}`, true);
    if (sha256(data) !== want) throw new Error("yt-dlp download failed its checksum");
    place(appYtdlp, data);
    setSetting(o.db, "ytdlp_checked_at", new Date(now()).toISOString());
    versionCache.clear();
    log("downloads: installed yt-dlp");
  }

  async function installDeno() {
    const asset = denoAsset(platform, arch);
    if (!asset) throw new Error(`no deno build for ${platform} ${arch}`);
    install.tool = "deno";
    const want = singleChecksum(new TextDecoder().decode(await download(`${DENO_BASE}/${asset}.sha256sum`, false)));
    if (!want) throw new Error(`deno's ${asset}.sha256sum is not a checksum`);
    const zip = await download(`${DENO_BASE}/${asset}`, true);
    if (sha256(zip) !== want) throw new Error("deno download failed its checksum");
    place(appDeno, unzipFirstFile(zip).data);
    setSetting(o.db, "deno_checked_at", new Date(now()).toISOString());
    log("downloads: installed deno");
  }

  /** Installs yt-dlp if none is found and deno if there is no deno 2.3+ or Node 22+ (§2.2). One install at a time. */
  function installMissing(): Promise<void> {
    if (installing) return installing;
    installing = (async () => {
      install.running = true;
      install.error = null;
      try {
        if (!ytdlpPath()) await installYtDlp();
        if ((await runtime()).kind === "none") await installDeno();
      } catch (e) {
        install.error = (e as Error).message ?? String(e);
        log(`downloads: install failed: ${install.error}`);
      } finally {
        install.running = false;
        install.tool = null;
        installing = null;
      }
    })();
    return installing;
  }

  /**
   * `yt-dlp -U`, only on the binary this app installed, at most daily (§2.3). The queue (ticket 5) calls it before a job
   * starts and passes `ytdlpRunning`, so it never runs beside a live yt-dlp. A failure keeps the old binary (restored
   * from a copy if `-U` left it broken) and never throws. Returns the `-U` output, or null when it did not run.
   */
  async function updateYtDlpIfDue(ytdlpRunning: () => boolean = () => false): Promise<string | null> {
    const path = ytdlpPath();
    const t = now();
    if (!isApp(path) || !existsSync(appYtdlp) || ytdlpRunning() || t < ytdlpRetryAt) return null;
    if (!isDue(getSetting(o.db, "ytdlp_checked_at"), t, DAY_MS)) return null;
    const backup = `${appYtdlp}.bak`;
    copyFileSync(appYtdlp, backup);
    const r = await run(appYtdlp, ["-U"], { timeout: 180_000 });
    const text = (r.out + r.err).trim();
    versionCache.clear();
    if (r.code === 0) {
      setSetting(o.db, "ytdlp_checked_at", new Date(now()).toISOString());
      rmSync(backup, { force: true });
      log(`downloads: yt-dlp -U: ${text.split("\n").pop()}`);
    } else {
      ytdlpRetryAt = now() + RETRY_AFTER_FAILURE_MS;
      if ((await run(appYtdlp, ["--version"], { timeout: 30_000 })).code !== 0) renameSync(backup, appYtdlp);
      else rmSync(backup, { force: true });
      log(`downloads: yt-dlp -U failed (${r.code}), old binary kept: ${text.slice(-300)}`);
    }
    return text;
  }

  /** deno rechecked at most weekly: the app's deno is reinstalled when the latest release is newer (§2.3). */
  async function updateDenoIfDue(): Promise<boolean> {
    if (!existsSync(appDeno) || !isDue(getSetting(o.db, "deno_checked_at"), now(), WEEK_MS)) return false;
    try {
      const res = await doFetch("https://github.com/denoland/deno/releases/latest", { redirect: "manual" });
      const latest = parseVersion((res.headers.get("location") ?? "").split("/tag/")[1] ?? "");
      if (!latest) return false;
      const have = parseVersion((await run(appDeno, ["--version"], { timeout: 30_000 })).out);
      setSetting(o.db, "deno_checked_at", new Date(now()).toISOString());
      if (have && versionAtLeast(have, latest)) return false;
      await installDeno();
      return true;
    } catch (e) {
      log(`downloads: deno update check failed: ${(e as Error).message}`);
      return false;
    }
  }

  return { status, installMissing, updateYtDlpIfDue, updateDenoIfDue, ytdlpPath };
}

export type DownloaderTools = ReturnType<typeof createDownloaderTools>;
