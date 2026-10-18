import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import { extensionOf, contentTypeFor } from "./filename";
import type { FallbackQueue } from "./fallback";
import { frameRateValue, type Playback } from "./playback";
import { rankCopies } from "./ranking";
import type { Roots } from "./roots";
import type { Studio } from "./studio/service";
import type { Scanner } from "./scan";
import type { TvServer } from "./tv";
import { factsOfRow, parseDecision } from "./tvJudge";
import { decideTvPlayback, fallbackFacts, TV_PROFILE, tvOrder } from "../shared/playbackProfile";
import { deleteVideo, removeCopies } from "./deleteVideo";
import { deletedMatches, kindsOf, sharedSuggestions } from "./sharedWrites";
import { clearShelved, dropShelved, listEdits, shelvedItems, videoHistory } from "./editHistory";
import { serveFile } from "./stream";
import type { KeyframeIndex } from "./keyframes";
import { NO_TRASH_NOTICE, resolveTrash } from "./platform";
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
import { relocateCopy } from "./relocate";
import { deletePreset, getVideoAudio, listPresets, savePreset, setVideoAudio } from "./audio";
import type { VideoType } from "../shared/filters";
import { storedLoop, type StoredLoop } from "../shared/playerMath";
import type { ArtistRef, ChapterDto, FavoriteItem, SongDto, TvCopyDto } from "../shared/types";
import type { SharedChanges } from "../shared/sharedRows";
import { applyShared } from "./localCopy/apply";
import { hostError, localRequestError } from "./localOnly";
import { createReconcile } from "./reconcile";
import { createSync } from "./sync";
import { pendingShareBatch, pendingShareSummary, setShareAuto } from "./share";
import { posterUploadCandidates } from "./posters";
import { looksLikeJwt } from "../shared/archive";
import type { SessionResponse } from "../shared/session";
import { checkRootPath, onboardingFor, ROOT_BAR_DISMISSED } from "./rootSetup";
import { clearSessionRecord, getMeta, machineMode, readSessionRecord, setMeta } from "./localCopy/meta";
import type { OnboardingDto } from "../shared/types";
import { homedir } from "node:os";

const THUMB_CACHE = "public, max-age=86400";
/** The top-level keys of a `POST /api/cache/apply` body: `SharedChanges` (a write's return or a pull's). */
const CACHE_APPLY_KEYS = new Set<string>(["tables", "replace_whole", "tombstones", "archive_ids", "watermark", "since", "server_time", "shared_schema"] satisfies (keyof SharedChanges)[]);
/** `/thumbs/<id>/<which>.webp?v=<generatedAt>`: the query string is the cache key (the route matches the path alone). */
export const thumbUrl = (videoId: string, which: "poster" | "strip", generatedAt: string) => `/thumbs/${videoId}/${which}.webp?v=${encodeURIComponent(generatedAt)}`;

/** What a theme folder may serve (docs/themes.md), by extension. */
const THEME_FILE_TYPES: Record<string, string> = { css: "text/css; charset=utf-8", json: "application/json", webp: "image/webp", png: "image/png", svg: "image/svg+xml", woff2: "font/woff2" };

