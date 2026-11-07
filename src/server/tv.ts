// The TV Server (docs/tv-spec.md 2, ADR 0004): a second `Bun.serve` in this process on all IPv4 interfaces, started
// and stopped from the browser's TV button, off at every launch. Every request is checked against the Approved TVs by
// source IP; the routes are a fixed list (tvRoutes.ts) that reuses the localhost handler.
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { log } from "./log";
import { FRAME_HEADERS } from "./localOnly";
import { markTvRequest } from "./tvRequest";
import { excludeNotHere, matchTvRoute, notHereVideoIds, stripPaths, tvListOf } from "./tvRoutes";
import type { TvBundle } from "./web";
import type { ApprovedTvDto, TvStateDto } from "../shared/types";

type Handler = (req: Request) => Promise<Response>;

export const TV_APP_NAME = "TuvaVideos TV Server";
/** An Approved TV that made a request this recently is "talking" (spec 2.4). */
export const ACTIVE_WINDOW_MS = 60_000;
/** `last_seen_at` is written at most this often per TV. */
const SEEN_WRITE_MS = 5_000;

export type { ApprovedTvDto, TvStateDto };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** `::ffff:192.168.4.56` -> `192.168.4.56`. */
export const normalizeIp = (a: string): string => a.replace(/^::ffff:/i, "");

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  }
  return out;
}

/**
 * This machine's own addresses: loopback and its LAN IPs. A request from one is a page in a browser on this Mac, never
 * a TV, so it is never approved (docs/audit/01-security.md SEC-1) unless `TUVA_TV_LOOPBACK=1` (Config.tvLoopback).
 */
export function isOwnAddress(ip: string, lan: readonly string[] = lanAddresses()): boolean {
  ip = normalizeIp(ip.trim()).toLowerCase();
  return /^127\./.test(ip) || ip === "::1" || ip === "0.0.0.0" || ip === "::" || ip === "localhost" || lan.includes(ip);
}

/**
 * The Origins the TV app sends: none (Tizen, whose `<access origin="*">` skips CORS) or the LG shell's `file://`
 * page, which browsers send as `null`. Only these get CORS headers (SEC-4); an http(s) Origin is never reflected.
 * `devLoopback` (`TUVA_TV_LOOPBACK=1`) adds a page on this machine's loopback, the shell served for desktop testing
 * (tv/shell/README.md).
 */
export const tvCorsOrigin = (origin: string | null, devLoopback = false): boolean =>
  origin == null || origin === "null" || origin.startsWith("file://") || (devLoopback && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin));

/**
 * Why the TV listener refuses a request before its IP is checked, or null. A Host that is a name rather than an
 * address is a DNS-rebinding page (the TV and its shell use the Mac's IP); an http(s) Origin other than the listener's
 * own (the desktop page at `/`) is another site's page in a browser at an Approved IP.
 */
export function tvRequestError(req: Request, devLoopback = false): string | null {
  const host = req.headers.get("host");
  let own: string | null = null;
  if (host != null) {
    let hostname: string;
    try {
      const u = new URL(`http://${host}`);
      hostname = u.hostname;
      own = u.origin;
    } catch {
      return "bad Host header";
    }
    if (hostname !== "localhost" && !/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && !/^\[[0-9a-f:.]+\]$/i.test(hostname)) return "Host is not an address of this machine";
  }
  const origin = req.headers.get("origin");
  if (tvCorsOrigin(origin, devLoopback)) return null;
  let o: string | null = null;
  try {
    o = new URL(origin!).origin;
  } catch {
    // not a URL
  }
  return o != null && o === own ? null : "Origin is not the TV app";
}

interface Activity {
  ip: string;
  model: string | null;
  at: number;
  title: string | null;
}

