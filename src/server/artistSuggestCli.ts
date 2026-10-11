#!/usr/bin/env bun
// `bun run suggest-artists [videoId] [--dry-run]`: the Artist matcher over the library (spec 2.3). Offline.
import { loadConfig } from "./config";
import { checkpoint, openDb } from "./db";
import { initLog, log } from "./log";
import { rebuildSearchIndex } from "./search";
import { suggestArtists } from "./artistSuggest";

if (import.meta.main) {
  const args = process.argv.slice(2);
  const id = args.find((a) => /^\d+$/.test(a));
  const cfg = loadConfig();
  initLog(cfg.logPath);
  const db = openDb(cfg.dbPath, cfg.migrationsDir);
  try {
    const r = suggestArtists(db, { videoId: id ? Number(id) : undefined, cacheDir: cfg.ytCacheDir, dryRun: args.includes("--dry-run") });
    log("artist matcher:", r);
    if (!args.includes("--dry-run")) rebuildSearchIndex(db);
    console.log(`${r.videos} Videos looked at: ${r.suggested} Artists suggested, ${r.cleared} old suggestions replaced, ${r.skippedCurated} curated Videos left alone${args.includes("--dry-run") ? " (dry run)" : ""}`);
  } finally {
    checkpoint(db);
    db.close();
  }
}
