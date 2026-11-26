// The real dependencies of the Download queue: this machine's tools, Roots, scanner and network (downloader-spec §2, §4.5–4.6).

import { sep } from "node:path";
import { findBin, type Config } from "../config";
import type { Db } from "../db";
import type { HomeServer } from "../homeServer";
import { homeDownloadSnapshot, localIdentities } from "../homeVideos";
import { newUuid } from "../localCopy/ids";
import { rebuildSearchIndex } from "../search";
import type { HomeSnapshot } from "./homeFetch";
import type { Roots } from "../roots";
import type { Scanner } from "../scan";
import { createDownloadQueue, type DownloadQueue, type ToolSet } from "./queue";
import { detectJsRuntime, ffmpegLocation } from "./tools";
import { cookiesFor, noteCookies } from "./instagramAuth";
import type { DownloaderTools } from "./toolsInstall";

export const PROBE_URL = "https://www.youtube.com/generate_204";

export async function probeConnectivity(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchFn(PROBE_URL, { method: "HEAD", signal: AbortSignal.timeout(5000), redirect: "manual" });
    return r.status < 500;
  } catch {
    return false;
  }
}

/**
 * §8: the Video the scan just made out of a Home Server file takes the Home Server's titles, Type and Chapters as its
 * Unshared data. Only a Video made during this run (`since`) that no Sync delivered; Song and Version pointers are not
 * carried (the index does not list them: they were the Home Server's Local rows).
 */
export function applyHomeData(db: Db, videoId: string, snap: HomeSnapshot, since: string): boolean {
  const v = db.query("SELECT v.created_at, COALESCE(l.shared, 0) AS shared FROM videos v LEFT JOIN video_local l ON l.video_id = v.id WHERE v.id = ?").get(videoId) as { created_at: string; shared: number } | null;
  if (!v || v.shared || v.created_at < since) return false;
  const now = new Date().toISOString();
  const type = ["song", "concert", "interview", "other"].includes(snap.type) ? snap.type : "other";
  db.transaction(() => {
    db.prepare("UPDATE videos SET title = ?, title_latin = ?, title_latin_source = ?, type = ?, type_suggested = 0, updated_at = ? WHERE id = ?").run(snap.title, snap.titleLatin, snap.titleLatin ? "manual" : null, type, now, videoId);
    const ins = db.prepare("INSERT OR IGNORE INTO video_chapters (id, video_id, start_s, title, title_latin, title_latin_source, suggested, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 'manual', ?)");
    for (const c of snap.chapters) ins.run(newUuid(), videoId, c.startS, c.title, c.titleLatin, c.titleLatin ? "manual" : null, now);
  })();
  rebuildSearchIndex(db);
  return true;
}

export function createDownloadService(o: { cfg: Pick<Config, "dataDir" | "ffprobe">; db: Db; roots: Roots; scanner: Scanner; tools: DownloaderTools; home?: HomeServer }): DownloadQueue {
  let rtCache: { at: number; path: string | null } | null = null;
  const jsRuntime = async (): Promise<string | null> => {
    if (rtCache && Date.now() - rtCache.at < 60_000) return rtCache.path;
    const rt = await detectJsRuntime(o.cfg.dataDir);
    rtCache = { at: Date.now(), path: rt.kind === "deno" ? rt.path : null };
    return rtCache.path;
  };
  const rootFor = (dir: string) => {
    let best: { id: number; path: string } | null = null;
    for (const r of o.roots.list()) {
      if ((dir === r.path || dir.startsWith(r.path.endsWith(sep) ? r.path : r.path + sep)) && (!best || r.path.length > best.path.length)) best = { id: r.id, path: r.path };
    }
    return best;
  };
  return createDownloadQueue({
    db: o.db,
    dataDir: o.cfg.dataDir,
    tools: async (): Promise<ToolSet | null> => {
      const ytDlpPath = o.tools.ytdlpPath();
      if (!ytDlpPath) return null;
      const ff = ffmpegLocation(findBin("ffmpeg"), o.cfg.ffprobe);
      return { ytDlpPath, ffmpegLocation: ff.args[1]!, jsRuntime: await jsRuntime(), env: ff.env };
    },
    beforeJob: () => o.tools.updateYtDlpIfDue(() => false),
    probe: () => probeConnectivity(),
    rootFor,
    rootAvailable: (id) => o.roots.isAvailable(id),
    defaultRoot: () => {
      const r = o.roots.list().find((x) => o.roots.isAvailable(x.id));
      return r ? { id: r.id, path: r.path } : null;
    },
    scanFile: (rootId, rel) => o.scanner.scanFile(rootId, rel),
    homeBase: () => o.home?.base() ?? null,
    homeResolve: (videoId) => {
      if (!o.home) return null;
      const local = o.db.query("SELECT title FROM video_full WHERE id = ?").get(videoId) as { title: string } | null;
      return homeDownloadSnapshot(o.home.view(localIdentities(o.db)), videoId, local?.title ?? null);
    },
    applyHomeData: (videoId, snap, since) => void applyHomeData(o.db, videoId, snap, since),
    jsRuntimeAvailable: async () => {
      rtCache = null;
      return (await jsRuntime()) !== null;
    },
    instagramCookies: () => cookiesFor(o.db, o.cfg.dataDir),
    onInstagramCookies: (outcome) => noteCookies(o.db, outcome),
  });
}
