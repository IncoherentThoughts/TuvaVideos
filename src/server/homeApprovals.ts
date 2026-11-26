// Allow from any approved Mac (docs/home-server-spec.md §3.2): this Mac's localhost app asks its Home Server's
// Library Server for pending TV approvals (`GET /api/approvals`) and sends Allow / Deny (`POST /api/approvals/:ip`),
// so the browser never talks to another machine. The Home Server's address is injected (`HomeServerTarget`): the app
// passes the stored setting (`HomeServer.target`, src/server/homeServer.ts), which `TUVA_HOME_SERVER` overrides.
import type { HomeApprovalsDto, RemoteApprovalsDto } from "../shared/types";

/** The Home Server's Library Server base URL (`http://mini.tailnet.ts.net:4401`), or null when none is set. */
export type HomeServerTarget = () => string | null;

export const homeServerFromEnv =
  (env: Record<string, string | undefined> = process.env): HomeServerTarget =>
  () =>
    env.TUVA_HOME_SERVER?.replace(/\/+$/, "") || null;

const REMOTE_TIMEOUT_MS = 4_000;

const none = (configured: boolean): HomeApprovalsDto => ({ configured, connected: false, server: null, pending: [] });

function parse(body: unknown): RemoteApprovalsDto | null {
  const b = body as RemoteApprovalsDto | null;
  if (!b || typeof b.server !== "string" || !Array.isArray(b.pending)) return null;
  return { server: b.server, pending: b.pending.filter((p) => p && typeof p.ip === "string").map((p) => ({ ip: p.ip, model: typeof p.model === "string" ? p.model : null })) };
}

async function call(base: string, path: string, init: RequestInit, fetchFn: typeof fetch): Promise<HomeApprovalsDto> {
  try {
    const r = await fetchFn(`${base}${path}`, { ...init, signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
    const b = r.ok ? parse(await r.json()) : null;
    return b ? { configured: true, connected: true, ...b } : none(true);
  } catch {
    return none(true);
  }
}

export function homeApprovals(target: HomeServerTarget, fetchFn: typeof fetch = fetch): Promise<HomeApprovalsDto> {
  const base = target();
  return base ? call(base, "/api/approvals", {}, fetchFn) : Promise.resolve(none(false));
}

export async function answerHomeApproval(target: HomeServerTarget, ip: string, allow: boolean, fetchFn: typeof fetch = fetch): Promise<HomeApprovalsDto> {
  const base = target();
  if (!base) return none(false);
  const answered = await call(base, `/api/approvals/${encodeURIComponent(ip)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ allow }) }, fetchFn);
  // a refused answer (already answered on another Mac: 404) still returns what is pending now
  return answered.connected ? answered : call(base, "/api/approvals", {}, fetchFn);
}
