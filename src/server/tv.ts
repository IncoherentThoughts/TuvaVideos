// The TV Server (docs/tv-spec.md 2, ADR 0004): a second `Bun.serve` in this process on all IPv4 interfaces, started
// and stopped from the browser's TV button, off at every launch. Every request is checked against the Approved TVs by
// source IP; the routes are a fixed list (tvRoutes.ts) that reuses the localhost handler.
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { log } from "./log";
import { excludeNotHere, matchTvRoute, notHereVideoIds, tvListOf } from "./tvRoutes";
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

  constructor(private deps: { cfg: Pick<Config, "tvPort" | "passive" | "webDir">; db: Db }) {}

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
    return ip !== "" && this.deps.db.query("SELECT 1 FROM approved_tv WHERE ip = ?").get(ip) != null;
  }

  approve(ip: string): boolean {
    ip = normalizeIp(ip.trim());
    if (!ip) return false;
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

  // CORS for every TV route: the LG (webOS) shell runs from file:// and sends X-Tuva-TV, so its requests are
  // preflighted; Tizen skips CORS through <access origin="*">. Access is still decided by the TV's IP.
  async fetch(req: Request, ip: string): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
          "access-control-allow-headers": req.headers.get("access-control-request-headers") || "x-tuva-tv, content-type, range",
          "access-control-max-age": "600",
        },
      });
    }
    const res = await this.respond(req, ip);
    try {
      res.headers.set("access-control-allow-origin", "*");
      res.headers.set("access-control-expose-headers", "content-length, content-range, accept-ranges");
    } catch {
      // immutable headers (a passed-through fetch Response): copy it
      const copy = new Response(res.body, res);
      copy.headers.set("access-control-allow-origin", "*");
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
      if (ip && !this.denied.has(ip)) this.pending.set(ip, model ?? this.pending.get(ip) ?? null);
      return json({ error: "approve" }, 403);
    }
    this.touch(ip, model, path);

    if (route.kind === "ui") return this.ui(path);
    if (route.kind === "live") return json({ error: "the Live remux is not built yet" }, 404);
    if (!this.handler) return json({ error: "not ready" }, 503);
    const res = await this.handler(req);
    // §7.6: the video lists leave out Not on this machine Videos (Unmounted ones stay).
    const list = tvListOf(req.method, path);
    if (list && res.ok && res.headers.get("content-type")?.includes("application/json")) {
      const body = excludeNotHere(list, await res.json(), notHereVideoIds(this.deps.db));
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
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...noStore } });
  }
}
