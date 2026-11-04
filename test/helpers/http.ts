// The localhost guard (src/server/localOnly.ts) refuses a write whose body is not `application/json` (a CORS simple
// request type). Test helpers that send JSON bodies without naming the type go through this.

/** `init` with `content-type: application/json` when it has a body and no content type of its own. */
export function jsonInit(init?: RequestInit): RequestInit | undefined {
  if (!init || init.body == null) return init;
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return { ...init, headers };
}
