import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  dataDir: string;
  dbPath: string;
  thumbsDir: string;
  remuxDir: string;
  /** YouTube info cache (spec 8): `<id>.info.json` files written by scripts/fetch-youtube-info.ts. */
  ytCacheDir: string;
  screenshotDir: string;
  logPath: string;
  /** Cached Music.app library dump (spec 7.2). */
  studioDumpPath: string;
  port: number;
  /**
   * A second server on the real library (another port, default data dir), e.g. a test preview: it scans only on an
   * explicit Rescan, never at startup or remount, so starting it does not re-scan and re-thumbnail the library.
   */
  passive: boolean;
  localRoot: string;
  /** Optional external Root (a drive); unset since the library moved under the local Root's `archive/` (2026-10-11). */
  externalRoot?: string;
  ffmpeg: string;
  ffprobe: string;
  cwebp: string;
  /** Moves a file to the Trash (deleting a Video with its media). macOS 15's `trash`; tests point it elsewhere. */
  trash: string;
  openTab: boolean;
  migrationsDir: string;
  webDir: string;
}

/**
 * Native arm64 Homebrew first: the x86_64 build under /usr/local runs under Rosetta at about half the speed
 * (docs/research/plex-low-lag.md §6). `TUVA_BIN_DIR` puts another directory in front.
 */
export function findBin(name: string, env: Record<string, string | undefined> = process.env): string {
  const dirs = [env.TUVA_BIN_DIR, "/opt/homebrew/bin", "/usr/local/bin"].filter((d): d is string => !!d);
  for (const d of dirs) if (existsSync(join(d, name))) return join(d, name);
  return Bun.which(name) ?? name;
}

/** All paths and knobs in one place. `TUVA_*` env vars exist for tests and the smoke run only. */
export const DEFAULT_PORT = 4400;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataDir = env.TUVA_DATA_DIR ?? join(homedir(), "Library", "Application Support", "TuvaVideos");
  const port = Number(env.TUVA_PORT ?? DEFAULT_PORT);
  return {
    dataDir,
    dbPath: join(dataDir, "library.db"),
    thumbsDir: join(dataDir, "thumbs"),
    remuxDir: join(dataDir, "remux"),
    ytCacheDir: env.TUVA_YT_CACHE ?? join(dataDir, "youtube-info"),
    screenshotDir: env.TUVA_SCREENSHOT_DIR ?? join(homedir(), "Desktop"),
    logPath: join(dataDir, "log.txt"),
    studioDumpPath: join(dataDir, "studio-dump.json"),
    port,
    passive: port !== DEFAULT_PORT && env.TUVA_DATA_DIR === undefined,
    localRoot: env.TUVA_LOCAL_ROOT ?? "/Users/evanwilliams/Desktop/Khoomei/Videos",
    externalRoot: env.TUVA_EXTERNAL_ROOT,
    ffmpeg: findBin("ffmpeg", env),
    ffprobe: findBin("ffprobe", env),
    cwebp: findBin("cwebp", env),
    trash: env.TUVA_TRASH ?? "/usr/bin/trash",
    openTab: env.TUVA_NO_OPEN !== "1",
    migrationsDir: join(import.meta.dir, "..", "..", "migrations"),
    webDir: join(import.meta.dir, "..", "web"),
  };
}
