#!/usr/bin/env bun
// `bun run studio-match [--cached]`: re-read the Music.app library (or use the cached dump with --cached), run the Studio
// matcher over every Mirror Track and report the hit rate. Honours TUVA_DATA_DIR. Writes Suggested `studio_track` rows
// exactly as the import hook does; never touches Music.app beyond the read-only dump.
import { loadConfig } from "../config";
import { checkpoint, openDb } from "../db";
import { initLog } from "../log";
import { DumpCache } from "./dump";
import { applyMatches } from "./match";

const cfg = loadConfig();
initLog(cfg.logPath);
const db = openDb(cfg.dbPath, cfg.migrationsDir);
try {
  const dump = new DumpCache(cfg.studioDumpPath);
  let file = process.argv.includes("--cached") ? dump.peek() : null;
  if (!file) file = await dump.refresh(true);
  const s = applyMatches(db, file.tracks);
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
  const bySong = db.query("SELECT COUNT(DISTINCT song_id) n FROM mirror_track WHERE song_id IS NOT NULL").get() as { n: number };
  console.log(`dump: ${file.tracks.length} tracks, read in ${file.ms} ms (${file.takenAt})`);
  console.log(`Mirror Tracks: ${s.tracks}, of which ${s.withSong} have a Song (only those can hold a Studio track)`);
  console.log(`  matched:     ${s.matched.total} (${pct(s.matched.total, s.tracks)})  single ${s.matched.single}, by duration ${s.matched.duration}, by artist ${s.matched.artist}`);
  console.log(`  offered:     ${s.offered.total} (${pct(s.offered.total, s.tracks)})  name-only ${s.offered.nameOnly}, ambiguous ${s.offered.ambiguous}  (never auto-matched)`);
  console.log(`  no hit:      ${s.none} (${pct(s.none, s.tracks)})`);
  console.log(`rows: +${s.inserted} inserted, ${s.updated} updated, ${s.dropped} dropped, ${s.absorbed} absorbed, ${s.demoted} demoted, ${s.stale} stale, ${s.rejectedSkipped} rejected-skipped`);
  console.log(`Studio tracks now: ${s.studioRows}; Songs with at least one: ${s.songsWithStudio} of ${bySong.n} Songs that have Tracks`);
} catch (e) {
  console.error(`studio-match failed: ${(e as Error).message ?? e}`);
  process.exitCode = 1;
} finally {
  checkpoint(db);
  db.close();
}
