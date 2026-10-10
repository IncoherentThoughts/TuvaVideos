import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./log";

export type Db = Database;

/** Numbered migrations `NNNN_name.sql`; the highest applied number lives in PRAGMA user_version. */
export function migrationFiles(dir: string): { version: number; file: string }[] {
  return readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => ({ version: Number(f.split("_")[0]), file: join(dir, f) }))
    .sort((a, b) => a.version - b.version);
}

export function migrate(db: Db, dir: string): number {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  let applied = current;
  for (const m of migrationFiles(dir)) {
    if (m.version <= current) continue;
    const sql = readFileSync(m.file, "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.file} failed: ${e}`);
    }
    log(`migration ${m.version} applied`);
    applied = m.version;
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
