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
  { method: "GET", pattern: /^\/live\/\d+\/(index\.m3u8|seg[^/]*\.ts)$/, kind: "live", sample: "/live/1/index.m3u8" },
];

/** The route a request matches, or null (HEAD is a GET). */
export function matchTvRoute(method: string, pathname: string): TvRoute | null {
  const m = method === "HEAD" ? "GET" : method;
  return TV_ROUTES.find((r) => r.method === m && r.pattern.test(pathname)) ?? null;
}
