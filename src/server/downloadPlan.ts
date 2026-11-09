// The download dialog's plan (docs/downloader-spec.md §3.4, §6 `POST /api/downloads/plan`, §7.2): which Videos each option
// would download, what they weigh and how long that takes, and whether the destination can hold them. Read-only.
import { statfs } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ASSUMED_THROUGHPUT_BPS, estimateVideoBytes, normQuality, totalsOf, type EstimateTotals, type Quality } from "../shared/downloadEstimate";
import { TYPES, type VideoType } from "../shared/filters";
import { videoPresence } from "../shared/presence";
import type { ArtistRef, CopyDto } from "../shared/types";
import type { Db } from "./db";

export const PLAN_OPTIONS = ["full", "random", "type", "artist", "favorites"] as const;
export type PlanOption = (typeof PLAN_OPTIONS)[number];
export const DEFAULT_RANDOM_N = 20;
export const MAX_RANDOM_N = 100_000;

/** What the plan reads of a Video: the grid's Video JSON (`/api/videos`) has all of it. */
export interface PlanVideo {
  id: string;
  title: string;
  type: string;
  youtubeId: string | null;
  instagramId: string | null;
  rutubeId: string | null;
  favoritedAt: string | null;
  available: boolean;
  copies: Pick<CopyDto, "missing">[];
  artists: Pick<ArtistRef, "id" | "name" | "nameLatin">[];
  durationS: number | null;
  thumbnail: { poster: string } | null;
  createdAt: string;
}

export type Source = "youtube" | "instagram" | "rutube";
/** The site yt-dlp would fetch from: YouTube, else Instagram, else Rutube (the order `sourceLink` uses); null = hash-only. */
export const sourceOf = (v: Pick<PlanVideo, "youtubeId" | "instagramId" | "rutubeId">): Source | null =>
  v.youtubeId ? "youtube" : v.instagramId ? "instagram" : v.rutubeId ? "rutube" : null;

/** Downloadable: it has a source id and is Not on this machine (§7.2). Hash-only Videos are in no count or estimate. */
export const isDownloadable = (v: PlanVideo): boolean => sourceOf(v) != null && videoPresence(v) === "notHere";

export interface PlanRequest {
  option: PlanOption;
  quality: Quality;
  n?: number;
  seed?: number;
  type?: VideoType;
  artistId?: string;
  destDir?: string;
}

/** Validates a request body; the message is the 400. */
export function parsePlanRequest(body: Record<string, unknown>): PlanRequest | string {
  const { option, quality, n, seed, type, artistId, destDir } = body;
  if (!PLAN_OPTIONS.includes(option as PlanOption)) return `option must be one of ${PLAN_OPTIONS.join(", ")}`;
  const q = normQuality(quality);
  if (!q) return "quality must be 720p, 1080p or best";
  const req: PlanRequest = { option: option as PlanOption, quality: q };
  if (n != null) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_RANDOM_N) return `n must be an integer from 1 to ${MAX_RANDOM_N}`;
    req.n = n;
  }
  if (seed != null) {
    if (typeof seed !== "number" || !Number.isInteger(seed)) return "seed must be an integer";
    req.seed = seed;
  }
  if (type != null) {
    if (!(TYPES as readonly unknown[]).includes(type)) return `type must be one of ${TYPES.join(", ")}`;
    req.type = type as VideoType;
  }
  if (artistId != null) {
    if (typeof artistId !== "string" || !artistId) return "artistId must be a string";
    req.artistId = artistId;
  }
  if (destDir != null) {
    if (typeof destDir !== "string" || !isAbsolute(destDir)) return "destDir must be an absolute path";
    req.destDir = destDir;
  }
  return req;
}

