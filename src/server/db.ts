import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./log";

export type Db = Database;

/** Numbered migrations `NNNN_name.sql`, in number order (files sharing a number, from branches merged side by side, in name order). */
export function migrationFiles(dir: string): { version: number; name: string; file: string }[] {
  return readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.split("_")[0]), name: f, file: join(dir, f) }))
    .sort((a, b) => a.version - b.version);
}

const ALREADY = /already exists|duplicate column/i;
/** A migration that rebuilds a table other tables point at opens with this line (SQLite's 12-step table rebuild). */
const FK_OFF = /^-- foreign_keys: off\b/m;

/**
 * Applies every migration file not yet recorded in the `migration` table (one row per file name), in order.
 * `PRAGMA user_version` still tracks the highest number applied, for readers of older databases.
 *
 * Before the table existed, user_version alone recorded progress, and two branches merged with the same number
 * (0008_local_songs + 0008_loop) could leave a database past 8 with only one of them applied. A database with no
 * rows and a user_version above 0 is bootstrapped once: every file numbered at or below user_version is tried, and
 * one that fails only because its objects already exist is recorded as applied (each file opens with a CREATE or an
 * ALTER ... ADD COLUMN, so a re-run stops on its first statement and changes nothing).
 */
export function migrate(db: Db, dir: string): number {
  db.exec("CREATE TABLE IF NOT EXISTS migration (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  const done = new Set((db.query("SELECT name FROM migration").all() as { name: string }[]).map((r) => r.name));
  const legacy = done.size === 0 && current > 0;
  const record = db.prepare("INSERT OR IGNORE INTO migration (name, applied_at) VALUES (?, ?)");
  let applied = current;
  for (const m of migrationFiles(dir)) {
    if (done.has(m.name)) continue;
    const sql = readFileSync(m.file, "utf8");
    // foreign_keys can only change outside a transaction; the rebuild is checked before COMMIT instead
    const fkOff = FK_OFF.test(sql);
    if (fkOff) db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      if (fkOff && db.query("PRAGMA foreign_key_check").all().length) throw new Error("foreign key check failed after the rebuild");
      if (m.version > applied) db.exec(`PRAGMA user_version = ${m.version}`);
      record.run(m.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      if (legacy && m.version <= current && ALREADY.test(String(e))) {
        record.run(m.name, new Date().toISOString());
        log(`migration ${m.name} was already applied (recorded)`);
        continue;
      }
      throw new Error(`migration ${m.file} failed: ${e}`);
    } finally {
      if (fkOff) db.exec("PRAGMA foreign_keys = ON");
    }
    log(`migration ${m.name} applied`);
    applied = Math.max(applied, m.version);
  }
  return applied;
}

export function openDb(path: string, migrationsDir: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db, migrationsDir);
  return db;
}

export function checkpoint(db: Db) {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    log("checkpoint failed", String(e));
  }
}
