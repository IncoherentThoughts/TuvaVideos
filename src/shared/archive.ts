// The Tuvan Lyrics Archive as this app reaches it (docs/sharing-spec.md §4.9, §5.2; ticket #130): the project URL and
// publishable key (committed: the key is public, RLS and the session gate everything), the `TUVA_ARCHIVE_URL` /
// `TUVA_ARCHIVE_KEY` overrides, and the typed RPC calls on top of src/shared/archiveWire.ts.
//
// supabase-js lives in the browser bundle only (src/web/session.ts creates the client). This file never imports it:
// the calls take any object with supabase-js's `rpc(fn, args)` shape, and `postgrestClient` is the companion's
// plain-fetch stand-in for the one place it talks to the archive (Sync).
import { readArchiveError, type ArchiveError, type OpOf, type VideoWhoami, type WriteArgs, type WriteFunction, type WriteResult } from "./archiveWire";
import type { Iso, SharedChanges } from "./sharedRows";

/** The archive's Supabase project (tuvan-lyrics). */
export const ARCHIVE_URL = "https://ejabfdkhdmcfpvpwcuau.supabase.co";
/** Its publishable key (`sb_publishable_`, the legacy anon JWT's successor; both are public). */
export const ARCHIVE_KEY = "sb_publishable_yM9mqdTJvir3I5YuadGlLQ_bkGGIbM2";

export interface ArchiveEndpoint {
  url: string;
  key: string;
}

/** The committed project, or the `TUVA_ARCHIVE_URL` / `TUVA_ARCHIVE_KEY` overrides (tests, branch databases). */
export function archiveEndpoint(env: Record<string, string | undefined> = {}): ArchiveEndpoint {
  return { url: (env.TUVA_ARCHIVE_URL || ARCHIVE_URL).replace(/\/+$/, ""), key: env.TUVA_ARCHIVE_KEY || ARCHIVE_KEY };
}

/** A PostgREST error as supabase-js hands it over. */
export interface PostgrestErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/** The slice of a supabase-js client the calls use: `supabase.rpc(fn, args)` resolves to `{data, error, status}`. */
export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: PostgrestErrorLike | null; status?: number }>;
}

/**
 * One call's outcome. `unreachable`: the request never got an HTTP answer (offline, DNS, the archive down), which the
 * session layer counts as "the archive cannot be reached" (§5.3). `unauthorized`: PostgREST refused the token itself
 * (HTTP 401: expired, malformed or another project's), as opposed to a function's own `42501`.
 */
export type ArchiveCall<T> =
  | { ok: true; value: T }
  | { ok: false; error: ArchiveError; unreachable: boolean; unauthorized: boolean };

async function call<T>(c: RpcClient, fn: string, args?: Record<string, unknown>): Promise<ArchiveCall<T>> {
  let res: { data: unknown; error: PostgrestErrorLike | null; status?: number };
  try {
    res = await c.rpc(fn, args);
  } catch (e) {
    return { ok: false, error: { word: "unknown", code: null, message: String((e as Error)?.message ?? e), detail: null }, unreachable: true, unauthorized: false };
  }
  if (res.error) {
    // supabase-js reports a failed fetch as status 0 with an empty code.
    const unreachable = res.status === 0 || (res.status == null && !res.error.code);
    return { ok: false, error: readArchiveError(res.error), unreachable, unauthorized: res.status === 401 };
  }
  return { ok: true, value: res.data as T };
}

/** `video_whoami()`: who the token belongs to, the grant, the archive's `shared_schema` and clock. */
export const whoami = (c: RpcClient) => call<VideoWhoami>(c, "video_whoami");

/** One write function (§4.1); the result goes to `POST /api/cache/apply` as it is. */
export const callWrite = <F extends WriteFunction, O extends OpOf<F>>(c: RpcClient, fn: F, args: WriteArgs<F, O>) =>
  call<WriteResult>(c, fn, args as unknown as Record<string, unknown>);

/** `shared_changes_since(p_since)`: the pull (§6.2); null asks for everything. */
export const changesSince = (c: RpcClient, since: Iso | null) => call<SharedChanges>(c, "shared_changes_since", { p_since: since });

/**
 * The companion's RpcClient: PostgREST over plain fetch with the browser's access token, for the length of one Sync.
 * The token goes in the Authorization header only, never a URL, a log line or an error message.
 */
export function postgrestClient(ep: ArchiveEndpoint, accessToken: string, fetchImpl: typeof fetch = fetch): RpcClient {
  return {
    async rpc(fn, args) {
      let r: Response;
      try {
        r = await fetchImpl(`${ep.url}/rest/v1/rpc/${encodeURIComponent(fn)}`, {
          method: "POST",
          headers: { apikey: ep.key, authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(args ?? {}),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        return { data: null, error: { code: "", message: `the archive can't be reached (${(e as Error)?.name ?? "error"})` }, status: 0 };
      }
      const text = await r.text().catch(() => "");
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!r.ok) {
        const e = (body && typeof body === "object" ? body : {}) as PostgrestErrorLike;
        return { data: null, error: { code: e.code ?? null, message: e.message ?? `HTTP ${r.status}`, details: e.details ?? null, hint: e.hint ?? null }, status: r.status };
      }
      return { data: body, error: null, status: r.status };
    },
  };
}

/** The `exp` claim (seconds) of a JWT, read without verifying it (Supabase verifies the token when it is used). */
export function tokenExp(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    return typeof json?.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

/** True when the value is shaped like a JWT access token (three base64url parts). */
export function looksLikeJwt(token: unknown): token is string {
  return typeof token === "string" && token.length < 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token);
}
