// The real dependencies of the Download queue: this machine's tools, Roots, scanner and network (downloader-spec §2, §4.5–4.6).

import { sep } from "node:path";
import { findBin, type Config } from "../config";
import type { Db } from "../db";
import type { Roots } from "../roots";
import type { Scanner } from "../scan";
import { createDownloadQueue, type DownloadQueue, type ToolSet } from "./queue";
import { detectJsRuntime, ffmpegLocation } from "./tools";
import { getSetting, type DownloaderTools } from "./toolsInstall";

export const PROBE_URL = "https://www.youtube.com/generate_204";

export async function probeConnectivity(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchFn(PROBE_URL, { method: "HEAD", signal: AbortSignal.timeout(5000), redirect: "manual" });
    return r.status < 500;
  } catch {
    return false;
  }
}

export function createDownloadService(o: { cfg: Pick<Config, "dataDir" | "ffprobe">; db: Db; roots: Roots; scanner: Scanner; tools: DownloaderTools }): DownloadQueue {
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
    jsRuntimeAvailable: async () => {
      rtCache = null;
      return (await jsRuntime()) !== null;
    },
    instagramCookies: () => {
      try {
        const a = JSON.parse(getSetting(o.db, "instagram_auth") ?? "null") as { kind?: string; expired?: boolean } | null;
        return !!a && (a.kind === "browser" || a.kind === "file") && !a.expired;
      } catch {
        return false;
      }
    },
  });
}
