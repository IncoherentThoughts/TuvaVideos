// The Downloader's tools, the pure parts (docs/downloader-spec.md §2): which release asset fits this machine, the
// checksum files, the JS runtime check, the ffmpeg location. No I/O here besides `run` in the two detectors.
import { delimiter, dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { findDownloaderBin } from "../config";
import { run as spawnRun, type RunResult } from "../proc";

/** `run` that also reports a binary the OS refuses to execute (ENOEXEC, a half-written file) as a failed run, not a throw. */
export async function run(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<RunResult> {
  try {
    return await spawnRun(cmd, args, opts);
  } catch (e) {
    return { code: -1, out: "", err: String(e) };
  }
}

export const YTDLP_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
export const DENO_BASE = "https://github.com/denoland/deno/releases/latest/download";

const exe = (platform: NodeJS.Platform) => (platform === "win32" ? ".exe" : "");
export const ytdlpName = (platform: NodeJS.Platform) => `yt-dlp${exe(platform)}`;
export const denoName = (platform: NodeJS.Platform) => `deno${exe(platform)}`;
/** The app's own copies: `<dataDir>/bin/yt-dlp` and `deno` (§2.1). */
export const appBinDir = (dataDir: string) => join(dataDir, "bin");

/** The yt-dlp release asset for this machine (§2.2), or null where there is none (musl Linux is out of scope). */
export function ytdlpAsset(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "darwin") return "yt-dlp_macos";
  if (platform === "linux") return arch === "x64" ? "yt-dlp_linux" : arch === "arm64" ? "yt-dlp_linux_aarch64" : null;
  if (platform === "win32") return arch === "x64" ? "yt-dlp.exe" : arch === "arm64" ? "yt-dlp_arm64.exe" : null;
  return null;
}

/** The deno release asset for this machine (§2.2), or null. */
export function denoAsset(platform: NodeJS.Platform, arch: string): string | null {
  const a = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!a) return null;
  if (platform === "darwin") return `deno-${a}-apple-darwin.zip`;
  if (platform === "linux") return `deno-${a}-unknown-linux-gnu.zip`;
  if (platform === "win32") return `deno-${a}-pc-windows-msvc.zip`;
  return null;
}

/** The hash for `asset` in a `SHA2-256SUMS` file (`<hex>  <name>`, or `<hex> *<name>`); null when no line names it. */
export function checksumFor(sums: string, asset: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === asset) return m[1].toLowerCase();
  }
  return null;
}

/** deno's `<asset>.sha256sum`: `<hex>  <name>` or the bare hash. */
export function singleChecksum(text: string): string | null {
  const m = /^\s*([0-9a-fA-F]{64})\b/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** `[major, minor, patch]` out of `deno 2.9.8 (stable, ...)`, `v22.11.0` or `2025.10.22`; null when there is none. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function versionAtLeast(v: [number, number, number] | null, min: [number, number, number]): boolean {
  if (!v) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

export interface JsRuntime {
  kind: "deno" | "node" | "none";
  path: string | null;
  version: string | null;
  /** True for the deno this app installed: yt-dlp is then told where it is (§2.2). */
  app: boolean;
}
export const NO_RUNTIME: JsRuntime = { kind: "none", path: null, version: null, app: false };

/** The `--js-runtimes` arguments yt-dlp needs for this runtime (§2.2): none for a deno on PATH, `node` for Node. */
export function jsRuntimeArgs(rt: JsRuntime): string[] {
  if (rt.kind === "node") return ["--js-runtimes", "node"];
  if (rt.kind === "deno" && rt.app && rt.path) return ["--js-runtimes", `deno:${rt.path}`];
  return [];
}

/**
 * A usable JS runtime (§2.2): the app's own deno, then deno 2.3+ on PATH, then Node 22+ on PATH. Never Bun: this
 * server's own executable is not looked at, and a `node` found through `PATH` that is really Bun's shim fails the version check.
 */
export async function detectJsRuntime(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  exists?: (path: string) => boolean,
): Promise<JsRuntime> {
  const appDeno = join(appBinDir(dataDir), denoName(platform));
  const candidates: { kind: "deno" | "node"; path: string | null; app: boolean }[] = [
    { kind: "deno", path: findDownloaderBin(denoName(platform), dataDir, env, exists), app: false },
    { kind: "node", path: findDownloaderBin(`node${exe(platform)}`, dataDir, env, exists), app: false },
  ];
  for (const c of candidates) {
    if (!c.path) continue;
    const r = await run(c.path, ["--version"], { timeout: 15_000 });
    const v = r.code === 0 ? parseVersion(r.out) : null;
    if (/bun/i.test(r.out)) continue;
    if (c.kind === "deno" && versionAtLeast(v, [2, 3, 0])) return { kind: "deno", path: c.path, version: v!.join("."), app: c.path === appDeno };
    if (c.kind === "node" && versionAtLeast(v, [22, 0, 0])) return { kind: "node", path: c.path, version: v!.join("."), app: false };
  }
  return NO_RUNTIME;
}

/**
 * Whether `yt-dlp --list-impersonate-targets` output lists a usable target (§2.2). Targets are table rows
 * `Chrome-133  Macos-15  curl_cffi` (`-` where there is no OS), marked `(unavailable)` when curl-cffi is not installed.
 */
export function hasImpersonation(output: string): boolean {
  return output.split(/\r?\n/).some((l) => /^\s*\S+\s+\S+\s+curl_cffi\b/i.test(l) && !/unavailable/i.test(l));
}

export async function checkImpersonation(ytdlpPath: string): Promise<boolean> {
  const r = await run(ytdlpPath, ["--list-impersonate-targets"], { timeout: 60_000 });
  return r.code === 0 && hasImpersonation(r.out + "\n" + r.err);
}

/**
 * ffmpeg for yt-dlp (§2.4): `--ffmpeg-location <dir>` when ffprobe shares ffmpeg's directory, otherwise the ffmpeg
 * file itself plus ffprobe's directory in front of the child's `PATH`. `env` is what to merge into the child's environment.
 */
export function ffmpegLocation(
  ffmpeg: string,
  ffprobe: string,
  basePath: string = process.env.PATH ?? "",
): { args: string[]; env: Record<string, string> } {
  if (dirname(ffmpeg) === dirname(ffprobe)) return { args: ["--ffmpeg-location", dirname(ffmpeg)], env: {} };
  return { args: ["--ffmpeg-location", ffmpeg], env: { PATH: basePath ? `${dirname(ffprobe)}${delimiter}${basePath}` : dirname(ffprobe) } };
}

/**
 * The bytes of the first non-directory entry of a zip (deno's holds one executable). Reads the central directory, so
 * entries with a data descriptor work; zip64 and encryption are not supported.
 */
export function unzipFirstFile(zip: Uint8Array): { name: string; data: Uint8Array } {
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  let p = b.readUInt32LE(eocd + 16);
  const count = b.readUInt16LE(eocd + 10);
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip directory");
    const method = b.readUInt16LE(p + 10);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (b.readUInt32LE(local) !== 0x04034b50) throw new Error("bad zip entry");
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(start, start + size);
    if (method === 0) return { name, data: new Uint8Array(raw) };
    if (method === 8) return { name, data: new Uint8Array(inflateRawSync(raw)) };
    throw new Error(`unsupported zip method ${method}`);
  }
  throw new Error("the zip holds no file");
}
