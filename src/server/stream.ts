import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { extensionOf, contentTypeFor } from "./filename";
import { isIoError } from "./proc";
import { parseRange } from "./range";

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
}

/**
 * What to answer when a file under `dir` is gone, instead of a 404: the Fallback queue registers `remux/` so a
 * Fallback deleted while the app runs is rebuilt ("preparing") rather than reported lost (audit PLAY-7). The handler
 * gets the file's name and returns null to fall through to the plain 404.
 */
const missingHandlers = new Map<string, (name: string) => Response | null>();

export function onMissingFile(dir: string, handler: (name: string) => Response | null): () => void {
  missingHandlers.set(dir, handler);
  return () => {
    if (missingHandlers.get(dir) === handler) missingHandlers.delete(dir);
  };
}

/** A strong validator for one version of a file: size, mtime and inode (a file replaced under the same name changes it). */
export function etagFor(st: { size: number; mtimeMs: number; ino: number | bigint }): string {
  return `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}-${st.ino.toString(16)}"`;
}

/** RFC 9110 §13.1.5: a Range applies only when If-Range names the current version (a strong ETag or the exact date). */
function ifRangeMatches(ifRange: string | null, etag: string, lastModified: string): boolean {
  if (ifRange == null) return true;
  const v = ifRange.trim();
  if (v.startsWith('"')) return v === etag;
  if (v.startsWith("W/")) return false; // weak tags never match for If-Range
  return v === lastModified;
}

/**
 * Serve one file with Range support (spec 3.3): Accept-Ranges, 206 with Content-Range, 416 when the
 * start is past the end. Size comes from stat at request time, not from the database. Every answer carries an
 * ETag and Last-Modified, and `If-Range` is honoured: a Range request made for a file that has since been replaced
 * under the same URL gets the new file whole (200), never a splice of two files (audit PLAY-13).
 */
export async function serveFile(req: Request, path: string, contentType = contentTypeFor(extensionOf(path))): Promise<Response> {
  let size: number;
  let etag: string;
  let lastModified: string;
  try {
    const st = await stat(path);
    if (!st.isFile()) return json({ error: "not a file" }, 404);
    size = st.size;
    etag = etagFor(st);
    lastModified = new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return missingHandlers.get(dirname(path))?.(basename(path)) ?? json({ error: "file not found" }, 404);
    // EIO and friends: the drive is misbehaving, which is retryable, never "gone"
    return json({ error: "file temporarily unreadable", retryable: isIoError(e) }, 503, { "retry-after": "5" });
  }
  const base = { "accept-ranges": "bytes", "content-type": contentType, etag, "last-modified": lastModified };
  const range = ifRangeMatches(req.headers.get("if-range"), etag, lastModified) ? parseRange(req.headers.get("range"), size) : ({ kind: "none" } as const);
  if (range.kind === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  }
  const head = req.method === "HEAD";
  if (range.kind === "range") {
    const length = range.end - range.start + 1;
    return new Response(head ? null : Bun.file(path).slice(range.start, range.end + 1), {
      status: 206,
      headers: { ...base, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(length) },
    });
  }
  return new Response(head ? null : Bun.file(path), { status: 200, headers: { ...base, "content-length": String(size) } });
}