/** mulberry32: a small seeded generator, so a reroll's seed reproduces its pick. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** N of the Videos, the same N for the same seed and the same set (the input is put in id order first). */
export function pickRandom<T extends { id: string }>(videos: readonly T[], n: number, seed: number): T[] {
  const a = [...videos].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const r = rng(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

/** Whether `dir` is a Root's folder or inside one. */
export function inRoot(dir: string, rootPaths: readonly string[]): boolean {
  const d = resolve(dir);
  return rootPaths.some((r) => {
    const rel = relative(resolve(r), d);
    return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
  });
}

/** Free bytes on the volume holding `dir` (the nearest existing parent when it is not made yet); null when unreadable. */
export async function freeBytesAt(dir: string): Promise<number | null> {
  let d = resolve(dir);
  for (;;) {
    try {
      const s = await statfs(d);
      return Number(s.bavail) * Number(s.bsize);
    } catch (e) {
      const up = dirname(d);
      if (up === d || (e as NodeJS.ErrnoException).code !== "ENOENT") return null;
      d = up;
    }
  }
}

/** The last job's throughput, when the queue has written one (`download_setting`, §3.4); else null. */
export function lastThroughput(db: Db): number | null {
  try {
    const r = db.query("SELECT value FROM download_setting WHERE key = 'last_throughput_bps'").get() as { value: string } | null;
    const n = r ? Number(r.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null; // no table yet
  }
}

/** Reference size per Video id (`videos.size_bytes`, `duration_s`, `height`; migration 0022). */
function referenceSizes(db: Db): Map<string, { sizeBytes: number | null; durationS: number | null; height: number | null }> {
  const out = new Map<string, { sizeBytes: number | null; durationS: number | null; height: number | null }>();
  for (const r of db.query("SELECT id, size_bytes, duration_s, height FROM videos WHERE deleted_at IS NULL").all() as { id: string; size_bytes: number | null; duration_s: number | null; height: number | null }[])
    out.set(r.id, { sizeBytes: r.size_bytes, durationS: r.duration_s, height: r.height });
  return out;
}

export interface PlanOptionSummary extends EstimateTotals {}

export interface PlanResponse {
  option: PlanOption;
  quality: Quality;
  videos: { id: string; title: string; artists: string[]; source: Source; durationS: number | null; estBytes: number | null; posterUrl: string | null }[];
  totals: EstimateTotals & { throughputAssumed: boolean };
  /** One summary per tile (§7.2). `random` is for the chosen N and seed; `type` and `artist` for the chosen one. */
  options: Record<PlanOption, PlanOptionSummary>;
  /** What the tiles' controls resolved to (the plan fills in defaults so the dialog and the next request agree). */
  n: number;
  seed: number;
  type: VideoType | null;
  artistId: string | null;
  /** The Type select's choices and the Artist select's, with their downloadable counts (only the non-empty ones). */
  types: { type: VideoType; count: number }[];
  artists: { id: string; name: string; count: number }[];
  destDir: string | null;
  freeBytes: number | null;
  destInRoot: boolean;
  instagramCount: number;
  /** Throughput used for the times, bytes per second. */
  throughputBps: number;
}

export interface PlanEnv {
  db: Db;
  videos: readonly PlanVideo[];
  /** Mounted Roots' paths in Root order (the default destination is the first). */
  mountedRoots: readonly string[];
  /** Every Root's path, mounted or not (a folder inside any of them is "in Root"). */
  allRoots: readonly string[];
  newSeed?: () => number;
  freeBytes?: (dir: string) => Promise<number | null>;
}

const byRecent = (a: PlanVideo, b: PlanVideo) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1);

export async function buildPlan(env: PlanEnv, req: PlanRequest): Promise<PlanResponse> {
  const pool = env.videos.filter(isDownloadable).sort(byRecent);
  const refs = referenceSizes(env.db);
  const lastBps = lastThroughput(env.db);
  const throughputBps = lastBps ?? ASSUMED_THROUGHPUT_BPS;
  const est = (v: PlanVideo) => {
    const r = refs.get(v.id);
    return estimateVideoBytes({ sizeBytes: r?.sizeBytes, durationS: r?.durationS ?? v.durationS, height: r?.height }, req.quality);
  };
  const summarize = (vs: readonly PlanVideo[]): PlanOptionSummary => totalsOf(vs.map(est), throughputBps);

  const n = req.n ?? DEFAULT_RANDOM_N;
  const seed = req.seed ?? (env.newSeed ?? (() => Math.floor(Math.random() * 2 ** 31)))();

  // The Type and Artist selects: only the choices that have something to download. Default: the biggest.
  const typeCount = new Map<VideoType, number>();
  const artistCount = new Map<string, { name: string; count: number }>();
  for (const v of pool) {
    typeCount.set(v.type as VideoType, (typeCount.get(v.type as VideoType) ?? 0) + 1);
    for (const a of new Map(v.artists.map((x) => [x.id, x])).values()) {
      const e = artistCount.get(a.id);
      if (e) e.count++;
      else artistCount.set(a.id, { name: a.name, count: 1 });
    }
  }
  const types = TYPES.filter((t) => typeCount.has(t)).map((t) => ({ type: t, count: typeCount.get(t)! }));
  const artists = [...artistCount].map(([id, e]) => ({ id, ...e })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  const type = req.type ?? [...types].sort((a, b) => b.count - a.count)[0]?.type ?? null;
  const artistId = req.artistId ?? artists[0]?.id ?? null;

  const lists: Record<PlanOption, PlanVideo[]> = {
    full: pool,
    random: pickRandom(pool, n, seed),
    type: type ? pool.filter((v) => v.type === type) : [],
    artist: artistId ? pool.filter((v) => v.artists.some((a) => a.id === artistId)) : [],
    favorites: pool.filter((v) => v.favoritedAt != null),
  };
  const chosen = lists[req.option];
  const options = Object.fromEntries(PLAN_OPTIONS.map((o) => [o, summarize(lists[o])])) as Record<PlanOption, PlanOptionSummary>;

  const destDir = req.destDir ?? env.mountedRoots[0] ?? null;
  const free = destDir ? await (env.freeBytes ?? freeBytesAt)(destDir) : null;
  return {
    option: req.option,
    quality: req.quality,
    videos: chosen.map((v) => ({
      id: v.id,
      title: v.title,
      artists: v.artists.map((a) => a.name),
      source: sourceOf(v)!,
      durationS: refs.get(v.id)?.durationS ?? v.durationS,
      estBytes: est(v),
      posterUrl: v.thumbnail?.poster ?? null,
    })),
    totals: { ...summarize(chosen), throughputAssumed: lastBps == null },
    options,
    n,
    seed,
    type,
    artistId,
    types,
    artists,
    destDir,
    freeBytes: free,
    destInRoot: destDir ? inRoot(destDir, env.allRoots) : false,
    instagramCount: chosen.filter((v) => sourceOf(v) === "instagram").length,
    throughputBps,
  };
}
