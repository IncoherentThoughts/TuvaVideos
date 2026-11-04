import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isIoError, sleep } from "./proc";

/**
 * Hashes learned by the #21 thumbnail script, keyed `path|size|mtimeMs`. Read-only seed: saves
 * re-reading ~70 id-less local files at the first scan.
 */
export function loadSeedHashes(thumbsDir: string): Map<string, string> {
  const file = join(thumbsDir, "hash-cache.json");
  const m = new Map<string, string>();
  try {
    if (existsSync(file)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) m.set(k, String(v));
  } catch {
    // an unreadable seed is just a cache miss
  }
  return m;
}

export function seedKey(absPath: string, size: number, mtimeMs: number): string {
  return `${absPath}|${size}|${Math.round(mtimeMs)}`;
}

/** No bytes for this long means the drive is hung (a stuck USB read can block forever rather than fail): audit DB-10. */
export const HASH_STALL_MS = 60_000;

function sha256Once(path: string, stallMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = new Bun.CryptoHasher("sha256");
    const s = createReadStream(path);
    let last = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - last < stallMs) return;
      clearInterval(timer);
      s.destroy();
      reject(Object.assign(new Error(`read stalled: no data for ${Math.round(stallMs / 1000)} s`), { code: "ETIMEDOUT" }));
    }, Math.max(20, Math.min(5000, stallMs / 4)));
    s.on("data", (d) => {
      last = Date.now();
      h.update(d as Buffer);
    });
    s.on("error", (e) => (clearInterval(timer), reject(e)));
    s.on("end", () => (clearInterval(timer), resolve(h.digest("hex"))));
  });
}

/** SHA-256 of the whole file; I/O errors (a stall included) are retried, other errors thrown. */
export async function sha256File(path: string, opts: { stallMs?: number; retryDelayMs?: number } = {}): Promise<string> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await sha256Once(path, opts.stallMs ?? HASH_STALL_MS);
    } catch (e) {
      last = e;
      if (!isIoError(e)) throw e;
      await sleep((opts.retryDelayMs ?? 3000) * attempt);
    }
  }
  throw last;
}
