// Tailscale devices, approved on sight (docs/home-server-spec.md §3.1, ADR 0011). A request to the Library Server from a
// Tailscale address is looked up with `tailscale whois --json <ip>`; a device of the same Tailscale user as this Mac
// (`tailscale status --json` -> Self.UserID) is an Approved device at once. Anything else (another user, a tagged
// node, a failed lookup) falls through to the click path (§3.2). The decision is `tailscaleDecision`, pure.
import { existsSync } from "node:fs";
import { log } from "./log";

/** How long one lookup's answer stands per IP (§3.1). */
export const TAILSCALE_CACHE_MS = 10 * 60_000;
/** A failed lookup (Tailscale not running, the CLI missing) is retried this soon, not after 10 min: an assumption (#239). */
export const TAILSCALE_FAIL_CACHE_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 3_000;

/** 100.64.0.0/10 (Tailscale's CGNAT range) or fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(ip: string): boolean {
  const a = ip.trim().toLowerCase().replace(/^::ffff:/, "");
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m) return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
  return /^fd7a:115c:a1e0:/.test(a);
}

export type TailscaleDecision =
  | { approve: true; kind: "tv" | "mac"; name: string | null; login: string | null }
  | { approve: false; reason: "lookup failed" | "other user" };

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const id = (v: unknown): string | null => (typeof v === "number" || (typeof v === "string" && v !== "") ? String(v) : null);

/** Operating systems Tailscale reports for a television; every other same-user device counts as a Mac (§3.1). */
const TV_OS = /^(tvos|webos|tizen|androidtv)$/i;

/**
 * The approval decision over the two JSON answers (§3.1), either of which may be null (the command failed or printed
 * no JSON). The peer's user is `Node.User` (falling back to `UserProfile.ID`); this Mac's is `Self.UserID`. A tagged
 * node is owned by the tag, not a user, so its `Node.User` never matches.
 */
export function tailscaleDecision(whois: unknown, status: unknown): TailscaleDecision {
  const w = obj(whois);
  const node = obj(w?.Node);
  const profile = obj(w?.UserProfile);
  const self = obj(obj(status)?.Self);
  const peerUser = id(node?.User) ?? id(profile?.ID);
  const selfUser = id(self?.UserID);
  if (!node || !peerUser || !selfUser) return { approve: false, reason: "lookup failed" };
  if (peerUser !== selfUser || (Array.isArray(node.Tags) && node.Tags.length > 0)) return { approve: false, reason: "other user" };
  const host = obj(node.Hostinfo);
  const os = str(host?.OS);
  const name = str(host?.Hostname) ?? str(node.ComputedName) ?? str(node.Name)?.split(".")[0] ?? null;
  return { approve: true, kind: os && TV_OS.test(os) ? "tv" : "mac", name, login: str(profile?.LoginName) };
}

/** Runs one CLI command and parses its stdout as JSON; null when it fails, times out or prints no JSON. */
export type TailscaleRun = (args: string[]) => Promise<unknown>;

/** The CLI: `TUVA_TAILSCALE` (tests and smoke runs: a stub), `/usr/local/bin/tailscale`, else the one inside the app. */
export function tailscaleCli(env: Record<string, string | undefined> = process.env): string | null {
  if (env.TUVA_TAILSCALE) return env.TUVA_TAILSCALE;
  for (const p of ["/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) if (existsSync(p)) return p;
  return null;
}

export function cliRunner(cli: string | null): TailscaleRun {
  return async (args) => {
    if (!cli) return null;
    try {
      const p = Bun.spawn([cli, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: process.env });
      const timer = setTimeout(() => p.kill(), LOOKUP_TIMEOUT_MS);
      const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      clearTimeout(timer);
      return code === 0 ? JSON.parse(out) : null;
    } catch {
      return null;
    }
  };
}

/** The per-IP cache around the decision; concurrent requests from one IP share one lookup. */
export class TailscaleCheck {
  private cache = new Map<string, { at: number; ttl: number; d: TailscaleDecision }>();
  private inflight = new Map<string, Promise<TailscaleDecision>>();

  constructor(
    private run: TailscaleRun,
    private now: () => number = Date.now,
  ) {}

  async check(ip: string): Promise<TailscaleDecision> {
    const hit = this.cache.get(ip);
    if (hit && this.now() - hit.at < hit.ttl) return hit.d;
    const going = this.inflight.get(ip);
    if (going) return going;
    const p = (async () => {
      const [whois, status] = await Promise.all([this.run(["whois", "--json", ip]), this.run(["status", "--json"])]);
      const d = tailscaleDecision(whois, status);
      this.cache.set(ip, { at: this.now(), ttl: d.approve || d.reason === "other user" ? TAILSCALE_CACHE_MS : TAILSCALE_FAIL_CACHE_MS, d });
      log(`Tailscale ${ip}: ${d.approve ? `same user, approved as ${d.kind === "mac" ? "a Mac" : "a TV"}${d.name ? ` (${d.name})` : ""}` : d.reason}`);
      return d;
    })().finally(() => this.inflight.delete(ip));
    this.inflight.set(ip, p);
    return p;
  }
}
