import { join } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { extensionOf, contentTypeFor } from "./filename";
import type { FallbackQueue } from "./fallback";
import { frameRateValue, type Playback } from "./playback";
import { rankCopies } from "./ranking";
import type { Roots } from "./roots";
import type { Studio } from "./studio/service";
import type { Scanner } from "./scan";
import { serveFile } from "./stream";
import { run } from "./proc";
import type { Thumbnails } from "./thumbs";
import type { WebBundle } from "./web";
import { listArtists, listFavoriteRows, mergeArtist, recordLoop, recordResume, recordView, resetViews, setFavorite } from "./catalog";
import { MAX_SCREENSHOT_BYTES, isPng, saveScreenshot } from "./screenshot";
import { confirmVideoArtists, createLocalArtist, patchVideo, rejectVideoArtist, renameLocalArtist, setVideoArtists } from "./edit";
import { indexArtist, rebuildSearchIndex, runSearch } from "./search";
import { addChapter, chapterDto, confirmAll, confirmChapter, deleteChapter, listChapters, patchChapter, rejectChapter, type ChapterRow } from "./chapters/store";
import { listSongs, songDto, songRef, videosPerforming } from "./songs";
import { createLocalSong, createLocalVersion, deleteLocalSong, deleteLocalVersion, patchLocalSong, patchLocalVersion } from "./localSongs";
import { deletePreset, getVideoAudio, listPresets, savePreset, setVideoAudio } from "./audio";
import type { VideoType } from "../shared/filters";
import { storedLoop, type StoredLoop } from "../shared/playerMath";
import type { ArtistRef, ChapterDto, FavoriteItem, SongDto } from "../shared/types";

