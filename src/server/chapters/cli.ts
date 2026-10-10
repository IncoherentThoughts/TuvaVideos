#!/usr/bin/env bun
// `bun run suggest-chapters [ids] [--dry-run] [--verbose] [--linked 0.8] [--mirror 0.9] [--near-tie 0.05]` (spec 8, stage 2).
// Offline. Ids are library Video ids or YouTube ids. Honours TUVA_DATA_DIR and TUVA_YT_CACHE.
import { loadConfig } from "../config";
import { checkpoint, openDb } from "../db";
import { initLog } from "../log";
import { NEAR_TIE, TIER_LINKED, TIER_MIRROR } from "../../shared/songMatch";
import { formatReport, suggestChapters } from "./suggest";

if (import.meta.main) {
  const args = process.argv.slice(2);
  const val = (n: string, d: number) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? Number(args[i + 1]) : d;
  };
  const valueFlags = new Set(["--linked", "--mirror", "--near-tie"]);
  const only = args.filter((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1] ?? ""));
  const cfg = loadConfig();
  initLog(cfg.logPath);
  const db = openDb(cfg.dbPath, cfg.migrationsDir);
  try {
    const r = suggestChapters(db, {
      cacheDir: cfg.ytCacheDir,
      only,
      dryRun: args.includes("--dry-run"),
      thresholds: { linked: val("linked", TIER_LINKED), mirror: val("mirror", TIER_MIRROR), nearTie: val("near-tie", NEAR_TIE) },
    });
    console.log(formatReport(r, args.includes("--verbose")));
  } finally {
    checkpoint(db);
    db.close();
  }
}
