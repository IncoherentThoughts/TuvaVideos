// The home index (docs/home-server-spec.md §5.1, §5.2): what the Home Server's Library Server tells an Approved Mac
// about its Videos, how the Mac matches them to its own, and the address rule of the Home Server field (§4.1). Pure.
import type { VideoType } from "./filters";

/** One Copy on the Home Server, as `GET /api/home/index` lists it. */
export interface HomeIndexCopy {
  /** The Copy's id on the Home Server (its `/copy/:id`). */
  id: number;
  size: number;
  /** Where the file is inside its Root there (`copy.rel_path`): a Download puts it at the same place in this Mac's Root (§8). */
  relPath?: string | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  durationS: number | null;
  /** Its Root is mounted there (false while the server's drive is unplugged: §2.2). */
  available: boolean;
  /** The **browser** Playback profile's decision for this Copy, on the Home Server. */
  playback: "native" | "remux" | "transcode";
}

export interface HomeIndexChapter {
  startS: number;
  title: string;
  titleLatin: string | null;
}

/** One Video on the Home Server: its identity, its Copies, and the facts a Mac that does not know it shows. */
export interface HomeIndexVideo {
  id: string;
  youtubeId: string | null;
  contentHash: string | null;
  /** The Video is in the Shared data on the Home Server. */
  shared: boolean;
  title: string;
  titleLatin: string | null;
  type: VideoType;
  createdAt: string;
  /** The poster's cache key on the Home Server (its `/thumbs/:id/poster.webp?v=`), or null with no Thumbnail. */
  thumb: string | null;
  chapters: HomeIndexChapter[];
  copies: HomeIndexCopy[];
}

/** `GET /api/home/index` on the Library Server, for Approved Macs only. */
export interface HomeIndexDto {
  /** The Home Server's computer name. */
  server: string;
  videos: HomeIndexVideo[];
}

/** A Video's identity: `id` (every Shared Video), else `youtube_id`, else `content_hash` (§5.1). */
export interface Identity {
  id: string;
  youtubeId: string | null;
  contentHash: string | null;
}

/**
 * §5.1 matching, per Home Server Video: the same `id`, else the same `youtube_id`, else the same `content_hash`.
 * Answers the Mac's Video id for each matched Home Server Video id; the ones left out go to `home_video`.
 * A Mac Video is taken by at most one Home Server Video (an `id` match wins over a later identity match).
 */
export function matchHome(local: readonly Identity[], remote: readonly Identity[]): Map<string, string> {
  const byId = new Map(local.map((l) => [l.id, l.id]));
  const byYt = new Map<string, string>();
  const byHash = new Map<string, string>();
  for (const l of local) {
    if (l.youtubeId) byYt.set(l.youtubeId, l.id);
    if (l.contentHash) byHash.set(l.contentHash, l.id);
  }
  const out = new Map<string, string>();
  const taken = new Set<string>();
  // ids first, so a Shared Video keeps its own twin even when another Home Server Video shares its youtube_id
  for (const r of remote) {
    if (byId.has(r.id)) {
      out.set(r.id, r.id);
      taken.add(r.id);
    }
  }
  for (const r of remote) {
    if (out.has(r.id)) continue;
    const hit = (r.youtubeId && byYt.get(r.youtubeId)) || (r.contentHash && byHash.get(r.contentHash)) || null;
    if (hit && !taken.has(hit)) {
      out.set(r.id, hit);
      taken.add(hit);
    }
  }
  return out;
}

/**
 * The Home Server field (§4.1) as a base URL: a Tailscale name or address (`mac-mini`, `100.101.1.2`,
 * `mac-mini.tailnet.ts.net:4401`, `[fd7a::1]`), the Library Server port when none is given. Null when empty or not
 * an address (spaces, a path).
 */
export function homeBase(address: string, defaultPort: number): string | null {
  let a = address.trim().replace(/\/+$/, "");
  if (!a) return null;
  let scheme = "http";
  const m = a.match(/^(https?):\/\/(.*)$/i);
  if (m) {
    scheme = m[1]!.toLowerCase();
    a = m[2]!;
  }
  if (/[\s/?#@]/.test(a)) return null;
  const v6 = a.match(/^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/);
  if (v6) return `${scheme}://[${v6[1]}]:${v6[2] ?? defaultPort}`;
  if (/^[0-9a-fA-F:]+$/.test(a) && a.split(":").length > 2) return `${scheme}://[${a}]:${defaultPort}`; // a bare IPv6 address
  const hp = a.match(/^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/);
  if (!hp || hp[1]!.startsWith(".") || hp[1]!.startsWith("-")) return null;
  return `${scheme}://${hp[1]!.toLowerCase()}:${hp[2] ?? defaultPort}`;
}

/** The top bar's words for the connection (§4.1): "Home · mac-mini", "Home · unreachable"; null when none is set. */
export function homeLabel(s: { configured: boolean; self: boolean; connected: boolean; server: string | null; address: string | null }): string | null {
  if (s.self) return "Home Server · this Mac";
  if (!s.configured) return null;
  return s.connected ? `Home · ${s.server ?? s.address ?? "connected"}` : "Home · unreachable";
}

/** §5.1: the index is fetched again on window focus once it is older than this. */
export const HOME_INDEX_STALE_MS = 10 * 60_000;
/** §4.1: health is checked again on focus once the last check is older than this. */
export const HOME_HEALTH_STALE_MS = 60_000;
