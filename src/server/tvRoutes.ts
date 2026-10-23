import { UUID_PATTERN } from "../shared/ids";

// The TV Server's fixed route list (docs/tv-spec.md 2.3, ADR 0004). It is the security boundary: a request that matches
// nothing here is a 404 and never reaches the localhost handler. Data, so a test can walk it. Extend it deliberately.

export type TvRouteKind =
  | "health" // answered to anyone, by the TV Server itself
  | "api" // a localhost handler, for Approved TVs
  | "ui" // the TV app's UI files, served by the TV Server
  | "live"; // the Live remux streams (tv-live-remux)

export interface TvRoute {
  method: "GET" | "POST";
  pattern: RegExp;
  kind: TvRouteKind;
  /** A path that matches, for tests. */
  sample: string;
}

const UUID = "[0-9a-fA-F-]{8,64}";
/** A Video id (migration 0015). */
const VID = UUID_PATTERN;
const V1 = "76696400-0000-8000-8000-000000000001";

export const TV_ROUTES: readonly TvRoute[] = [
  { method: "GET", pattern: /^\/api\/health$/, kind: "health", sample: "/api/health" },
  // reads
  { method: "GET", pattern: /^\/api\/videos$/, kind: "api", sample: "/api/videos" },
  { method: "GET", pattern: new RegExp(`^/api/videos/${VID}$`), kind: "api", sample: `/api/videos/${V1}` },
  { method: "GET", pattern: new RegExp(`^/api/videos/${VID}/chapters$`), kind: "api", sample: `/api/videos/${V1}/chapters` },
  { method: "GET", pattern: new RegExp(`^/api/videos/${VID}/audio$`), kind: "api", sample: `/api/videos/${V1}/audio` },
  { method: "GET", pattern: /^\/api\/audio-presets$/, kind: "api", sample: "/api/audio-presets" },
  { method: "GET", pattern: /^\/api\/artists$/, kind: "api", sample: "/api/artists" },
  { method: "GET", pattern: /^\/api\/songs$/, kind: "api", sample: "/api/songs" },
  { method: "GET", pattern: new RegExp(`^/api/songs/${UUID}$`), kind: "api", sample: "/api/songs/00000000-0000-0000-0000-000000000000" },
  { method: "GET", pattern: /^\/api\/favorites$/, kind: "api", sample: "/api/favorites" },
  { method: "GET", pattern: /^\/api\/search$/, kind: "api", sample: "/api/search?q=a" },
  { method: "GET", pattern: /^\/api\/copies\/\d+$/, kind: "api", sample: "/api/copies/1" },
  { method: "GET", pattern: /^\/api\/copies\/\d+\/keyframes$/, kind: "api", sample: "/api/copies/1/keyframes" },
  { method: "GET", pattern: /^\/copy\/\d+$/, kind: "api", sample: "/copy/1" },
  { method: "GET", pattern: new RegExp(`^/thumbs/${VID}/(poster|strip)\\.webp$`), kind: "api", sample: `/thumbs/${V1}/poster.webp` },
  // the only writes
  { method: "POST", pattern: new RegExp(`^/api/videos/${VID}/resume$`), kind: "api", sample: `/api/videos/${V1}/resume` },
  { method: "POST", pattern: new RegExp(`^/api/videos/${VID}/view$`), kind: "api", sample: `/api/videos/${V1}/view` },
  // TV-only
  { method: "GET", pattern: /^\/$/, kind: "ui", sample: "/" },
  { method: "GET", pattern: /^\/tv\.js$/, kind: "ui", sample: "/tv.js" },
  { method: "GET", pattern: /^\/tv\.css$/, kind: "ui", sample: "/tv.css" },
  { method: "GET", pattern: /^\/olchey\.svg$/, kind: "ui", sample: "/olchey.svg" },
  { method: "GET", pattern: /^\/fonts\/[a-z0-9-]+\.woff2$/, kind: "ui", sample: "/fonts/symbols-misc.woff2" },
  { method: "GET", pattern: /^\/live\/\d+\/(index\.m3u8|seg[^/]*\.ts)$/, kind: "live", sample: "/live/1/index.m3u8" },
];

/** The route a request matches, or null (HEAD is a GET). */
export function matchTvRoute(method: string, pathname: string): TvRoute | null {
  const m = method === "HEAD" ? "GET" : method;
  return TV_ROUTES.find((r) => r.method === m && r.pattern.test(pathname)) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Not on this machine (sharing-spec §7.6): the TV Server's video lists leave out Videos with no Copy here (no Copy
// row, or every Copy Missing) and keep Unmounted ones as today. The localhost handler is unchanged; the TV Server
// filters the answers of these list routes on the way out.
// ---------------------------------------------------------------------------------------------------------------

export type TvList = "videos" | "favorites" | "search" | "song";

/** The list a TV route answers, if its answer names Videos the TV must not see. */
export function tvListOf(method: string, pathname: string): TvList | null {
  if (method !== "GET" && method !== "HEAD") return null;
  if (pathname === "/api/videos") return "videos";
  if (pathname === "/api/favorites") return "favorites";
  if (pathname === "/api/search") return "search";
  if (new RegExp(`^/api/songs/${UUID}$`).test(pathname)) return "song";
  return null;
}

/** The ids of the Videos Not on this machine: no Copy, or every Copy Missing. */
export const NOT_HERE_SQL = "SELECT v.id FROM videos v WHERE NOT EXISTS (SELECT 1 FROM copy c WHERE c.video_id = v.id AND c.missing_since IS NULL)";

export function notHereVideoIds(db: { query(sql: string): { all(): unknown[] } }): Set<string> {
  return new Set((db.query(NOT_HERE_SQL).all() as { id: string }[]).map((r) => r.id));
}

type Row = Record<string, unknown>;
const idOf = (x: unknown): string | null => (x && typeof x === "object" && typeof (x as Row).id === "string" ? ((x as Row).id as string) : null);

/** Drop the Not on this machine Videos from a list answer (pure). Unknown shapes pass through untouched. */
export function excludeNotHere(list: TvList, body: unknown, notHere: ReadonlySet<string>): unknown {
  if (!notHere.size) return body;
  const keep = (id: string | null) => id == null || !notHere.has(id);
  if (list === "videos" && Array.isArray(body)) return body.filter((v) => keep(idOf(v)));
  if (list === "favorites" && Array.isArray(body)) return body.filter((i) => keep(idOf((i as Row)?.video)));
  if (list === "song" && body && typeof body === "object" && Array.isArray((body as Row).videos)) {
    return { ...(body as Row), videos: ((body as Row).videos as unknown[]).filter((v) => keep(idOf(v))) };
  }
  if (list === "search" && body && typeof body === "object" && Array.isArray((body as Row).groups)) {
    const groups = ((body as Row).groups as Row[]).map((g) => {
      if (!Array.isArray(g.rows)) return g;
      const before = g.rows.length;
      const rows = (g.rows as Row[])
        .filter((r) => !((r.kind === "video" && !keep(r.id as string)) || (r.kind === "chapter" && !keep(r.videoId as string))))
        .map((r) => (r.kind === "song" && Array.isArray(r.videos) ? { ...r, videos: (r.videos as unknown[]).filter((v) => keep(idOf(v))) } : r));
      const total = typeof g.total === "number" ? Math.max(rows.length, g.total - (before - rows.length)) : g.total;
      return { ...g, rows, total };
    });
    return { ...(body as Row), groups };
  }
  return body;
}
