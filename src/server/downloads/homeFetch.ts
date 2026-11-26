// Download from the Home Server (docs/home-server-spec.md §8): fetch one Copy through the Home Server proxy
// (`/home/copy/:id?download=1`, homeProxy.ts) into a temp file, resuming with Range after a drop. No queue and no
// database here: the pure checks are tested directly, the fetch with a stub `fetch`.

import { closeSync, mkdirSync, openSync, statSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import { dirname, posix } from "node:path";
import { homeUpstream, proxyHome } from "../homeProxy";

/** What a Home Server item needs, taken from the home index when it is queued (stored as `download_item.home_json`). */
export interface HomeSnapshot {
  /** The Copy's id on the Home Server. */
  copyId: number;
  /** Where the Home Server keeps it inside its Root; null from a Home Server that does not say. */
  relPath: string | null;
  size: number;
  /** The Video's SHA-256 identity on the Home Server (only a Video known by its bytes has one); checked after the fetch. */
  contentHash: string | null;
  container: string | null;
  /** A Video only the Home Server knows: its data becomes the new local Video's Unshared data (§8). */
  homeOnly: boolean;
  title: string;
  titleLatin: string | null;
  type: string;
  chapters: { startS: number; title: string; titleLatin: string | null }[];
}

export type FetchOutcome =
  | { ok: true; bytes: number }
  | { ok: false; kind: "unreachable" | "disk_full" | "gone" | "cancelled" | "io"; message: string };

/** A destination path inside a Root from the Home Server's `rel_path`: `/` separators, no `..`, nothing absolute. Null if unusable. */
export function safeRelPath(rel: string | null | undefined): string | null {
  if (!rel || rel.includes("\0")) return null;
  const parts = rel.replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".");
  if (!parts.length || parts.includes("..")) return null;
  return parts.join("/");
}

