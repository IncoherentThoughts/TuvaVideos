#!/usr/bin/env bun
// `bun run latin-titles`: the one-time Latin-title fill (spec 2.5) on its own, then the search rebuild. Also runs
// after archive rows change. Honours TUVA_DATA_DIR. `manual` Latin titles are never regenerated.
import { loadConfig } from "./config";
import { checkpoint, openDb } from "./db";
import { fillLatinTitles } from "./latin";
import { initLog, log } from "./log";
import { rebuildSearchIndex } from "./search";

if (import.meta.main) {
  const cfg = loadConfig();
  initLog(cfg.logPath);
  const db = openDb(cfg.dbPath, cfg.migrationsDir);
  try {
    const stats = fillLatinTitles(db);
    const idx = rebuildSearchIndex(db);
    log("latin titles:", stats);
    log(`search index: ${idx.total} rows in ${idx.ms} ms`);
  } finally {
    checkpoint(db);
    db.close();
  }
}
