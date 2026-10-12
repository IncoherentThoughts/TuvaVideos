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
  localRoot: string;
  /** Optional external Root (a drive); unset since the library moved under the local Root's `archive/` (2026-10-11). */
  externalRoot?: string;
  ffmpeg: string;
  ffprobe: string;
  cwebp: string;
  openTab: boolean;
  migrationsDir: string;
  webDir: string;
}

function findBin(name: string): string {
  const fixed = `/usr/local/bin/${name}`;
  if (existsSync(fixed)) return fixed;
  return Bun.which(name) ?? name;
}

/** All paths and knobs in one place. `TUVA_*` env vars exist for tests and the smoke run only. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataDir = env.TUVA_DATA_DIR ?? join(homedir(), "Library", "Application Support", "TuvaVideos");
  return {
    dataDir,
    dbPath: join(dataDir, "library.db"),
    thumbsDir: join(dataDir, "thumbs"),
    remuxDir: join(dataDir, "remux"),
    ytCacheDir: env.TUVA_YT_CACHE ?? join(dataDir, "youtube-info"),
    screenshotDir: env.TUVA_SCREENSHOT_DIR ?? join(homedir(), "Desktop"),
    logPath: join(dataDir, "log.txt"),
    studioDumpPath: join(dataDir, "studio-dump.json"),
    port: Number(env.TUVA_PORT ?? 4400),
    localRoot: env.TUVA_LOCAL_ROOT ?? "/Users/evanwilliams/Desktop/Khoomei/Videos",
    externalRoot: env.TUVA_EXTERNAL_ROOT,
    ffmpeg: findBin("ffmpeg"),
    ffprobe: findBin("ffprobe"),
    cwebp: findBin("cwebp"),
    openTab: env.TUVA_NO_OPEN !== "1",
    migrationsDir: join(import.meta.dir, "..", "..", "migrations"),
    webDir: join(import.meta.dir, "..", "web"),
  };
}
