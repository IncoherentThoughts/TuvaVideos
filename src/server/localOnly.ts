// The localhost app's request guard (docs/audit/01-security.md SEC-1..SEC-3, SEC-5) and the stricter Origin and Host
// checks of docs/sharing-spec.md §5.2 for the routes that write the Local copy from the browser (`POST
// /api/cache/apply`) or take an access token (`/api/sync`). The companion listens on 127.0.0.1 only; these checks stop
// a page of another site (DNS rebinding, a cross-site form or `fetch(…, {mode: "no-cors"})`) from reaching it.
// Requests the TV Server passes in (tv.ts) are marked and judged by the TV Server instead. Pure but for that mark.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The methods that change state: a browser sends an Origin with every one of them. */
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The body types a write may carry. A cross-site page can send `text/plain`, `multipart/form-data`,
 * `application/x-www-form-urlencoded` or no type at all without a preflight (a CORS "simple" request); none of them is
 * accepted, so a write with a body always needs a preflight, which the companion never answers.
 */
const BODY_TYPES = new Set(["application/json", "image/png"]);

const viaTv = new WeakSet<Request>();

/** The TV Server hands this request to the localhost handler: its Host is the Mac's LAN address, its IP was checked. */
export function markTvRequest(req: Request): void {
  viaTv.add(req);
}

function parseHost(host: string): { hostname: string; port: string } | null {
  try {
    const u = new URL(`http://${host}`);
    return { hostname: u.hostname, port: u.port || "80" };
  } catch {
    return null;
  }
}

/** The Host check alone, for reads that carry no token but name the signed-in account (`GET /api/session`). */
export function hostError(req: Request, port?: number | null): string | null {
  const host = req.headers.get("host");
  if (!host) return "no Host header";
  const h = parseHost(host);
  if (!h) return "bad Host header";
  if (!LOOPBACK.has(h.hostname)) return "Host is not this machine";
  if (port && h.port !== String(port)) return "Host is not this companion's port";
  return null;
}

/** `http://localhost:4400`: the origin of this companion's own pages, from a Host that passed `hostError`. */
const ownOrigin = (req: Request): string => {
  const h = parseHost(req.headers.get("host")!)!;
  return `http://${h.hostname}${h.port === "80" ? "" : `:${h.port}`}`;
};

const originOf = (s: string): string | null => {
  if (s === "null") return null; // a sandboxed frame, a file:// page, a redirect: never ours
  try {
    const o = new URL(s).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
};

/** Why the request is refused, or null when it comes from this companion's own pages. An Origin is required. */
export function localRequestError(req: Request): string | null {
  const bad = hostError(req);
  if (bad) return bad;
  const origin = req.headers.get("origin");
  if (!origin) return "no Origin header";
  if (originOf(origin) !== ownOrigin(req)) return "Origin is not this companion";
  return null;
}

export interface Refusal {
  status: 403 | 415;
  error: string;
}

/**
 * The check at the top of the localhost handler, for every request (`port`: the port this listener is bound to).
 * Every request: the Host must be this machine's loopback name and port (DNS rebinding). Every write: the Origin, or
 * the Referer when a client sent no Origin, must be this companion's own; a write with neither is a non-browser
 * client on this machine (curl, a script), which the Host check already admits. A write with a body must carry one of
 * `BODY_TYPES`. The TV Server's requests pass: it checks them itself (source IP, route list, tv.ts).
 */
export function localGuard(req: Request, port: number | null): Refusal | null {
  if (viaTv.has(req)) return null;
  const host = hostError(req, port);
  if (host) return { status: 403, error: host };
  if (!WRITES.has(req.method)) return null;
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  if (origin != null) {
    if (originOf(origin) !== ownOrigin(req)) return { status: 403, error: "Origin is not this companion" };
  } else if (referer != null && originOf(referer) !== ownOrigin(req)) {
    return { status: 403, error: "Referer is not this companion" };
  }
  if (req.body != null && req.headers.get("content-length") !== "0") {
    const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!BODY_TYPES.has(type)) return { status: 415, error: "a request body must be application/json" };
  }
  return null;
}

/** Headers for the companion's HTML pages: never framed by another site (clickjacking on Allow TV, Delete). */
export const FRAME_HEADERS: Readonly<Record<string, string>> = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
};

/** Add `FRAME_HEADERS` to an HTML response (the shell); other responses pass untouched. */
export function withFrameHeaders(res: Response): Response {
  if (!res.headers.get("content-type")?.startsWith("text/html")) return res;
  try {
    for (const [k, v] of Object.entries(FRAME_HEADERS)) res.headers.set(k, v);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    for (const [k, v] of Object.entries(FRAME_HEADERS)) copy.headers.set(k, v);
    return copy;
  }
}
