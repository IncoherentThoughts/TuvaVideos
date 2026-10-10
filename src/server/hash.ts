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

function sha256Once(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = new Bun.CryptoHasher("sha256");
    const s = createReadStream(path);
    s.on("data", (d) => h.update(d as Buffer));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/** SHA-256 of the whole file; I/O errors are retried, other errors thrown. */
export async function sha256File(path: string): Promise<string> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await sha256Once(path);
    } catch (e) {
      last = e;
      if (!isIoError(e)) throw e;
      await sleep(3000 * attempt);
    }
  }
  throw last;
}
