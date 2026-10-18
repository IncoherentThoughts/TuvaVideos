// The Origin and Host checks of docs/sharing-spec.md §5.2 for the routes that write the Local copy from the browser
// (`POST /api/cache/apply`) and, later, take an access token (`/api/sync`, ticket #115). The companion listens on
// 127.0.0.1 only; these checks also stop a page of another site (DNS rebinding, a cross-site form) from reaching them.
// Pure.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why the request is refused, or null when it comes from this companion's own pages. */
export function localRequestError(req: Request): string | null {
  const host = req.headers.get("host");
  if (!host) return "no Host header";
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return "bad Host header";
  }
  if (!LOOPBACK.has(hostname)) return "Host is not this machine";
  const origin = req.headers.get("origin");
  if (!origin) return "no Origin header";
  if (origin !== `http://${host}`) return "Origin is not this companion";
  return null;
}
