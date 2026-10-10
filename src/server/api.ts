import { join } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { extensionOf, contentTypeFor } from "./filename";
import type { FallbackQueue } from "./fallback";
import { frameRateValue, type Playback } from "./playback";
import { rankCopies } from "./ranking";
import type { Roots } from "./roots";
import type { Scanner } from "./scan";
import { serveFile } from "./stream";
import type { Thumbnails } from "./thumbs";

export interface Services {
  cfg: Config;
  db: Db;
  roots: Roots;
  scanner: Scanner;
  fallback: FallbackQueue;
  thumbs: Thumbnails;
  startedAt: number;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

interface CopyDbRow {
  id: number;
  video_id: number;
  root_id: number;
  root_kind: "local" | "external";
  rel_path: string;
  size: number;
  mtime: string;
  duration_s: number | null;
  container: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  r_frame_rate: string | null;
  playback: Playback;
  fallback_file: string | null;
  missing_since: string | null;
}

interface VideoDbRow {
  id: number;
  youtube_id: string | null;
  title: string;
  title_latin: string | null;
  type: string;
  favorited_at: string | null;
  resume_s: number | null;
  last_played_at: string | null;
  created_at: string;
  thumbnail_generated_at: string | null;
  thumbnail_copy_id: number | null;
  strip_frames: number | null;
  strip_columns: number | null;
  strip_rows: number | null;
  strip_frame_w: number | null;
  strip_frame_h: number | null;
}

const COPY_SQL = `SELECT c.id, c.video_id, c.root_id, r.kind AS root_kind, c.rel_path, c.size, c.mtime, c.duration_s, c.container,
  c.video_codec, c.audio_codec, c.width, c.height, c.r_frame_rate, c.playback, c.fallback_file, c.missing_since
  FROM copy c JOIN root r ON r.id = c.root_id`;

export function createHandler(s: Services) {
  const copyJson = (c: CopyDbRow) => ({
    id: c.id,
    rootId: c.root_id,
    rootKind: c.root_kind,
    relPath: c.rel_path,
    size: c.size,
    mtime: c.mtime,
    durationS: c.duration_s,
    container: c.container,
    videoCodec: c.video_codec,
    audioCodec: c.audio_codec,
    width: c.width,
    height: c.height,
    rFrameRate: c.r_frame_rate,
    frameRate: frameRateValue(c.r_frame_rate),
    playback: c.playback,
    fallback: s.fallback.status(c.id),
    missing: !!c.missing_since,
    missingSince: c.missing_since,
    available: !c.missing_since && s.roots.isAvailable(c.root_id),
    url: `/copy/${c.id}`,
  });

  const videoJson = (v: VideoDbRow, copies: CopyDbRow[]) => {
    const ranked = rankCopies(copies.map((c) => ({ ...c, rootKind: c.root_kind, width: c.width, height: c.height })));
    const availableRanked = ranked.filter((c) => !c.missing_since && s.roots.isAvailable(c.root_id));
    const preferred = availableRanked[0] ?? null;
    const durationS = (preferred ?? ranked[0])?.duration_s ?? null;
    const hasStrip = !!v.strip_frames && v.strip_frames > 0;
    return {
      id: v.id,
      youtubeId: v.youtube_id,
      title: v.title,
      titleLatin: v.title_latin,
      type: v.type,
      favoritedAt: v.favorited_at,
      resumeS: v.resume_s,
      lastPlayedAt: v.last_played_at,
      createdAt: v.created_at,
      durationS,
      available: !!preferred,
      preferredCopyId: preferred?.id ?? null,
      width: (preferred ?? ranked[0])?.width ?? null,
      height: (preferred ?? ranked[0])?.height ?? null,
      thumbnail: v.thumbnail_generated_at
        ? {
            generatedAt: v.thumbnail_generated_at,
            copyId: v.thumbnail_copy_id,
            poster: `/thumbs/${v.id}/poster.webp`,
            strip: hasStrip
              ? {
                  url: `/thumbs/${v.id}/strip.webp`,
                  frames: v.strip_frames,
                  columns: v.strip_columns,
                  rows: v.strip_rows,
                  frameWidth: v.strip_frame_w,
                  frameHeight: v.strip_frame_h,
                  intervalS: durationS && v.strip_frames ? durationS / v.strip_frames : null,
                }
              : null,
          }
        : null,
      copies: ranked.map(copyJson),
    };
  };

  const allVideos = () => {
    const videos = s.db.query("SELECT * FROM video ORDER BY created_at DESC, id DESC").all() as VideoDbRow[];
    const byVideo = new Map<number, CopyDbRow[]>();
    for (const c of s.db.query(COPY_SQL).all() as CopyDbRow[]) {
      const arr = byVideo.get(c.video_id);
      if (arr) arr.push(c);
      else byVideo.set(c.video_id, [c]);
    }
    return videos.map((v) => videoJson(v, byVideo.get(v.id) ?? []));
  };

  const health = () => {
    const n = (sql: string) => (s.db.query(sql).get() as { n: number }).n;
    const videos = allVideos();
    return {
      app: "TuvaVideos",
      ok: true,
      uptimeS: Math.round((Date.now() - s.startedAt) / 1000),
      videos: videos.length,
      availableVideos: videos.filter((v) => v.available).length,
      copies: n("SELECT COUNT(*) n FROM copy"),
      missingCopies: n("SELECT COUNT(*) n FROM copy WHERE missing_since IS NOT NULL"),
      thumbnails: n("SELECT COUNT(*) n FROM video WHERE thumbnail_generated_at IS NOT NULL"),
      roots: s.roots.list().map((r) => ({ id: r.id, kind: r.kind, available: s.roots.isAvailable(r.id) })),
      scan: s.scanner.progress(),
      thumbWork: s.thumbs.stats,
    };
  };

  async function copyRoute(req: Request, id: number): Promise<Response> {
    const c = s.db.query(`${COPY_SQL.replace("c.fallback_file, c.missing_since", "c.fallback_file, c.missing_since, r.path AS root_path")} WHERE c.id = ?`).get(id) as (CopyDbRow & { root_path: string }) | null;
    if (!c) return json({ error: "no such copy" }, 404);
    if (c.missing_since) return json({ error: "copy is missing", missingSince: c.missing_since }, 404);
    if (c.playback !== "native") {
      if (!c.fallback_file) {
        const st = s.fallback.request(id, "play");
        return json({ state: st.state, progress: st.progress, error: st.error }, 503, { "retry-after": "2" });
      }
      return serveFile(req, join(s.cfg.remuxDir, c.fallback_file), contentTypeFor(extensionOf(c.fallback_file)));
    }
    return serveFile(req, join(c.root_path, c.rel_path));
  }

  async function thumbRoute(req: Request, videoId: number, which: "poster" | "strip"): Promise<Response> {
    const path = which === "poster" ? s.thumbs.posterPath(videoId) : s.thumbs.stripPath(videoId);
    const res = await serveFile(req, path, "image/webp");
    if (res.status === 200 || res.status === 206) res.headers.set("cache-control", "public, max-age=86400");
    return res;
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname;
    let m: RegExpMatchArray | null;
    try {
      if (req.method === "GET" || req.method === "HEAD") {
        if ((m = p.match(/^\/copy\/(\d+)$/))) return copyRoute(req, Number(m[1]));
        if ((m = p.match(/^\/thumbs\/(\d+)\/(poster|strip)\.webp$/))) return thumbRoute(req, Number(m[1]), m[2] as "poster" | "strip");
        if (p === "/api/health") return json(health());
        if (p === "/api/videos") return json(allVideos());
        if ((m = p.match(/^\/api\/videos\/(\d+)$/))) {
          const v = s.db.query("SELECT * FROM video WHERE id = ?").get(Number(m[1])) as VideoDbRow | null;
          if (!v) return json({ error: "no such video" }, 404);
          return json(videoJson(v, s.db.query(`${COPY_SQL} WHERE c.video_id = ?`).all(v.id) as CopyDbRow[]));
        }
        if ((m = p.match(/^\/api\/copies\/(\d+)$/))) {
          const c = s.db.query(`${COPY_SQL} WHERE c.id = ?`).get(Number(m[1])) as CopyDbRow | null;
          return c ? json(copyJson(c)) : json({ error: "no such copy" }, 404);
        }
        if (p === "/api/roots") {
          return json(
            s.roots.list().map((r) => ({
              ...r,
              available: s.roots.isAvailable(r.id),
              copies: (s.db.query("SELECT COUNT(*) n FROM copy WHERE root_id = ?").get(r.id) as { n: number }).n,
              missingCopies: (s.db.query("SELECT COUNT(*) n FROM copy WHERE root_id = ? AND missing_since IS NOT NULL").get(r.id) as { n: number }).n,
            })),
          );
        }
        if (p === "/api/scan") return json(s.scanner.progress());
        if (p === "/" || p === "/index.html") return new Response(Bun.file(join(s.cfg.webDir, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (req.method === "POST" && p === "/api/rescan") {
        const queued = await s.scanner.requestAll();
        return json({ queued }, 202);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String((e as Error).message ?? e) }, 500);
    }
  };
}

