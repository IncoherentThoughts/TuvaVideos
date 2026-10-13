#!/usr/bin/env bun
// Indexes the keyframes of every Copy on a mounted Root that has none yet (spec 4.1), so keyframe seeks are instant
// from the first play instead of after the lazy index the Player asks for. One ffprobe per Copy, one at a time, no
// decode: a few seconds per file. Stop with Ctrl-C and run again later; finished Copies are kept.
//
//   bun run index-keyframes
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/server/db";
import { KeyframeIndex } from "../src/server/keyframes";
import { Roots } from "../src/server/roots";

const cfg = loadConfig(process.env);
const db = openDb(cfg.dbPath, cfg.migrationsDir);
const roots = new Roots(db, cfg);
roots.seed();
await roots.pollAll();
const idx = new KeyframeIndex(db, cfg, (id) => roots.isAvailable(id));
let n = 0, failed = 0;
process.on("SIGINT", () => { idx.shutdown(); console.log(`\nstopped after ${n} (${failed} failed)`); db.close(); process.exit(0); });
const total = await idx.indexAll((id, ok, ms) => {
  n++;
  if (!ok) failed++;
  process.stdout.write(`\r${n} indexed (${failed} failed), copy ${id} in ${(ms / 1000).toFixed(1)}s   `);
});
console.log(`\n${total} Copies needed an index; ${n} done, ${failed} failed`);
db.close();