export interface Services {
  cfg: Config;
  db: Db;
  roots: Roots;
  scanner: Scanner;
  fallback: FallbackQueue;
  thumbs: Thumbnails;
  studio: Studio;
  web: WebBundle;
  startedAt: number;
  /** Set by the launcher: stops the server (the power button). Absent under tests and the smoke runs. */
  quit?: () => void;
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
  title_latin_source: "archive" | "table" | "manual" | null;
  type: string;
  type_suggested: number;
  song_id: string | null;
  version_id: string | null;
  song_suggested: number;
  suggestion_source: "manual" | "comment" | "description" | "performance" | null;
  favorited_at: string | null;
  resume_s: number | null;
  last_played_at: string | null;
  view_count: number;
  loop_a_s: number | null;
  loop_b_s: number | null;
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
    /** Where the file is on disk (the Root's path joined with the Copy's path inside it). */
    path: join(s.roots.get(c.root_id)?.path ?? "", c.rel_path),
  });

  interface Extras {
    artists: ArtistRef[];
    chapterCount: number;
  }
  const NO_EXTRAS: Extras = { artists: [], chapterCount: 0 };

  const videoJson = (v: VideoDbRow, copies: CopyDbRow[], extras: Extras = NO_EXTRAS) => {
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
      titleLatinSource: v.title_latin_source,
      type: v.type as VideoType,
      typeSuggested: !!v.type_suggested,
      songId: v.song_id,
      versionId: v.version_id,
      song: songRef(s.db, v.song_id),
      songSuggested: !!v.song_suggested,
      suggestionSource: v.suggestion_source,
      favoritedAt: v.favorited_at,
      resumeS: v.resume_s,
      lastPlayedAt: v.last_played_at,
      viewCount: v.view_count,
      loop: storedLoop({ a: v.loop_a_s, b: v.loop_b_s }),
      createdAt: v.created_at,
      addedAt: ranked.reduce<string | null>((m, c) => (m == null || c.mtime > m ? c.mtime : m), null),
      chapterCount: extras.chapterCount,
      artists: extras.artists,
      availability: preferred ? preferred.root_kind : null,
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
                  frames: v.strip_frames!,
                  columns: v.strip_columns ?? 10,
                  rows: v.strip_rows ?? 1,
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

  const extrasFor = (videoIds?: number[]): Map<number, Extras> => {
    const out = new Map<number, Extras>();
    const get = (id: number) => {
      let e = out.get(id);
      if (!e) out.set(id, (e = { artists: [], chapterCount: 0 }));
      return e;
    };
    const only = videoIds ? new Set(videoIds) : null;
    for (const r of s.db
      .query("SELECT va.video_id, va.suggested, a.id, a.name, a.name_latin, a.mirror_id FROM video_artist va JOIN artist a ON a.id = va.artist_id ORDER BY va.video_id, va.suggested, va.position")
      .all() as { video_id: number; suggested: number; id: number; name: string; name_latin: string | null; mirror_id: string | null }[]) {
      if (only && !only.has(r.video_id)) continue;
      get(r.video_id).artists.push({ id: r.id, name: r.name, nameLatin: r.name_latin, local: r.mirror_id == null, suggested: !!r.suggested });
    }
    for (const r of s.db.query("SELECT video_id, COUNT(*) n FROM chapter GROUP BY video_id").all() as { video_id: number; n: number }[]) {
      if (only && !only.has(r.video_id)) continue;
      get(r.video_id).chapterCount = r.n;
    }
    return out;
  };

  const copiesByVideo = () => {
    const byVideo = new Map<number, CopyDbRow[]>();
    for (const c of s.db.query(COPY_SQL).all() as CopyDbRow[]) {
      const arr = byVideo.get(c.video_id);
      if (arr) arr.push(c);
      else byVideo.set(c.video_id, [c]);
    }
    return byVideo;
  };

  const videosByIds = (ids: number[]) => {
    const want = [...new Set(ids)];
    if (!want.length) return new Map<number, ReturnType<typeof videoJson>>();
    const q = want.map(() => "?").join(",");
    const rows = s.db.query(`SELECT * FROM video WHERE id IN (${q})`).all(...want) as VideoDbRow[];
    const copies = new Map<number, CopyDbRow[]>();
    for (const c of s.db.query(`${COPY_SQL} WHERE c.video_id IN (${q})`).all(...want) as CopyDbRow[]) {
      const arr = copies.get(c.video_id);
      if (arr) arr.push(c);
      else copies.set(c.video_id, [c]);
    }
    const ex = extrasFor(want);
    return new Map(rows.map((v) => [v.id, videoJson(v, copies.get(v.id) ?? [], ex.get(v.id))]));
  };

  const chapterJson = (c: ChapterRow): ChapterDto => chapterDto(s.db, c);

  const allVideos = () => {
    const videos = s.db.query("SELECT * FROM video ORDER BY created_at DESC, id DESC").all() as VideoDbRow[];
    const ex = extrasFor();
    const byVideo = copiesByVideo();
    return videos.map((v) => videoJson(v, byVideo.get(v.id) ?? [], ex.get(v.id)));
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

  const videoResponse = (id: number): Response => {
    const v = s.db.query("SELECT * FROM video WHERE id = ?").get(id) as VideoDbRow | null;
    if (!v) return json({ error: "no such video" }, 404);
    return json(videoJson(v, s.db.query(`${COPY_SQL} WHERE c.video_id = ?`).all(v.id) as CopyDbRow[], extrasFor([v.id]).get(v.id)));
  };

  const readJson = async (req: Request): Promise<Record<string, unknown> | null> => {
    try {
      const b = await req.json();
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  type R<T> = { ok: true; value: T } | { ok: false; status: number; error: string; refused?: boolean };
  const reply = <T>(r: R<T>) => (r.ok ? json(r.value) : json({ error: r.error, ...(r.refused ? { refused: true } : {}) }, r.status));

  /** The Studio endpoints that write or drive Music.app (spec 7). Null: not one of ours. */
  async function studioPost(req: Request, p: string): Promise<Response | null> {
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/api\/tracks\/([^/]+)\/match$/))) {
      const b = await readJson(req);
      if (!b || typeof b.persistentId !== "string" || !b.persistentId) return json({ error: "persistentId is required" }, 400);
      return reply(await s.studio.matchMirrorTrack(m[1]!, b.persistentId));
    }
    if ((m = p.match(/^\/api\/songs\/([0-9a-fA-F-]{8,64})\/studio$/))) {
      const b = await readJson(req);
      if (!b || typeof b.persistentId !== "string" || !b.persistentId) return json({ error: "persistentId is required" }, 400);
      const r = await s.studio.addLocal(m[1]!, b.persistentId);
      return r.ok ? json(r.value, 201) : reply(r);
    }
    if ((m = p.match(/^\/api\/studio-tracks\/(\d+)\/confirm$/))) return reply(s.studio.confirm(Number(m[1])));
    if (p === "/api/studio/play") {
      const b = await readJson(req);
      if (!b || typeof b.studioTrackId !== "number") return json({ error: "studioTrackId is required" }, 400);
      return reply(await s.studio.play(b.studioTrackId));
    }
    if (p === "/api/studio/pause") return reply(await s.studio.pause());
    if (p === "/api/studio/resume") return reply(await s.studio.resume());
    if (p === "/api/studio/stop") return reply(await s.studio.stop());
    if (p === "/api/studio/seek") {
      const b = await readJson(req);
      if (!b || typeof b.position !== "number") return json({ error: "position (seconds) is required" }, 400);
      return reply(await s.studio.seek(b.position));
    }
    if (p === "/api/studio/loop") {
      const b = await readJson(req);
      return json(s.studio.setLoop(!!b?.active));
    }
    return null;
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
          return json(videoJson(v, s.db.query(`${COPY_SQL} WHERE c.video_id = ?`).all(v.id) as CopyDbRow[], extrasFor([v.id]).get(v.id)));
        }
        if ((m = p.match(/^\/api\/videos\/(\d+)\/chapters$/))) {
          const list = listChapters(s.db, Number(m[1]));
          return list ? json(list) : json({ error: "no such video" }, 404);
        }
        if ((m = p.match(/^\/api\/videos\/(\d+)\/audio$/))) {
          const a = getVideoAudio(s.db, Number(m[1]));
          return a === undefined ? json({ error: "no such video" }, 404) : json({ state: a });
        }
        if (p === "/api/audio-presets") return json(listPresets(s.db));
        if (p === "/api/artists") return json(listArtists(s.db));
        if (p === "/api/songs") return json(listSongs(s.db));
        if (p === "/api/studio/state") return json(s.studio.state());
        if (p === "/api/studio/search") return json({ results: await s.studio.search(url.searchParams.get("q") ?? "") });
        if ((m = p.match(/^\/api\/songs\/([0-9a-fA-F-]{8,64})\/studio$/))) return json(await s.studio.songStudio(m[1]!));
        if ((m = p.match(/^\/api\/songs\/([0-9a-fA-F-]{8,64})$/))) {
          const song = songDto(s.db, m[1]!);
          if (!song) return json({ error: "no such song" }, 404);
          const perf = videosPerforming(s.db, song.id);
          const vids = videosByIds(perf.map((x) => x.videoId));
          const videos: SongDto["videos"] = perf.flatMap((x) => {
            const v = vids.get(x.videoId);
            return v ? [{ id: v.id, title: v.title, available: v.available, pointed: x.pointed, startS: x.startS }] : [];
          });
          // playable first, then the Videos that point at the Song, then oldest id (stable)
          videos.sort((a, b) => Number(b.available) - Number(a.available) || Number(b.pointed) - Number(a.pointed) || a.id - b.id);
          return json({ ...song, videos } satisfies SongDto);
        }
        if (p === "/api/favorites") {
          const rows = listFavoriteRows(s.db);
          const vids = videosByIds(rows.map((r) => r.video_id));
          const chapters = new Map<number, ChapterRow>();
          for (const c of s.db.query("SELECT * FROM chapter WHERE favorited_at IS NOT NULL").all() as ChapterRow[]) chapters.set(c.id, c);
          const items: FavoriteItem[] = [];
          for (const r of rows) {
            const video = vids.get(r.video_id);
            if (!video) continue;
            if (r.kind === "video") items.push({ kind: "video", favoritedAt: r.favorited_at, video });
            else items.push({ kind: "chapter", favoritedAt: r.favorited_at, video, chapter: chapterJson(chapters.get(r.chapter_id!)!) });
          }
          return json(items);
        }
        if (p === "/api/search") {
          const r = runSearch(s.db, { isRootAvailable: (id) => s.roots.isAvailable(id) }, url.searchParams.get("q") ?? "", { cap: Math.min(500, Number(url.searchParams.get("limit")) || 0) });
          return json({ needle: r.needle, groups: r.groups, ms: r.ms });
        }
        if (p === "/app.js" || p === "/app.css") return s.web.serve(p);
        if (p === "/olchey.svg") return new Response(Bun.file(join(s.cfg.webDir, "olchey.svg")), { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=86400" } });
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
        // Client routes (hand-rolled history routing, spec 9): every one serves the shell.
        if (p === "/" || p === "/index.html" || p === "/favorites" || p === "/search" || p === "/artists" || p === "/songs" || /^\/play\/\d+$/.test(p) || /^\/lyrics\/[0-9a-fA-F-]+$/.test(p))
          return new Response(Bun.file(join(s.cfg.webDir, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (req.method === "POST") {
        if ((m = p.match(/^\/api\/(videos|chapters)\/(\d+)\/favorite$/))) {
          const table = m[1] === "videos" ? "video" : "chapter";
          let want: boolean | undefined;
          try {
            const b = (await req.json()) as { favorite?: unknown };
            if (typeof b.favorite === "boolean") want = b.favorite;
          } catch {}
          const at = setFavorite(s.db, table, Number(m[2]), want);
          if (at === undefined) return json({ error: `no such ${table}` }, 404);
          return json({ id: Number(m[2]), favorite: at !== null, favoritedAt: at });
        }
        if ((m = p.match(/^\/api\/videos\/(\d+)\/chapters$/))) {
          const body = await readJson(req);
          if (!body) return json({ error: "body must be a JSON object" }, 400);
          const r = addChapter(s.db, Number(m[1]), body);
          return r.ok ? json(r.value, 201) : json({ error: r.error }, r.status);
        }
        if ((m = p.match(/^\/api\/videos\/(\d+)\/chapters\/confirm-all$/))) {
          const r = confirmAll(s.db, Number(m[1]));
          return r.ok ? json(r.value) : json({ error: r.error }, r.status);
        }
        if ((m = p.match(/^\/api\/chapters\/(\d+)\/confirm$/))) {
          const r = confirmChapter(s.db, Number(m[1]));
          return r.ok ? json(r.value) : json({ error: r.error }, r.status);
        }
        if ((m = p.match(/^\/api\/chapters\/(\d+)\/reject$/))) {
          const r = rejectChapter(s.db, Number(m[1]));
          return r.ok ? json(r.value) : json({ error: r.error }, r.status);
        }
        if ((m = p.match(/^\/api\/copies\/(\d+)\/reveal$/))) {
          // Show the Copy's file in the Finder (the State panel's path row).
          const c = s.db.query(`${COPY_SQL} WHERE c.id = ?`).get(Number(m[1])) as CopyDbRow | null;
          if (!c) return json({ error: "no such copy" }, 404);
          const r = await run("open", ["-R", copyJson(c).path], { timeout: 5000 });
          return r.code === 0 ? json({ ok: true }) : json({ error: r.err.trim() || "open -R failed" }, 500);
        }
        if (p.startsWith("/api/studio/") || p.startsWith("/api/studio-tracks/") || /^\/api\/(tracks|songs)\//.test(p)) {
          const r = await studioPost(req, p);
          if (r) return r;
        }
        if ((m = p.match(/^\/api\/videos\/(\d+)\/view$/))) {
          // One more view (spec 4.3): the Player posts it the first time playback starts on a Now playing visit.
          if (recordView(s.db, Number(m[1])) === undefined) return json({ error: "no such video" }, 404);
          return videoResponse(Number(m[1]));
        }
        if ((m = p.match(/^\/api\/videos\/(\d+)\/resume$/))) {
          let body: { resumeS?: unknown; copyId?: unknown } = {};
          try {
            body = (await req.json()) as typeof body; // sendBeacon posts a Blob; the content type does not matter here
          } catch {}
          if (typeof body.resumeS !== "number" || !Number.isFinite(body.resumeS) || body.resumeS < 0) return json({ error: "resumeS must be a number >= 0" }, 400);
          const r = recordResume(s.db, Number(m[1]), body.resumeS, typeof body.copyId === "number" ? body.copyId : null);
          if (!r) return json({ error: "no such video" }, 404);
          return json({ id: Number(m[1]), ...r });
        }
        if ((m = p.match(/^\/api\/videos\/(\d+)\/loop$/))) {
          let body: { loop?: unknown } = {};
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return json({ error: "body must be JSON" }, 400);
          }
          const l = body.loop;
          if (l !== null) {
            const ok = typeof l === "object" && l != null && typeof (l as StoredLoop).a === "number" && typeof (l as StoredLoop).b === "number" && storedLoop(l as StoredLoop) != null;
            if (!ok) return json({ error: "loop must be null or {a, b} in seconds with b later than a" }, 400);
          }
          const r = recordLoop(s.db, Number(m[1]), l as StoredLoop | null);
          if (!r) return json({ error: "no such video" }, 404);
          return json({ id: Number(m[1]), ...r });
        }
        if ((m = p.match(/^\/api\/videos\/(\d+)\/screenshot$/))) {
          const v = s.db.query("SELECT title FROM video WHERE id = ?").get(Number(m[1])) as { title: string } | null;
          if (!v) return json({ error: "no such video" }, 404);
          const t = Number(url.searchParams.get("t"));
          if (!url.searchParams.has("t") || !Number.isFinite(t) || t < 0) return json({ error: "t must be a number of seconds >= 0" }, 400);
          if (Number(req.headers.get("content-length") ?? 0) > MAX_SCREENSHOT_BYTES) return json({ error: "too large" }, 413);
          const png = new Uint8Array(await req.arrayBuffer());
          if (png.length > MAX_SCREENSHOT_BYTES) return json({ error: "too large" }, 413);
          if (!isPng(png)) return json({ error: "body is not a PNG" }, 415);
          const path = await saveScreenshot(s.cfg.screenshotDir, v.title, t, png);
          return json({ saved: path, bytes: png.length });
        }
        if ((m = p.match(/^\/api\/artists\/(\d+)\/merge-into\/(\d+)$/))) {
          const r = mergeArtist(s.db, Number(m[1]), Number(m[2]));
          if (!r.ok) return json({ error: r.error }, r.status);
          rebuildSearchIndex(s.db);
          return json({ merged: true, moved: r.moved });
        }
      }
      if (req.method === "PUT" && (m = p.match(/^\/api\/videos\/(\d+)\/audio$/))) {
        const body = (await req.json().catch(() => ({}))) as { state?: unknown };
        const r = setVideoAudio(s.db, Number(m[1]), body.state ?? null);
        return r.ok ? json({ state: r.value }) : json({ error: r.error }, r.status);
      }
      if (req.method === "PUT" && (m = p.match(/^\/api\/audio-presets\/([^/]+)$/))) {
        const body = (await req.json().catch(() => ({}))) as { eq?: unknown };
        const r = savePreset(s.db, decodeURIComponent(m[1]!), body.eq);
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/videos\/(\d+)\/view$/))) {
        if (!resetViews(s.db, Number(m[1]))) return json({ error: "no such video" }, 404);
        return videoResponse(Number(m[1]));
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/audio-presets\/([^/]+)$/))) {
        const r = deletePreset(s.db, decodeURIComponent(m[1]!));
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "PATCH" && (m = p.match(/^\/api\/artists\/(\d+)$/))) {
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = renameLocalArtist(s.db, Number(m[1]), body.name);
        if (!r.ok) return json({ error: r.error }, r.status);
        indexArtist(s.db, r.value.id);
        return json(r.value);
      }
      if (req.method === "PATCH" && (m = p.match(/^\/api\/videos\/(\d+)$/))) {
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = patchVideo(s.db, Number(m[1]), body);
        if (!r.ok) return json({ error: r.error }, r.status);
        return videoResponse(Number(m[1]));
      }
      if (req.method === "PATCH" && (m = p.match(/^\/api\/chapters\/(\d+)$/))) {
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = patchChapter(s.db, Number(m[1]), body);
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/studio-tracks\/(\d+)$/))) {
        const r = s.studio.remove(Number(m[1]));
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/chapters\/(\d+)$/))) {
        const r = deleteChapter(s.db, Number(m[1]));
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "POST" && (m = p.match(/^\/api\/videos\/(\d+)\/artists\/confirm$/))) {
        const r = confirmVideoArtists(s.db, Number(m[1]));
        if (!r.ok) return json({ error: r.error }, r.status);
        return videoResponse(Number(m[1]));
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/videos\/(\d+)\/artists\/(\d+)$/))) {
        const r = rejectVideoArtist(s.db, Number(m[1]), Number(m[2]));
        if (!r.ok) return json({ error: r.error }, r.status);
        return videoResponse(Number(m[1]));
      }
      if (req.method === "PUT" && (m = p.match(/^\/api\/videos\/(\d+)\/artists$/))) {
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = setVideoArtists(s.db, Number(m[1]), body.artistIds);
        if (!r.ok) return json({ error: r.error }, r.status);
        return videoResponse(Number(m[1]));
      }
      // Local Songs and Local Versions (the lyrics drawer's editor and the Song picker's "add as local song").
      if (req.method === "POST" && p === "/api/songs") {
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = createLocalSong(s.db, body);
        return r.ok ? json(r.value, r.value.created ? 201 : 200) : json({ error: r.error }, r.status);
      }
      if (req.method === "PATCH" && (m = p.match(/^\/api\/songs\/([0-9a-fA-F-]{8,64})$/))) {
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = patchLocalSong(s.db, m[1]!, body);
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/songs\/([0-9a-fA-F-]{8,64})$/))) {
        const r = deleteLocalSong(s.db, m[1]!);
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "POST" && (m = p.match(/^\/api\/songs\/([0-9a-fA-F-]{8,64})\/versions$/))) {
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = createLocalVersion(s.db, m[1]!, body);
        return r.ok ? json(r.value, 201) : json({ error: r.error }, r.status);
      }
      if (req.method === "PATCH" && (m = p.match(/^\/api\/versions\/([0-9a-fA-F-]{8,64})$/))) {
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = patchLocalVersion(s.db, m[1]!, body);
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/versions\/([0-9a-fA-F-]{8,64})$/))) {
        const r = deleteLocalVersion(s.db, m[1]!);
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "POST" && p === "/api/artists") {
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = createLocalArtist(s.db, body.name);
        if (!r.ok) return json({ error: r.error }, r.status);
        if (r.value.created) indexArtist(s.db, r.value.id);
        return json({ id: r.value.id, name: r.value.name, local: true, created: r.value.created }, r.value.created ? 201 : 200);
      }
      if (req.method === "POST" && p === "/api/rescan") {
        const queued = await s.scanner.requestAll();
        return json({ queued }, 202);
      }
      if (req.method === "POST" && p === "/api/quit") {
        if (!s.quit) return json({ error: "this server cannot quit itself" }, 409);
        setTimeout(s.quit, 200); // after the reply has left
        return json({ quitting: true }, 202);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String((e as Error).message ?? e) }, 500);
    }
  };
}

