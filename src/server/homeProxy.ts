// home-server-spec §5.4: the browser never talks to the Home Server. This Mac's localhost app passes a short list of
// Home Server routes through, under `/home/...`, to the Home Server's Library Server (where this Mac is an Approved
// device of kind 'mac'): its Copies (Range passed through), Live streams, keyframe indexes, Copy state (a Fallback
// being made there) and saved Audio settings. Nothing else of the Home Server is reachable from the tab.
import { UUID_PATTERN } from "../shared/ids";

/** `/home/<path>` → the Home Server path it stands for (with the query kept for Live streams), or null. Pure. */
export function homeUpstream(pathname: string, search = ""): string | null {
  if (!pathname.startsWith("/home/")) return null;
  const rest = pathname.slice("/home".length);
  if (/^\/copy\/\d+$/.test(rest)) return rest;
  if (/^\/live\/\d+\/(index\.m3u8|seg\d+\.ts)$/.test(rest)) return rest + (/^\?q=(orig|\d{3,4})$/.test(search) ? search : "");
  if (/^\/api\/copies\/\d+(\/keyframes)?$/.test(rest)) return rest;
  if (new RegExp(`^/api/videos/${UUID_PATTERN}/audio$`).test(rest)) return rest;
  return null;
}

/** Request headers passed to the Home Server, and response headers passed back. */
const REQ_HEADERS = ["range", "if-range"];
const RES_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "retry-after", "cache-control", "etag", "last-modified"];

/** How long the Home Server may take to start answering (the body then streams for as long as it plays). */
const HEADERS_TIMEOUT_MS = 15_000;

/**
 * Pass one request through to the Home Server at `base`. The upstream request is cancelled when the tab's request goes
 * away (a seek, a Copy switch, leaving the Player), so the Home Server never streams to nobody.
 */
export async function proxyHome(req: Request, base: string | null, upstream: string, doFetch: typeof fetch = fetch): Promise<Response> {
  const fail = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (!base) return fail(404, "no Home Server");
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  req.signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ac.abort(), HEADERS_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  for (const h of REQ_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  try {
    const r = await doFetch(`${base}${upstream}`, { method: req.method === "HEAD" ? "HEAD" : "GET", headers, signal: ac.signal, decompress: false } as RequestInit);
    clearTimeout(timer);
    const out = new Headers();
    for (const h of RES_HEADERS) {
      const v = r.headers.get(h);
      if (v) out.set(h, v);
    }
    if (r.status === 403) return fail(502, "the Home Server does not know this Mac");
    return new Response(req.method === "HEAD" ? null : r.body, { status: r.status, headers: out });
  } catch {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", onAbort);
    return fail(502, "the Home Server did not answer");
  }
}