export class TvServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private handler: Handler | null = null;
  private bundle: Pick<TvBundle, "serve"> | null = null;
  private pending = new Map<string, string | null>();
  private denied = new Set<string>();
  private seenWritten = new Map<string, number>();
  private activity: Activity | null = null;
  private stopHooks: (() => void)[] = [];

  constructor(private deps: { cfg: Pick<Config, "tvPort" | "passive" | "webDir" | "tvLoopback">; db: Db }) {}

  /** An address that may be approved and served: not this machine's own (unless `tvLoopback`). */
  private mayBeTv(ip: string): boolean {
    return ip !== "" && (!!this.deps.cfg.tvLoopback || !isOwnAddress(ip));
  }

  setHandler(h: Handler) {
    this.handler = h;
  }

  /** The built TV UI (`/tv.js`, `/tv.css`); without one the TV Server serves empty files. */
  setBundle(b: Pick<TvBundle, "serve">) {
    this.bundle = b;
  }

  /** Called on every hard stop; the Live remux (tv-live-remux) registers its ffmpeg kill here. */
  onStop(fn: () => void) {
    this.stopHooks.push(fn);
  }

  get on(): boolean {
    return this.server != null;
  }

  get port(): number | null {
    return this.server?.port ?? null;
  }

  start(): { ok: true } | { ok: false; status: number; error: string } {
    if (this.deps.cfg.passive) return { ok: false, status: 409, error: "a passive server never starts the TV Server" };
    if (this.server) return { ok: true };
    if (!this.handler) return { ok: false, status: 500, error: "no handler" };
    this.denied.clear(); // Deny lasts until the next turn-on
    this.pending.clear();
    try {
      this.server = Bun.serve({
        port: this.deps.cfg.tvPort,
        hostname: "0.0.0.0",
        idleTimeout: 120,
        fetch: (req, server) => this.fetch(req, normalizeIp(server.requestIP(req)?.address ?? "")),
      });
    } catch (e) {
      return { ok: false, status: 500, error: `could not listen on port ${this.deps.cfg.tvPort}: ${String((e as Error).message ?? e)}` };
    }
    const addrs = lanAddresses();
    log(`TV Server on, port ${this.server.port}, addresses ${addrs.length ? addrs.map((a) => `http://${a}:${this.server!.port}`).join(" ") : "(none)"}`);
    return { ok: true };
  }

  /** A hard stop: the listener closes and every open stream is cut. */
  stop() {
    if (!this.server) return;
    this.server.stop(true);
    this.server = null;
    this.pending.clear();
    this.activity = null;
    for (const fn of this.stopHooks) {
      try {
        fn();
      } catch (e) {
        log("TV Server stop hook failed", String(e));
      }
    }
    log("TV Server off");
  }

  // ---- the allowlist ----

  approved(): ApprovedTvDto[] {
    return (this.deps.db.query("SELECT ip, model, approved_at, last_seen_at FROM approved_tv ORDER BY approved_at, ip").all() as { ip: string; model: string | null; approved_at: string; last_seen_at: string | null }[]).map((r) => ({
      ip: r.ip,
      model: r.model,
      approvedAt: r.approved_at,
      lastSeenAt: r.last_seen_at,
    }));
  }

  private isApproved(ip: string): boolean {
    // a row for this machine's own address (stored before SEC-1, or under TUVA_TV_LOOPBACK) is listed, not served
    return this.mayBeTv(ip) && this.deps.db.query("SELECT 1 FROM approved_tv WHERE ip = ?").get(ip) != null;
  }

  /** False, and nothing stored, for an empty address or this machine's own (`isOwnAddress`). */
  approve(ip: string): boolean {
    ip = normalizeIp(ip.trim());
    if (!this.mayBeTv(ip)) return false;
    const model = this.pending.get(ip) ?? null;
    const now = new Date().toISOString();
    this.deps.db
      .query("INSERT INTO approved_tv (ip, model, approved_at, last_seen_at) VALUES (?, ?, ?, NULL) ON CONFLICT(ip) DO UPDATE SET model = COALESCE(excluded.model, model)")
      .run(ip, model, now);
    this.pending.delete(ip);
    this.denied.delete(ip);
    return true;
  }

  deny(ip: string) {
    ip = normalizeIp(ip.trim());
    this.pending.delete(ip);
    if (ip) this.denied.add(ip);
  }

  /** Remove puts the TV's next request back through the prompt. */
  remove(ip: string): boolean {
    ip = normalizeIp(ip.trim());
    const r = this.deps.db.query("DELETE FROM approved_tv WHERE ip = ?").run(ip);
    this.denied.delete(ip);
    this.seenWritten.delete(ip);
    if (this.activity?.ip === ip) this.activity = null;
    return r.changes > 0;
  }

  state(): TvStateDto {
    const approved = this.approved();
    const a = this.activity;
    const playing = this.on && a && Date.now() - a.at <= ACTIVE_WINDOW_MS && approved.some((t) => t.ip === a.ip) ? { ip: a.ip, model: approved.find((t) => t.ip === a.ip)?.model ?? a.model, title: a.title } : null;
    return {
      available: !this.deps.cfg.passive,
      on: this.on,
      port: this.port,
      addresses: lanAddresses(),
      pending: [...this.pending].map(([ip, model]) => ({ ip, model })),
      approved,
      playing,
    };
  }

  // ---- requests ----

  private touch(ip: string, model: string | null, path: string) {
    const now = Date.now();
    const db = this.deps.db;
    if (now - (this.seenWritten.get(ip) ?? 0) >= SEEN_WRITE_MS) {
      db.query("UPDATE approved_tv SET last_seen_at = ?, model = COALESCE(?, model) WHERE ip = ?").run(new Date(now).toISOString(), model, ip);
      this.seenWritten.set(ip, now);
    }
    let title = this.activity?.ip === ip ? this.activity.title : null;
    const m = path.match(/^\/(?:copy|live)\/(\d+)/);
    if (m) title = (db.query("SELECT v.title FROM copy c JOIN videos v ON v.id = c.video_id WHERE c.id = ?").get(Number(m[1])) as { title: string } | null)?.title ?? title;
    this.activity = { ip, model: model ?? (db.query("SELECT model FROM approved_tv WHERE ip = ?").get(ip) as { model: string | null } | null)?.model ?? null, at: now, title };
  }

  // CORS for the TV app only (tvCorsOrigin): the LG (webOS) shell runs from file:// (Origin `null`) and sends
  // X-Tuva-TV, so its requests are preflighted; Tizen skips CORS through <access origin="*">. Another site's page gets
  // no CORS headers and a 403 (tvRequestError). Access is still decided by the TV's IP.
  async fetch(req: Request, ip: string): Promise<Response> {
    const dev = !!this.deps.cfg.tvLoopback;
    const refused = tvRequestError(req, dev);
    if (refused) return new Response(JSON.stringify({ error: refused }), { status: 403, headers: { "content-type": "application/json", "cache-control": "no-store", vary: "origin" } });
    const cors = tvCorsOrigin(req.headers.get("origin"), dev);
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          vary: "origin",
          ...(cors
            ? {
                "access-control-allow-origin": "*",
                "access-control-allow-methods": "GET, HEAD, POST",
                "access-control-allow-headers": "x-tuva-tv, content-type, range",
                "access-control-max-age": "600",
              }
            : {}),
        },
      });
    }
    const res = await this.respond(req, ip);
    const set = (h: Headers) => {
      h.append("vary", "origin");
      if (!cors) return;
      h.set("access-control-allow-origin", "*");
      h.set("access-control-expose-headers", "content-length, content-range, accept-ranges");
    };
    try {
      set(res.headers);
    } catch {
      // immutable headers (a passed-through fetch Response): copy it
      const copy = new Response(res.body, res);
      set(copy.headers);
      return copy;
    }
    return res;
  }

  private async respond(req: Request, ip: string): Promise<Response> {
    const path = new URL(req.url).pathname;
    const route = matchTvRoute(req.method, path);
    if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store", "x-tv-route": "unlisted" } });
    if (route.kind === "health") return json({ app: TV_APP_NAME });

    const model = req.headers.get("x-tuva-tv")?.trim().slice(0, 120) || null;
    if (!this.isApproved(ip)) {
      // no prompt for this machine's own address: it could never be approved
      if (this.mayBeTv(ip) && !this.denied.has(ip)) this.pending.set(ip, model ?? this.pending.get(ip) ?? null);
      return json({ error: "approve" }, 403);
    }
    this.touch(ip, model, path);

    if (route.kind === "ui") return this.ui(path);
    if (route.kind === "live") return json({ error: "the Live remux is not built yet" }, 404);
    if (!this.handler) return json({ error: "not ready" }, 503);
    markTvRequest(req); // the localhost guard leaves it to this listener's checks; `/copy/:id` serves by the TV Playback profile (spec 3.2)
    const res = await this.handler(req);
    // §7.6: the video lists leave out Not on this machine Videos (Unmounted ones stay); no answer carries a Copy's
    // absolute file path (SEC-6).
    const list = tvListOf(req.method, path);
    if (res.ok && res.headers.get("content-type")?.includes("application/json")) {
      const raw = stripPaths(await res.json());
      const body = list ? excludeNotHere(list, raw, notHereVideoIds(this.deps.db)) : raw;
      const headers = new Headers(res.headers);
      headers.delete("content-length");
      return new Response(req.method === "HEAD" ? null : JSON.stringify(body), { status: res.status, headers });
    }
    return res; // CORS headers (which the poster-colour canvas also needs) are added by fetch()
  }

  /** The TV UI files: the bundle built at start (`TvBundle`), the olchey, and the page that loads them for a desktop browser. */
  private ui(path: string): Response {
    const noStore = { "cache-control": "no-store" };
    if ((path === "/tv.js" || path === "/tv.css") && this.bundle) return this.bundle.serve(path);
    if (path === "/tv.js") return new Response("// TuvaVideos TV UI: not built\n", { headers: { "content-type": "text/javascript; charset=utf-8", ...noStore } });
    if (path === "/tv.css") return new Response("/* TuvaVideos TV UI: not built */\n", { headers: { "content-type": "text/css; charset=utf-8", ...noStore } });
    if (path === "/olchey.svg") return new Response(Bun.file(join(this.deps.cfg.webDir, "olchey.svg")), { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=86400" } });
    // src/tv/fonts (the route allows only [a-z0-9-]+.woff2): the TV may have none of the UI's fonts (LG webOS).
    if (path.startsWith("/fonts/")) {
      const file = join(this.deps.cfg.webDir, "..", "tv", path);
      if (!existsSync(file)) return json({ error: "not found" }, 404);
      return new Response(Bun.file(file), { headers: { "content-type": "font/woff2", "cache-control": "max-age=604800" } });
    }
    // `/`: what a desktop browser opens (http://127.0.0.1:4401/) to run the UI without the shell. On the TV the shell
    // loads /tv.css and /tv.js itself; `#boot` (the server's name and address) is removed by the UI when it starts.
    const addrs = lanAddresses().map((a) => `${a}:${this.port}`);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${TV_APP_NAME}</title><meta name="viewport" content="width=1920"><link rel="icon" href="/olchey.svg"><link rel="stylesheet" href="/tv.css"></head>
<body><div id="tv"></div><div id="boot" style="position:fixed;inset:0;display:grid;place-items:center;text-align:center;background:#1f1e1d;color:#d9d8d5;font:28px system-ui"><div><img src="/olchey.svg" width="96" height="96" alt=""><h1>${TV_APP_NAME}</h1><p>${addrs.length ? addrs.join(" · ") : "no network address"}</p></div></div><script src="/tv.js"></script></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...noStore, ...FRAME_HEADERS } });
  }
}
