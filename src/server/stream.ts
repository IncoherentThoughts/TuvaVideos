import { stat } from "node:fs/promises";
import { extensionOf, contentTypeFor } from "./filename";
import { isIoError } from "./proc";
import { parseRange } from "./range";

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
}

/**
 * Serve one file with Range support (spec 3.3): Accept-Ranges, 206 with Content-Range, 416 when the
 * start is past the end. Size comes from stat at request time, not from the database.
 */
export async function serveFile(req: Request, path: string, contentType = contentTypeFor(extensionOf(path))): Promise<Response> {
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) return json({ error: "not a file" }, 404);
    size = st.size;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return json({ error: "file not found" }, 404);
    // EIO and friends: the drive is misbehaving, which is retryable, never "gone"
    return json({ error: "file temporarily unreadable", retryable: isIoError(e) }, 503, { "retry-after": "5" });
  }
  const base = { "accept-ranges": "bytes", "content-type": contentType };
  const range = parseRange(req.headers.get("range"), size);
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