/** Used when the Home Server did not say where the file lives (an older server): the title in the Root's top folder. */
export function fallbackRelPath(title: string, container: string | null): string {
  const base = title.replace(/[\\/:*?"<>|\0]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "Video";
  const ext = (container ?? "mp4").split(",")[0]!.trim().replace(/[^a-z0-9]/gi, "") || "mp4";
  return `${base}.${ext}`;
}

/** `name.ext` → `name (home).ext` → `name (home 2).ext`: a name that is free according to `taken`. */
export function freeRelPath(rel: string, taken: (rel: string) => boolean): string {
  if (!taken(rel)) return rel;
  const dir = posix.dirname(rel);
  const ext = posix.extname(rel);
  const stem = posix.basename(rel, ext);
  for (let n = 1; ; n++) {
    const name = `${stem} (home${n > 1 ? ` ${n}` : ""})${ext}`;
    const cand = dir === "." ? name : `${dir}/${name}`;
    if (!taken(cand)) return cand;
  }
}

/** The §8 checks of a fetched file: its size against the Home Server's, and for a hash-identified Video its SHA-256. */
export function checkFetched(f: { size: number; expectedSize: number; hash?: string | null; expectedHash?: string | null }): { reason: "size_mismatch" | "hash_mismatch"; line: string } | null {
  if (f.size !== f.expectedSize) return { reason: "size_mismatch", line: `got ${f.size} bytes, the Home Server's Copy is ${f.expectedSize}` };
  if (f.expectedHash && f.hash && f.hash.toLowerCase() !== f.expectedHash.toLowerCase()) return { reason: "hash_mismatch", line: `SHA-256 ${f.hash.slice(0, 12)}… is not the Video's ${f.expectedHash.slice(0, 12)}…` };
  return null;
}

/** How long a Home Server item waits before it tries again (§9: retried when the Home Server returns): 30 s, 1, 2, 5 min, then every 5. */
export function retryDelayMs(attempt: number): number {
  return [30_000, 60_000, 120_000, 300_000][Math.min(Math.max(attempt, 1), 4) - 1]!;
}

/** `bytes 100-199/200` → its first byte; null when it is not that form. */
export function contentRangeStart(h: string | null): number | null {
  const m = h?.match(/^bytes (\d+)-\d+\/(?:\d+|\*)$/i);
  return m ? Number(m[1]) : null;
}

/** Free bytes on the volume holding `dir`; null when the system will not say. */
export function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

const sizeOf = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

export interface FetchOpts {
  base: string;
  copyId: number;
  partPath: string;
  expectedSize: number;
  signal: AbortSignal;
  onProgress: (doneBytes: number) => void;
  doFetch?: typeof fetch;
  /** No bytes for this long counts as a dropped connection. Default 30 s. */
  stallMs?: number;
  /** Test hook: free space of the temp volume. */
  free?: (dir: string) => number | null;
}

/**
 * Fetch the Copy into `partPath`, continuing a partial file with `Range: bytes=<size>-`. A server that answers 200 to a
 * Range (or a Range that does not start where the file ends) restarts the file from byte 0. Drops, stalls, a 5xx and a
 * short body are `unreachable` (the partial stays for the next attempt); `ENOSPC` is `disk_full`; a 404 is `gone`.
 */
export async function fetchHomeCopy(o: FetchOpts): Promise<FetchOutcome> {
  const upstream = homeUpstream(`/home/copy/${o.copyId}`, "?download=1");
  if (!upstream) return { ok: false, kind: "io", message: "not a Home Server Copy" };
  try {
    mkdirSync(dirname(o.partPath), { recursive: true });
  } catch (e) {
    return { ok: false, kind: "io", message: (e as Error).message };
  }
  let have = sizeOf(o.partPath);
  if (have > o.expectedSize) {
    try {
      writeFileSync(o.partPath, "");
    } catch {
      /* the open below says what is wrong */
    }
    have = 0;
  }
  if (have === o.expectedSize) return { ok: true, bytes: have };
  const free = (o.free ?? freeBytes)(dirname(o.partPath));
  if (free !== null && free < o.expectedSize - have) return { ok: false, kind: "disk_full", message: `${o.expectedSize - have} bytes needed, ${free} free` };

  const stallMs = o.stallMs ?? 30_000;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  o.signal.addEventListener("abort", onAbort);
  let stalled = false;
  let fd = -1;
  try {
    const headers: Record<string, string> = have > 0 ? { range: `bytes=${have}-` } : {};
    const res = await proxyHome(new Request(`http://localhost/home${upstream}`, { headers, signal: ac.signal }), o.base, upstream, o.doFetch);
    if (o.signal.aborted) return { ok: false, kind: "cancelled", message: "cancelled" };
    if (res.status === 404) return { ok: false, kind: "gone", message: "the Home Server no longer has this Copy" };
    if (res.status === 416) {
      // our partial is not a prefix of what is there now: start over next time
      writeFileSync(o.partPath, "");
      return { ok: false, kind: "unreachable", message: "the partial file did not fit; starting over" };
    }
    if (res.status !== 200 && res.status !== 206) return { ok: false, kind: "unreachable", message: `the Home Server answered ${res.status}` };
    const resume = res.status === 206 && contentRangeStart(res.headers.get("content-range")) === have;
    if (!resume) have = 0; // 200: the whole file again
    fd = openSync(o.partPath, resume ? "a" : "w");
    let done = have;
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, kind: "unreachable", message: "the Home Server sent no body" };
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => ((stalled = true), ac.abort(), rej(new Error("stalled"))), stallMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) break;
      let off = 0;
      while (off < chunk.value.length) off += writeSync(fd, chunk.value, off, chunk.value.length - off);
      done += chunk.value.length;
      o.onProgress(done);
    }
    closeSync(fd);
    fd = -1;
    const size = sizeOf(o.partPath);
    if (size < o.expectedSize) return { ok: false, kind: "unreachable", message: `the connection ended at ${size} of ${o.expectedSize} bytes` };
    return { ok: true, bytes: size };
  } catch (e) {
    if (o.signal.aborted) return { ok: false, kind: "cancelled", message: "cancelled" };
    const code = (e as { code?: string }).code;
    if (code === "ENOSPC") return { ok: false, kind: "disk_full", message: "No space left on device" };
    if (code && /^E(IO|ACCES|PERM|ROFS|NOENT)$/.test(code)) return { ok: false, kind: "io", message: (e as Error).message };
    return { ok: false, kind: "unreachable", message: stalled ? "no data from the Home Server" : String((e as Error).message ?? e) };
  } finally {
    o.signal.removeEventListener("abort", onAbort);
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}
