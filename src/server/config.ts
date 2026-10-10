import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  dataDir: string;
  dbPath: string;
  thumbsDir: string;
  remuxDir: string;
  logPath: string;
  port: number;
  localRoot: string;
  externalRoot: string;
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
    logPath: join(dataDir, "log.txt"),
    port: Number(env.TUVA_PORT ?? 4400),
    localRoot: env.TUVA_LOCAL_ROOT ?? "/Users/evanwilliams/Desktop/Khoomei/Videos",
    externalRoot: env.TUVA_EXTERNAL_ROOT ?? "/Volumes/General/хөөмей/Хөөмей",
    ffmpeg: findBin("ffmpeg"),
    ffprobe: findBin("ffprobe"),
    cwebp: findBin("cwebp"),
    openTab: env.TUVA_NO_OPEN !== "1",
    migrationsDir: join(import.meta.dir, "..", "..", "migrations"),
    webDir: join(import.meta.dir, "..", "web"),
  };
}
