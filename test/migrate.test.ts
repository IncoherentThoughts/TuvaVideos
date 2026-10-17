// The migration runner (db.ts): one row per file in `migration`, and the one-time bootstrap of a database that was
// migrated by number alone, where two files share 0008 and only one of them had been applied.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrationFiles } from "../src/server/db";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const names = () => migrationFiles(MIGRATIONS).map((m) => m.name);
const cols = (db: Database, table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const recorded = (db: Database) => (db.query("SELECT name FROM migration ORDER BY name").all() as { name: string }[]).map((r) => r.name);
const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

describe("migrate", () => {
  test("a fresh database gets every file, recorded by name, user_version at the highest number", () => {
    const db = new Database(":memory:");
    expect(migrate(db, MIGRATIONS)).toBe(14);
    expect(recorded(db)).toEqual([...names()].sort());
    expect(version(db)).toBe(14);
    expect(cols(db, "video")).toEqual(expect.arrayContaining(["loop_a_s", "view_count"]));
    expect(migrate(db, MIGRATIONS)).toBe(14); // idempotent
  });

  test("bootstrap: a database at 8 with only 0008_local_songs applied gets 0008_loop and everything after", () => {
    // Replay the old runner: files up to 0007 plus 0008_local_songs, by number only, with no migration table.
    const dir = mkdtempSync(join(tmpdir(), "tuva-mig-"));
    for (const f of readdirSync(MIGRATIONS)) if (f < "0008" || f === "0008_local_songs.sql") cpSync(join(MIGRATIONS, f), join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    db.exec("DROP TABLE migration");
    expect(version(db)).toBe(8);
    expect(cols(db, "video")).not.toContain("loop_a_s");

    expect(migrate(db, MIGRATIONS)).toBe(14);
    expect(cols(db, "video")).toEqual(expect.arrayContaining(["loop_a_s", "view_count"]));
    expect(recorded(db)).toEqual([...names()].sort());
    expect(version(db)).toBe(14);
    rmSync(dir, { recursive: true, force: true });
  });

  test("bootstrap: a database already at 9 that missed 0008_loop gets it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tuva-mig-"));
    for (const f of readdirSync(MIGRATIONS)) if (f < "0010" && f !== "0008_loop.sql") cpSync(join(MIGRATIONS, f), join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    db.exec("DROP TABLE migration");
    expect(version(db)).toBe(9);
    expect(cols(db, "video")).not.toContain("loop_a_s");
    expect(migrate(db, MIGRATIONS)).toBe(14);
    expect(cols(db, "video")).toContain("loop_a_s");
    expect(recorded(db)).toEqual([...names()].sort());
    rmSync(dir, { recursive: true, force: true });
  });

  test("0010 rebuilds video with the `title` source: rows, column values and the tables pointing at it survive", () => {
    const dir = mkdtempSync(join(tmpdir(), "tuva-mig-"));
    for (const f of readdirSync(MIGRATIONS)) if (f < "0010") cpSync(join(MIGRATIONS, f), join(dir, f));
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, dir);
    db.exec(`INSERT INTO root (id, path, kind) VALUES (1, '/r', 'local');
      INSERT INTO video (id, youtube_id, title, created_at, view_count, loop_a_s, suggestion_source) VALUES (7, 'aaaaaaaaaaa', 'T', 'x', 3, 1.5, 'performance');
      INSERT INTO copy (video_id, root_id, rel_path, size, mtime, playback) VALUES (7, 1, 'a.mkv', 1, 'x', 'native');
      INSERT INTO chapter (video_id, start_s, title, source) VALUES (7, 0, 'c', 'manual');`);
    expect(() => db.exec("UPDATE video SET suggestion_source = 'title'")).toThrow();
    expect(migrate(db, MIGRATIONS)).toBe(14);
    expect(db.query("SELECT view_count, loop_a_s, suggestion_source FROM video WHERE id = 7").get()).toEqual({ view_count: 3, loop_a_s: 1.5, suggestion_source: "performance" });
    db.exec("UPDATE video SET suggestion_source = 'title'");
    expect(() => db.exec("UPDATE video SET suggestion_source = 'bogus'")).toThrow();
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.exec("INSERT INTO copy (video_id, root_id, rel_path, size, mtime, playback) VALUES (99, 1, 'b.mkv', 1, 'x', 'native')")).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
  test("0011 strips the [instagram-…] suffix from titles and Latin titles, leaving other titles alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "tuva-mig-"));
    for (const f of readdirSync(MIGRATIONS)) if (f < "0011") cpSync(join(MIGRATIONS, f), join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    const add = db.prepare("INSERT INTO video (id, content_hash, title, title_latin, created_at) VALUES (?, ?, ?, ?, 'x')");
    add.run(1, "h1", "Video by tuva.accord [instagram-CrcH6MHo6Jm]", null);
    add.run(2, "h2", "Огбе Тывам [instagram-CZ6ySoaIWro]", "Ogbe Tyvam [instagram-CZ6ySoaIWro]");
    add.run(3, "h3", "Instagram video #CdtUBecoRUu [instagram-CdtUBecoRUu]", null);
    add.run(4, "h4", "Artery Media Project #58", null);
    add.run(5, "h5", "[instagram-ButuhuUAss-]", null);
    expect(migrate(db, MIGRATIONS)).toBe(14);
    expect(db.query("SELECT title, title_latin FROM video ORDER BY id").all()).toEqual([
      { title: "Video by tuva.accord", title_latin: null },
      { title: "Огбе Тывам", title_latin: "Ogbe Tyvam" },
      { title: "Instagram video", title_latin: null },
      { title: "Artery Media Project #58", title_latin: null },
      { title: "[instagram-ButuhuUAss-]", title_latin: null },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
  test("0013 backfills instagram_id from the Copy filenames' [instagram-…] suffix", () => {
    const dir = mkdtempSync(join(tmpdir(), "tuva-mig-"));
    for (const f of readdirSync(MIGRATIONS)) if (f < "0013") cpSync(join(MIGRATIONS, f), join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    db.exec(`INSERT INTO root (id, path, kind) VALUES (1, '/r', 'local');
      INSERT INTO video (id, content_hash, youtube_id, title, created_at) VALUES (1, 'h1', NULL, 'a', 'x'), (2, 'h2', NULL, 'b', 'x'), (3, NULL, 'aaaaaaaaaaa', 'c', 'x');
      INSERT INTO copy (video_id, root_id, rel_path, size, mtime, playback) VALUES
        (1, 1, 'Batch 10/Video by sayus_magas [instagram-DdvnmbnIWMa].mkv', 1, 'x', 'native'),
        (2, 1, 'Chas-Adyr.mp4', 1, 'x', 'native'),
        (3, 1, 'c [aaaaaaaaaaa].webm', 1, 'x', 'native');`);
    expect(migrate(db, MIGRATIONS)).toBe(14);
    expect(db.query("SELECT id, instagram_id FROM video ORDER BY id").all()).toEqual([
      { id: 1, instagram_id: "DdvnmbnIWMa" },
      { id: 2, instagram_id: null },
      { id: 3, instagram_id: null },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});
