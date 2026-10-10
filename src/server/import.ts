#!/usr/bin/env bun
// `bun run import <backup-dir>`: Mirror import (spec 2.4). Wipe-and-replace the Mirror in one transaction, then the
// follow-ups: Performance defaults for existing Videos (spec 2.3), the Latin-title fill (2.5), the search rebuild (6.1)
// and the Studio matcher hook (a no-op until ticket #27). Honours TUVA_DATA_DIR. Never writes to the backup.
import { loadConfig } from "./config";
import { checkpoint, openDb, type Db } from "./db";
import { applyPerformanceDefaults, type DefaultsStats } from "./defaults";
import { fillLatinTitles, type LatinFillStats } from "./latin";
import { initLog, log } from "./log";
import { BackupError, importMirror, type MirrorImportResult } from "./mirror";
import { rebuildSearchIndex, type IndexStats } from "./search";
import { runStudioMatcher } from "./studio";

export interface ImportRun {
  mirror: MirrorImportResult;
  defaults: DefaultsStats;
  latin: LatinFillStats;
  index: IndexStats;
  totalMs: number;
}

/** Import plus every follow-up, in the order that lets each see the previous one's rows. */
export async function runImport(db: Db, backupDir: string): Promise<ImportRun> {
  const t0 = performance.now();
  const mirror = importMirror(db, backupDir);
  const defaults = applyPerformanceDefaults(db);
  const latin = fillLatinTitles(db); // after the defaults: a Video that just got a Song may now have an archive spelling
  const index = rebuildSearchIndex(db); // after the Latin titles: they are part of the indexed text
  await runStudioMatcher(db);
  return { mirror, defaults, latin, index, totalMs: Math.round(performance.now() - t0) };
}

export function printRun(r: ImportRun) {
  const c = r.mirror.counts;
  log(`imported ${r.mirror.backupName} in ${r.mirror.ms} ms (import #${r.mirror.importId})`);
  log("rows:", c);
  log("skipped:", r.mirror.skipped);
  log(`dangling refs: ${r.mirror.dangling.total}`, r.mirror.dangling);
  log("performance defaults:", r.defaults);
  log("latin titles:", r.latin);
  log(`search index: ${r.index.total} rows`, r.index, `${r.index.ms} ms`);
  log(`total ${r.totalMs} ms`);
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir || dir.startsWith("-")) {
    console.error("usage: bun run import <backup-dir>   (a post-migration-126 archive backup, e.g. supabase_backup_20261007_162813_no_media)");
    process.exit(2);
  }
  const cfg = loadConfig();
  initLog(cfg.logPath);
  const db = openDb(cfg.dbPath, cfg.migrationsDir);
  try {
    printRun(await runImport(db, dir));
  } catch (e) {
    console.error(e instanceof BackupError ? `import refused: ${e.message}` : `import failed (nothing was changed): ${e}`);
    process.exitCode = 1;
  } finally {
    checkpoint(db);
    db.close();
  }
}
