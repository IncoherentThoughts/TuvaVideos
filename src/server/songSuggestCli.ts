#!/usr/bin/env bun
// `bun run suggest-songs [videoId] [--dry-run] [-v]`: the Song matcher on Video titles over the library (spec 2.3). Offline.
import { loadConfig } from "./config";
import { checkpoint, openDb } from "./db";
import { fillLatinTitles } from "./latin";
import { initLog, log } from "./log";
import { rebuildSearchIndex } from "./search";
import { suggestSongsFromTitles, type SongSuggestRow } from "./songSuggest";

if (import.meta.main) {
  const args = process.argv.slice(2);
  const id = args.find((a) => /^\d+$/.test(a));
  const dryRun = args.includes("--dry-run");
  const cfg = loadConfig();
  initLog(cfg.logPath);
  const db = openDb(cfg.dbPath, cfg.migrationsDir);
  try {
    const report: SongSuggestRow[] = [];
    const r = suggestSongsFromTitles(db, { videoId: id || undefined, dryRun, report });
    log("songs from titles:", r);
    if (!dryRun) {
      fillLatinTitles(db);
      rebuildSearchIndex(db);
    }
    if (args.includes("-v")) for (const x of report) console.log(`${x.score.toFixed(3)}  ${x.title}  =>  ${x.song}  [${x.window}]`);
    console.log(`${r.videos} Videos looked at: ${r.suggested} Songs suggested (${r.changed} new or changed), ${r.cleared} old suggestions cleared${dryRun ? " (dry run)" : ""}`);
  } finally {
    checkpoint(db);
    db.close();
  }
}