export interface Services {
  cfg: Config;
  db: Db;
  roots: Roots;
  scanner: Scanner;
  fallback: FallbackQueue;
  thumbs: Thumbnails;
  keyframes: KeyframeIndex;
  studio: Studio;
  web: WebBundle;
  /** The second listener for the TV (docs/tv-spec.md 2): off until the TV button turns it on. */
  tv: TvServer;
  startedAt: number;
  /** Set by the launcher: stops the server (the power button). Absent under tests and the smoke runs. */
  quit?: () => void;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

interface CopyDbRow {
  id: number;
  video_id: string;
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
  tv_playback: string | null;
}

/** A `video_full` row (migration 0015): the Shared columns, one effective pointer per pair, this machine's columns. */
interface VideoDbRow {
  id: string;
  youtube_id: string | null;
  instagram_id: string | null;
  rutube_id: string | null;
  shared: number;
  updated_at: string;
  title: string;
  title_latin: string | null;
  title_latin_source: "archive" | "table" | "manual" | null;
  type: string;
  type_suggested: number;
  song_id: string | null;
  version_id: string | null;
  song_suggested: number;
  suggestion_source: "manual" | "comment" | "description" | "performance" | "title" | null;
  favorited_at: string | null;
  resume_s: number | null;
  last_played_at: string | null;
  view_count: number;
  loop_a_s: number | null;
  loop_b_s: number | null;
  created_at: string;
  thumbnail_generated_at: string | null;
  poster_hash: string | null;
  thumbnail_copy_id: number | null;
  strip_frames: number | null;
  strip_columns: number | null;
  strip_rows: number | null;
  strip_frame_w: number | null;
  strip_frame_h: number | null;
}

const COPY_SQL = `SELECT c.id, c.video_id, c.root_id, r.kind AS root_kind, c.rel_path, c.size, c.mtime, c.duration_s, c.container,
  c.video_codec, c.audio_codec, c.width, c.height, c.r_frame_rate, c.playback, c.fallback_file, c.missing_since, c.tv_playback
  FROM copy c JOIN root r ON r.id = c.root_id`;

export function createHandler(s: Services) {
  const sync = createSync(s.db, s.cfg.archive, { cacheDir: s.cfg.ytCacheDir, thumbsDir: s.cfg.thumbsDir });
  const reconcile = createReconcile(s.db, s.cfg.archive, { thumbsDir: s.cfg.thumbsDir });
  const tvJson = (c: CopyDbRow): TvCopyDto => {
    const decision = parseDecision(c.tv_playback);
    const fb = c.fallback_file ? decideTvPlayback(fallbackFacts(factsOfRow(c), c.playback, c.fallback_file), TV_PROFILE) : null;
    return { decision, order: tvOrder(decision, fb) };
  };

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
    /** The TV Playback profile's decision for this Copy and which source the TV plays (tv-spec 3.1, 3.2). */
    tv: tvJson(c),
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
      instagramId: v.instagram_id,
      rutubeId: v.rutube_id,
      shared: !!v.shared,
      updatedAt: v.updated_at,
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
      // `?v=` is the generation time: the files are served with a day-long cache, so a regenerated Thumbnail needs a
      // new URL (before migration 0015 integer ids were also reused after a delete).
      // A downloaded Shared poster (§6.5) counts before any local Thumbnail exists, and its hash is its cache key.
      thumbnail: v.thumbnail_generated_at || v.poster_hash
        ? {
            generatedAt: v.thumbnail_generated_at ?? v.poster_hash!,
            copyId: v.thumbnail_copy_id,
            poster: thumbUrl(v.id, "poster", v.poster_hash ?? v.thumbnail_generated_at!),
            strip: hasStrip
              ? {
                  url: thumbUrl(v.id, "strip", v.thumbnail_generated_at ?? ""),
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

  const extrasFor = (videoIds?: string[]): Map<string, Extras> => {
    const out = new Map<string, Extras>();
    const get = (id: string) => {
      let e = out.get(id);
      if (!e) out.set(id, (e = { artists: [], chapterCount: 0 }));
      return e;
    };
    const only = videoIds ? new Set(videoIds) : null;
    for (const r of s.db
      .query("SELECT va.link_id, va.video_id, va.suggested, a.id, a.name, a.name_latin, a.kind FROM video_artist_full va JOIN artist_all a ON a.id = va.artist_id ORDER BY va.video_id, va.suggested, va.position")
      .all() as { link_id: string; video_id: string; suggested: number; id: string; name: string; name_latin: string | null; kind: string }[]) {
      if (only && !only.has(r.video_id)) continue;
      get(r.video_id).artists.push({ id: r.id, name: r.name, nameLatin: r.name_latin, local: r.kind === "local", proposed: r.kind === "proposed", suggested: !!r.suggested, linkId: r.link_id });
    }
    for (const r of s.db.query("SELECT video_id, COUNT(*) n FROM chapter_full GROUP BY video_id").all() as { video_id: string; n: number }[]) {
      if (only && !only.has(r.video_id)) continue;
      get(r.video_id).chapterCount = r.n;
    }
    return out;
  };

  const copiesByVideo = () => {
    const byVideo = new Map<string, CopyDbRow[]>();
    for (const c of s.db.query(COPY_SQL).all() as CopyDbRow[]) {
      const arr = byVideo.get(c.video_id);
      if (arr) arr.push(c);
      else byVideo.set(c.video_id, [c]);
    }
    return byVideo;
  };

  const videosByIds = (ids: string[]) => {
    const want = [...new Set(ids)];
    if (!want.length) return new Map<string, ReturnType<typeof videoJson>>();
    const q = want.map(() => "?").join(",");
    const rows = s.db.query(`SELECT * FROM video_full WHERE id IN (${q})`).all(...want) as VideoDbRow[];
    const copies = new Map<string, CopyDbRow[]>();
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
    const videos = s.db.query("SELECT * FROM video_full ORDER BY created_at DESC, id DESC").all() as VideoDbRow[];
    const ex = extrasFor();
    const byVideo = copiesByVideo();
    return videos.map((v) => videoJson(v, byVideo.get(v.id) ?? [], ex.get(v.id)));
  };

  const trashInfo = () => {
    const t = resolveTrash(s.cfg.trash);
    return t ? { available: true, command: t.label } : { available: false, notice: NO_TRASH_NOTICE };
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
      thumbnails: n("SELECT COUNT(*) n FROM video_full WHERE thumbnail_generated_at IS NOT NULL"),
      roots: s.roots.list().map((r) => ({ id: r.id, kind: r.kind, available: s.roots.isAvailable(r.id) })),
      scan: s.scanner.progress(),
      thumbWork: s.thumbs.stats,
      // Sharing-spec §8.2: with no trash command, deleting offers only the entry-only delete, with this notice.
      trash: trashInfo(),
    };
  };

  // Which first-launch surface the Library shows, from the Session record and the `root` table (sharing-spec §8.4).
  const onboardingState = (): OnboardingDto => {
    const mode = machineMode(readSessionRecord(s.db));
    const rootCount = s.roots.list().length;
    return { mode, rootCount, show: onboardingFor({ mode, rootCount, barDismissed: getMeta(s.db, ROOT_BAR_DISMISSED) != null }) };
  };

  // The Copy's audio track as raw PCM (s16le, stereo, 32 kHz) for the Audio panel's whole-file Auto analysis (spec 4.7).
  // ffmpeg demuxes the whole file but decodes only audio; the stream is killed when the client goes away.
  const PCM_RATE = 32000;
  function pcmRoute(req: Request, id: number): Response {
    const c = s.db.query(`${COPY_SQL.replace("c.fallback_file, c.missing_since", "c.fallback_file, c.missing_since, r.path AS root_path")} WHERE c.id = ?`).get(id) as (CopyDbRow & { root_path: string }) | null;
    if (!c) return json({ error: "no such copy" }, 404);
    if (c.missing_since) return json({ error: "copy is missing" }, 404);
    const path = join(c.root_path, c.rel_path);
    const proc = Bun.spawn([s.cfg.ffmpeg, "-v", "error", "-nostdin", "-i", path, "-vn", "-ac", "2", "-ar", String(PCM_RATE), "-f", "s16le", "-"], { stdout: "pipe", stderr: "ignore" });
    req.signal.addEventListener("abort", () => proc.kill());
    return new Response(proc.stdout, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-sample-rate": String(PCM_RATE), "x-channels": "2" } });
  }

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

  /** A poster or strip: the URL carries `?v=<generatedAt>`, so the file may be cached for a day; `Last-Modified` lets a stale entry revalidate. */
  async function thumbRoute(req: Request, videoId: string, which: "poster" | "strip"): Promise<Response> {
    const path = which === "poster" ? s.thumbs.posterPath(videoId) : s.thumbs.stripPath(videoId);
    let mtime: Date | null = null;
    try {
      mtime = (await stat(path)).mtime;
    } catch {}
    const lastModified = mtime ? new Date(Math.floor(mtime.getTime() / 1000) * 1000).toUTCString() : null;
    const since = req.headers.get("if-modified-since");
    if (lastModified && since && Date.parse(since) >= Date.parse(lastModified)) {
      return new Response(null, { status: 304, headers: { "last-modified": lastModified, "cache-control": THUMB_CACHE } });
    }
    const res = await serveFile(req, path, "image/webp");
    if (res.status === 200 || res.status === 206) {
      res.headers.set("cache-control", THUMB_CACHE);
      if (lastModified) res.headers.set("last-modified", lastModified);
    }
    return res;
  }

  const videoResponse = (id: string): Response => {
    const v = s.db.query("SELECT * FROM video_full WHERE id = ?").get(id) as VideoDbRow | null;
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
        if ((m = p.match(/^\/copy\/(\d+)\/pcm$/))) return pcmRoute(req, Number(m[1]));
        if ((m = p.match(/^\/thumbs\/([0-9a-fA-F-]{36})\/(poster|strip)\.webp$/))) return thumbRoute(req, m[1]!, m[2] as "poster" | "strip");
        if (p === "/api/health") return json(health());
        if (p === "/api/tv") return json(s.tv.state());
        if (p === "/api/videos") return json(allVideos());
        // The client write seam's reads (sharing-spec §4.3, §4.5, §4.9; src/server/sharedWrites.ts).
        if (p === "/api/kinds") return json(kindsOf(s.db, url.searchParams));
        if (p === "/api/videos/deleted-matches") return json(deletedMatches(s.db, s.roots));
        if (p === "/api/suggestions/shared") return json(machineMode(readSessionRecord(s.db)) === "editor" ? sharedSuggestions(s.db) : []);
        // Edit history and Shelved edits (sharing-spec §4.7, §4.8, §7.4; src/server/editHistory.ts).
        if ((m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/history$/))) return json(videoHistory(s.db, m[1]!));
        if (p === "/api/edits") {
          const q = url.searchParams;
          return json(listEdits(s.db, { editor: q.get("editor"), type: q.get("type"), before: q.get("before"), limit: q.get("limit") ? Number(q.get("limit")) || undefined : undefined }));
        }
        if (p === "/api/shelved") return json(shelvedItems(s.db, url.searchParams.get("video") ?? undefined));
        if ((m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})$/))) {
          const v = s.db.query("SELECT * FROM video_full WHERE id = ?").get(m[1]!) as VideoDbRow | null;
          if (!v) return json({ error: "no such video" }, 404);
          return json(videoJson(v, s.db.query(`${COPY_SQL} WHERE c.video_id = ?`).all(v.id) as CopyDbRow[], extrasFor([v.id]).get(v.id)));
        }
        if ((m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/chapters$/))) {
          const list = listChapters(s.db, m[1]!);
          return list ? json(list) : json({ error: "no such video" }, 404);
        }
        if ((m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/audio$/))) {
          const a = getVideoAudio(s.db, m[1]!);
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
          const perf = videosPerforming(s.db, song.id); // oldest first
          const vids = videosByIds(perf.map((x) => x.videoId));
          const videos: (SongDto["videos"][number] & { order: number })[] = perf.flatMap((x, order) => {
            const v = vids.get(x.videoId);
            return v ? [{ id: v.id, title: v.title, available: v.available, pointed: x.pointed, startS: x.startS, order }] : [];
          });
          // playable first, then the Videos that point at the Song, then oldest (stable)
          videos.sort((a, b) => Number(b.available) - Number(a.available) || Number(b.pointed) - Number(a.pointed) || a.order - b.order);
          return json({ ...song, videos: videos.map(({ order: _, ...v }) => v) } satisfies SongDto);
        }
        if (p === "/api/favorites") {
          const rows = listFavoriteRows(s.db);
          const vids = videosByIds(rows.map((r) => r.video_id));
          const chapters = new Map<string, ChapterRow>();
          for (const c of s.db.query("SELECT * FROM chapter_full WHERE favorited_at IS NOT NULL").all() as ChapterRow[]) chapters.set(c.id, c);
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
        // A theme's files (docs/themes.md): `src/web/themes/<id>/<file>`, stylesheet, palette and wallpaper alike.
        if ((m = p.match(/^\/themes\/([a-z0-9-]+)\/([a-z0-9._-]+)$/i)) && !m[2]!.startsWith(".")) {
          const f = Bun.file(join(s.cfg.webDir, "themes", m[1]!, m[2]!));
          if (!(await f.exists())) return json({ error: "no such theme file" }, 404);
          const type = THEME_FILE_TYPES[extensionOf(m[2]!)];
          if (!type) return json({ error: "not a theme file type" }, 404);
          return new Response(f, { headers: { "content-type": type, "cache-control": type.startsWith("text/css") ? "no-store" : "max-age=86400" } });
        }
        if ((m = p.match(/^\/api\/copies\/(\d+)$/))) {
          const c = s.db.query(`${COPY_SQL} WHERE c.id = ?`).get(Number(m[1])) as CopyDbRow | null;
          return c ? json(copyJson(c)) : json({ error: "no such copy" }, 404);
        }
        // The Copy's keyframe index (spec 4.1): 200 with the times when it is made, 202 while ffprobe reads the file
        // (asking queues the job), 200 `none` for a Copy that cannot be indexed now (unavailable, or no keyframes).
        if ((m = p.match(/^\/api\/copies\/(\d+)\/keyframes$/))) {
          const st = s.keyframes.status(Number(m[1]));
          return json(st, st.state === "indexing" ? 202 : 200, st.state === "indexing" ? { "retry-after": "3" } : {});
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
        if (p === "/api/onboarding") return json(onboardingState());
        // Client routes (hand-rolled history routing, spec 9): every one serves the shell.
        if (p === "/" || p === "/index.html" || p === "/favorites" || p === "/search" || p === "/artists" || p === "/songs" || /^\/play\/[0-9a-fA-F-]{36}$/.test(p) || /^\/lyrics\/[0-9a-fA-F-]+$/.test(p))
          return new Response(Bun.file(join(s.cfg.webDir, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (req.method === "POST") {
        if (p === "/api/tv/on") {
          const r = s.tv.start();
          return r.ok ? json(s.tv.state()) : json({ error: r.error }, r.status);
        }
        if (p === "/api/tv/off") {
          s.tv.stop();
          return json(s.tv.state());
        }
        if (p === "/api/tv/approve" || p === "/api/tv/deny") {
          const b = await readJson(req);
          if (!b || typeof b.ip !== "string" || !b.ip.trim()) return json({ error: "ip is required" }, 400);
          if (p === "/api/tv/approve") s.tv.approve(b.ip);
          else s.tv.deny(b.ip);
          return json(s.tv.state());
        }
        if ((m = p.match(/^\/api\/(videos|chapters)\/([0-9a-fA-F-]{36})\/favorite$/))) {
          const table = m[1] === "videos" ? "video" : "chapter";
          let want: boolean | undefined;
          try {
            const b = (await req.json()) as { favorite?: unknown };
            if (typeof b.favorite === "boolean") want = b.favorite;
          } catch {}
          const at = setFavorite(s.db, table, m[2]!, want);
          if (at === undefined) return json({ error: `no such ${table}` }, 404);
          return json({ id: m[2]!, favorite: at !== null, favoritedAt: at });
        }
        if ((m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/chapters$/))) {
          const body = await readJson(req);
          if (!body) return json({ error: "body must be a JSON object" }, 400);
          const r = addChapter(s.db, m[1]!, body);
          return r.ok ? json(r.value, 201) : json({ error: r.error }, r.status);
        }
        if ((m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/chapters\/confirm-all$/))) {
          const r = confirmAll(s.db, m[1]!);
          return r.ok ? json(r.value) : json({ error: r.error }, r.status);
        }
        if ((m = p.match(/^\/api\/chapters\/([0-9a-fA-F-]{36})\/confirm$/))) {
          const r = confirmChapter(s.db, m[1]!);
          return r.ok ? json(r.value) : json({ error: r.error }, r.status);
        }
        if ((m = p.match(/^\/api\/chapters\/([0-9a-fA-F-]{36})\/reject$/))) {
          const r = rejectChapter(s.db, m[1]!);
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
        if ((m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/view$/))) {
          // One more view (spec 4.3): the Player posts it the first time playback starts on a Now playing visit.
          if (recordView(s.db, m[1]!) === undefined) return json({ error: "no such video" }, 404);
          return videoResponse(m[1]!);
        }
        if ((m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/resume$/))) {
          let body: { resumeS?: unknown; copyId?: unknown } = {};
          try {
            body = (await req.json()) as typeof body; // sendBeacon posts a Blob; the content type does not matter here
          } catch {}
          if (typeof body.resumeS !== "number" || !Number.isFinite(body.resumeS) || body.resumeS < 0) return json({ error: "resumeS must be a number >= 0" }, 400);
          const r = recordResume(s.db, m[1]!, body.resumeS, typeof body.copyId === "number" ? body.copyId : null);
          if (!r) return json({ error: "no such video" }, 404);
          return json({ id: m[1]!, ...r });
        }
        if ((m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/loop$/))) {
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
          const r = recordLoop(s.db, m[1]!, l as StoredLoop | null);
          if (!r) return json({ error: "no such video" }, 404);
          return json({ id: m[1]!, ...r });
        }
        if ((m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/screenshot$/))) {
          const v = s.db.query("SELECT title FROM video_full WHERE id = ?").get(m[1]!) as { title: string } | null;
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
        if ((m = p.match(/^\/api\/artists\/([0-9a-fA-F-]{36})\/merge-into\/([0-9a-fA-F-]{36})$/))) {
          const r = mergeArtist(s.db, m[1]!, m[2]!);
          if (!r.ok) return json({ error: r.error }, r.status);
          rebuildSearchIndex(s.db);
          return json({ merged: true, moved: r.moved });
        }
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/tv\/approved\/([^/]+)$/))) {
        if (!s.tv.remove(decodeURIComponent(m[1]!))) return json({ error: "no such Approved TV" }, 404);
        return json(s.tv.state());
      }
      if (req.method === "PUT" && (m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/audio$/))) {
        const body = (await req.json().catch(() => ({}))) as { state?: unknown };
        const r = setVideoAudio(s.db, m[1]!, body.state ?? null);
        return r.ok ? json({ state: r.value }) : json({ error: r.error }, r.status);
      }
      if (req.method === "PUT" && (m = p.match(/^\/api\/audio-presets\/([^/]+)$/))) {
        const body = (await req.json().catch(() => ({}))) as { eq?: unknown };
        const r = savePreset(s.db, decodeURIComponent(m[1]!), body.eq);
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/view$/))) {
        if (!resetViews(s.db, m[1]!)) return json({ error: "no such video" }, 404);
        return videoResponse(m[1]!);
      }
      // Shelved edits (sharing-spec §7.4): one (after its copy back), one Video's ("Clear"), or all (the chip menu).
      if (req.method === "DELETE" && (p === "/api/shelved" || /^\/api\/shelved\/\d+$/.test(p) || /^\/api\/videos\/[0-9a-fA-F-]{36}\/shelved$/.test(p))) {
        const refused = localRequestError(req);
        if (refused) return json({ error: refused }, 403);
        const one = p.match(/^\/api\/shelved\/(\d+)$/);
        if (one) return dropShelved(s.db, Number(one[1])) ? json({ cleared: 1 }) : json({ error: "no such Shelved edit" }, 404);
        const vid = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/shelved$/);
        return json({ cleared: clearShelved(s.db, vid?.[1]) });
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/copies$/))) {
        // This machine's Copies to the Trash; the Video stays, Not on this machine (sharing-spec §4.5). Same-origin only.
        const refused = localRequestError(req);
        if (refused) return json({ error: refused }, 403);
        const r = await removeCopies(s.db, s.cfg, s.roots, m[1]!);
        return r ? json(r) : json({ error: "no such video" }, 404);
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})$/))) {
        // Delete a Video from the library; `media: true` also moves its files to the Trash (deleteVideo.ts).
        const body = (await req.json().catch(() => ({}))) as { media?: unknown };
        const r = await deleteVideo(s.db, s.cfg, s.roots, m[1]!, { media: body.media === true });
        if (r && "refused" in r) return json({ error: r.refused }, 409);
        return r ? json(r) : json({ error: "no such video" }, 404);
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/audio-presets\/([^/]+)$/))) {
        const r = deletePreset(s.db, decodeURIComponent(m[1]!));
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "PATCH" && (m = p.match(/^\/api\/artists\/([0-9a-fA-F-]{36})$/))) {
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = renameLocalArtist(s.db, m[1]!, body.name);
        if (!r.ok) return json({ error: r.error }, r.status);
        indexArtist(s.db, r.value.id);
        return json(r.value);
      }
      if (req.method === "PATCH" && (m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})$/))) {
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = patchVideo(s.db, m[1]!, body);
        if (!r.ok) return json({ error: r.error }, r.status);
        return videoResponse(m[1]!);
      }
      if (req.method === "PATCH" && (m = p.match(/^\/api\/chapters\/([0-9a-fA-F-]{36})$/))) {
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = patchChapter(s.db, m[1]!, body);
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/studio-tracks\/(\d+)$/))) {
        const r = s.studio.remove(Number(m[1]));
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/chapters\/([0-9a-fA-F-]{36})$/))) {
        const r = deleteChapter(s.db, m[1]!);
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }
      if (req.method === "POST" && (m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/artists\/confirm$/))) {
        const r = confirmVideoArtists(s.db, m[1]!);
        if (!r.ok) return json({ error: r.error }, r.status);
        return videoResponse(m[1]!);
      }
      if (req.method === "DELETE" && (m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/artists\/([0-9a-fA-F-]{36})$/))) {
        const r = rejectVideoArtist(s.db, m[1]!, m[2]!);
        if (!r.ok) return json({ error: r.error }, r.status);
        return videoResponse(m[1]!);
      }
      if (req.method === "PUT" && (m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/artists$/))) {
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = setVideoArtists(s.db, m[1]!, body.artistIds);
        if (!r.ok) return json({ error: r.error }, r.status);
        return videoResponse(m[1]!);
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
      // The browser hands the companion the rows a write function returned (sharing-spec §4.9, §6.2): one transaction,
      // the updated_at guard, children replaced per bumped parent. Same-origin only: never the TV listener, never a page
      // of another site (the Origin and Host checks of §5.2).
      if (req.method === "POST" && p === "/api/cache/apply") {
        const refused = localRequestError(req);
        if (refused) return json({ error: refused }, 403);
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a write function's {tables, tombstones} or a shared_changes_since return" }, 400);
        const unknown = Object.keys(body).filter((k) => !CACHE_APPLY_KEYS.has(k));
        if (unknown.length) return json({ error: `unknown key(s) ${unknown.join(", ")}: rows go under "tables" (migration 130's shape)` }, 400);
        try {
          return json(applyShared(s.db, body as SharedChanges));
        } catch (e) {
          return json({ error: `nothing was applied: ${(e as Error).message ?? e}` }, 422);
        }
      }
      // The `pending_share` queue (sharing-spec §6.6, #140): its counts for the one question and the chip row, the
      // inserts the browser drains it with, and the machine's "Share once, then automatic" answer. Posters (§6.5):
      // the local posters a Video Editor's browser uploads. This machine's pages only (Host; writes also Origin).
      if (req.method === "GET" && (p === "/api/share" || p === "/api/share/pending" || p === "/api/posters/upload")) {
        const refused = hostError(req);
        if (refused) return json({ error: refused }, 403);
        if (p === "/api/share") return json(pendingShareSummary(s.db));
        if (p === "/api/share/pending") return json(pendingShareBatch(s.db));
        return json({ candidates: posterUploadCandidates(s.db, s.cfg.thumbsDir) });
      }
      if (req.method === "POST" && p === "/api/share/auto") {
        const refused = localRequestError(req);
        if (refused) return json({ error: refused }, 403);
        const body = await readJson(req);
        if (!body || typeof body.auto !== "boolean") return json({ error: "body must be {auto: boolean}" }, 400);
        setShareAuto(s.db, body.auto);
        return json(pendingShareSummary(s.db));
      }
      // The Session record (sharing-spec §5.2): read by every tab on launch and window focus. Token-free, but it names
      // the account, so only this machine's pages (the Host check; a same-origin GET sends no Origin).
      if (req.method === "GET" && p === "/api/session") {
        const refused = hostError(req);
        if (refused) return json({ error: refused }, 403);
        return json({ record: readSessionRecord(s.db), archive: s.cfg.archive, syncing: sync.busy() } satisfies SessionResponse);
      }
      // Sign out, a SIGNED_OUT event the browser read as a dropped session, or a cancelled sign-in (§2.4, §5.1, §5.4):
      // the record goes, the Local copy stays read-only.
      if (req.method === "DELETE" && p === "/api/session") {
        const refused = localRequestError(req);
        if (refused) return json({ error: refused }, 403);
        clearSessionRecord(s.db);
        return json({ record: null });
      }
      // A Sync (§5.2, §6.2–§6.4) with the browser's access token in the body, never the URL or a header we log:
      // video_whoami(), the record, the schema gate, the pull and its apply. `full: true` is "Refresh all Shared data".
      // Origin and Host checked: it takes a token.
      if (req.method === "POST" && p === "/api/sync") {
        const refused = localRequestError(req);
        if (refused) return json({ error: refused }, 403);
        const body = await readJson(req);
        const extra = body ? Object.keys(body).filter((k) => k !== "access_token" && k !== "full") : [];
        if (!body || extra.length || !looksLikeJwt(body.access_token) || (body.full !== undefined && typeof body.full !== "boolean"))
          return json({ error: "body must be {access_token, full?} (the access token only, never the refresh token)" }, 400);
        return json(await sync.request({ accessToken: body.access_token, full: body.full === true }));
      }
      // Sign-in reconciliation (sharing-spec §2.3, #149). The preview is the confirmation's count: video_whoami() (the
      // record) and the whole Shared set, nothing else written; the token rides in the Authorization header (a GET has
      // no body; never logged), Host checked, and a cross-site page cannot send that header without a preflight we
      // never answer. Continue posts {access_token}: reconcile and apply in one transaction; the Sync that follows pulls.
      if (req.method === "GET" && p === "/api/reconcile/preview") {
        const refused = hostError(req) ?? (req.headers.get("origin") ? localRequestError(req) : null);
        if (refused) return json({ error: refused }, 403);
        const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
        if (!looksLikeJwt(token)) return json({ error: "send the access token as Authorization: Bearer <token>" }, 400);
        return json(await reconcile.preview(token));
      }
      if (req.method === "POST" && p === "/api/reconcile") {
        const refused = localRequestError(req);
        if (refused) return json({ error: refused }, 403);
        const body = await readJson(req);
        if (!body || Object.keys(body).some((k) => k !== "access_token") || !looksLikeJwt(body.access_token))
          return json({ error: "body must be {access_token} (the access token only, never the refresh token)" }, 400);
        return json(await reconcile.confirm(body.access_token));
      }
      if (req.method === "POST" && (m = p.match(/^\/api\/videos\/([0-9a-fA-F-]{36})\/relocate$/))) {
        // Point a Video's Copy at its file's new place (Now playing's folder button). See relocate.ts.
        const body = await readJson(req);
        if (!body) return json({ error: "body must be a JSON object" }, 400);
        const r = await relocateCopy(s.db, s.cfg, s.roots.list(), m[1]!, body as any);
        if (!r.ok) return json({ error: r.error, ...("conflict" in r ? { conflict: r.conflict } : {}) }, r.status);
        await s.roots.check(r.value.rootId);
        s.thumbs.kick();
        return videoResponse(m[1]!);
      }
      if (req.method === "POST" && p === "/api/choose-file") {
        // The Finder's "choose file" dialog (macOS), for the folder button: a browser page cannot learn a file's full path.
        const body = (await readJson(req)) ?? {};
        // Open where the file used to be, or the nearest folder above it that still exists.
        let start = typeof body.start === "string" && body.start.startsWith("/") ? body.start : "";
        while (start && start !== "/" && !(await stat(start).then((x) => x.isDirectory(), () => false))) start = dirname(start);
        if (start === "/") start = "";
        const loc = start ? ` default location (POSIX file ${JSON.stringify(start)})` : "";
        const r = await run("osascript", ["-e", 'tell application "System Events" to activate', "-e", `tell application "System Events" to return POSIX path of (choose file with prompt "Where is this Video's file now?"${loc})`], { timeout: 600_000 });
        if (r.code === 0) return json({ path: r.out.trim() });
        if (/-128|cancel/i.test(r.err)) return json({ cancelled: true });
        return json({ error: r.err.trim() || "the file dialog failed" }, 500);
      }
      // First launch (sharing-spec §8.4): the typed folder becomes the machine's one Root and its first scan starts at
      // once; the no-scan-at-startup rule holds for later launches. Same-origin only, like the other machine writes.
      if (req.method === "POST" && p === "/api/roots") {
        const refused = localRequestError(req);
        if (refused) return json({ error: refused }, 403);
        const body = await readJson(req);
        if (!body || typeof body.path !== "string") return json({ error: "body must be {path}" }, 400);
        if (s.roots.list().length > 0) return json({ error: "This machine already has a videos folder" }, 409);
        const checked = await checkRootPath(body.path, homedir());
        if (!checked.ok) return json({ error: checked.error }, 422);
        const root = s.roots.add(checked.path);
        // The check's first "available" already queues the scan through the remount listener (app.ts); a passive
        // server has no listener, so queue it here unless it is running or queued.
        await s.roots.check(root.id);
        const prog = s.scanner.progress();
        if (!prog.running && !prog.queued.includes(root.id)) s.scanner.request(root.id);
        return json({ root, onboarding: onboardingState() }, 201);
      }
      if (req.method === "POST" && p === "/api/onboarding/dismiss-bar") {
        const refused = localRequestError(req);
        if (refused) return json({ error: refused }, 403);
        setMeta(s.db, ROOT_BAR_DISMISSED, new Date().toISOString());
        return json(onboardingState());
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

