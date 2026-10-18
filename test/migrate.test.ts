// The migration runner (db.ts): one row per file in `migration`, and the one-time bootstrap of a database that was
// migrated by number alone, where two files share 0008 and only one of them had been applied.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrationFiles } from "../src/server/db";
import { V } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const LATEST = 18;
const names = () => migrationFiles(MIGRATIONS).map((m) => m.name);
const cols = (db: Database, table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const recorded = (db: Database) => (db.query("SELECT name FROM migration ORDER BY name").all() as { name: string }[]).map((r) => r.name);
const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

describe("migrate", () => {
  test("a fresh database gets every file, recorded by name, user_version at the highest number", () => {
    const db = new Database(":memory:");
    expect(migrate(db, MIGRATIONS)).toBe(LATEST);
    expect(recorded(db)).toEqual([...names()].sort());
    expect(version(db)).toBe(LATEST);
    expect(cols(db, "video_local")).toEqual(expect.arrayContaining(["loop_a_s", "view_count"]));
    expect(migrate(db, MIGRATIONS)).toBe(LATEST); // idempotent
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

    expect(migrate(db, MIGRATIONS)).toBe(LATEST);
    expect(cols(db, "video_local")).toEqual(expect.arrayContaining(["loop_a_s", "view_count"]));
    expect(recorded(db)).toEqual([...names()].sort());
    expect(version(db)).toBe(LATEST);
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
    expect(migrate(db, MIGRATIONS)).toBe(LATEST);
    expect(cols(db, "video_local")).toContain("loop_a_s");
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
    expect(migrate(db, MIGRATIONS)).toBe(LATEST);
    expect(db.query("SELECT view_count, loop_a_s, suggestion_source FROM video_full WHERE id = ?").get(V(7))).toEqual({ view_count: 3, loop_a_s: 1.5, suggestion_source: "performance" });
    db.exec("UPDATE videos SET suggestion_source = 'title'");
    expect(() => db.exec("UPDATE videos SET suggestion_source = 'bogus'")).toThrow();
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.exec("INSERT INTO copy (video_id, root_id, rel_path, size, mtime, playback) VALUES ('99', 1, 'b.mkv', 1, 'x', 'native')")).toThrow();
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
    expect(migrate(db, MIGRATIONS)).toBe(LATEST);
    expect(db.query("SELECT title, title_latin FROM videos ORDER BY id").all()).toEqual([
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
    expect(migrate(db, MIGRATIONS)).toBe(LATEST);
    expect(db.query("SELECT id, instagram_id FROM videos ORDER BY id").all()).toEqual([
      { id: V(1), instagram_id: "DdvnmbnIWMa" },
      { id: V(2), instagram_id: null },
      { id: V(3), instagram_id: null },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("0015 moves the library onto uuid keys with the deterministic map, the side tables and the archive_* tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "tuva-mig-"));
    for (const f of readdirSync(MIGRATIONS)) if (f < "0015") cpSync(join(MIGRATIONS, f), join(dir, f));
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, dir);
    db.exec(`INSERT INTO root (id, path, kind) VALUES (1, '/r', 'local');
      INSERT INTO video (id, youtube_id, content_hash, title, title_latin, title_latin_source, type, song_id, created_at, favorited_at, resume_s, view_count, loop_a_s, loop_b_s, thumbnail_generated_at, thumbnail_copy_id, strip_frames)
        VALUES (7, 'aaaaaaaaaaa', NULL, 'Алаш', 'Alash', 'table', 'song', 's1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 12.5, 3, 1, 2, '2026-01-02T00:00:00Z', 70, 100),
               (1234, NULL, 'h2', 'Other', NULL, NULL, 'other', NULL, '2026-01-03T00:00:00Z', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL);
      INSERT INTO copy (id, video_id, root_id, rel_path, size, mtime, playback) VALUES (70, 7, 1, 'a [aaaaaaaaaaa].mkv', 1, 'x', 'native'), (71, 1234, 1, 'b.mp4', 1, 'x', 'native');
      INSERT INTO artist (id, mirror_id, name, name_latin, name_latin_source) VALUES (1, 'a0000000-0000-4000-8000-000000000001', 'Алаш', 'Alash', 'table'), (3, NULL, 'Radik', NULL, NULL);
      INSERT INTO video_artist (video_id, artist_id, position, suggested) VALUES (7, 1, 0, 0), (7, 3, 1, 1);
      INSERT INTO artist_rejection (video_id, artist_id, rejected_at) VALUES (1234, 3, 'r');
      INSERT INTO chapter (id, video_id, start_s, title, source, favorited_at, song_id) VALUES (5, 7, 0, 'One', 'manual', '2026-03-01T00:00:00Z', 's1'), (6, 7, 60, 'Two', 'comment', NULL, NULL);
      INSERT INTO chapter_rejection (video_id, source, start_s) VALUES (7, 'comment', 90);
      INSERT INTO video_audio (video_id, state, updated_at) VALUES (7, '{}', 'u');
      INSERT INTO mirror_song (id, name, slug) VALUES ('s1', 'Song', 'song');
      INSERT INTO mirror_artist (id, name, is_hidden, is_various_artists) VALUES ('a0000000-0000-4000-8000-000000000001', 'Алаш', 0, 0);
      INSERT INTO mirror_import (backup_name, imported_at, row_counts, dangling_refs) VALUES ('b', 'x', '{}', 0);`);
    expect(migrate(db, MIGRATIONS)).toBe(LATEST);
    const one = (sql: string, ...p: any[]) => db.query(sql).get(...p) as any;
    const all = (sql: string, ...p: any[]) => db.query(sql).all(...p) as any[];
    // the map is printf('76696400-0000-8000-8000-%012x', id), the same as legacyUuid
    expect(all("SELECT id FROM videos ORDER BY id").map((r) => r.id)).toEqual([V(7), V(1234)]);
    expect(V(1234)).toBe("76696400-0000-8000-8000-0000000004d2");
    expect(one("SELECT title, title_latin, song_id, proposed_song_id, created_at FROM videos WHERE id = ?", V(7))).toEqual({ title: "Алаш", title_latin: "Alash", song_id: "s1", proposed_song_id: null, created_at: "2026-01-01T00:00:00Z" });
    expect(one("SELECT favorited_at, resume_s, view_count, loop_a_s, thumbnail_copy_id, strip_frames, shared, pending_share FROM video_local WHERE video_id = ?", V(7)))
      .toEqual({ favorited_at: "2026-02-01T00:00:00Z", resume_s: 12.5, view_count: 3, loop_a_s: 1, thumbnail_copy_id: 70, strip_frames: 100, shared: 0, pending_share: 0 });
    expect(all("SELECT id, video_id FROM copy ORDER BY id")).toEqual([{ id: 70, video_id: V(7) }, { id: 71, video_id: V(1234) }]);
    expect(all("SELECT id, title FROM video_chapters ORDER BY start_s")).toEqual([{ id: "63687000-0000-8000-8000-000000000005", title: "One" }, { id: "63687000-0000-8000-8000-000000000006", title: "Two" }]);
    expect(all("SELECT chapter_id, favorited_at FROM chapter_local")).toEqual([{ chapter_id: "63687000-0000-8000-8000-000000000005", favorited_at: "2026-03-01T00:00:00Z" }]);
    expect(all("SELECT id, name FROM local_artist")).toEqual([{ id: "61727400-0000-8000-8000-000000000003", name: "Radik" }]);
    expect(all("SELECT artist_id, position, suggested FROM video_artists WHERE video_id = ? ORDER BY position", V(7))).toEqual([
      { artist_id: "a0000000-0000-4000-8000-000000000001", position: 0, suggested: 0 },
      { artist_id: "61727400-0000-8000-8000-000000000003", position: 1, suggested: 1 },
    ]);
    expect(all("SELECT id, name, name_latin, kind FROM artist_all ORDER BY kind")).toEqual([
      { id: "a0000000-0000-4000-8000-000000000001", name: "Алаш", name_latin: "Alash", kind: "archive" },
      { id: "61727400-0000-8000-8000-000000000003", name: "Radik", name_latin: null, kind: "local" },
    ]);
    expect(all("SELECT video_id, artist_id FROM video_artist_rejections")).toEqual([{ video_id: V(1234), artist_id: "61727400-0000-8000-8000-000000000003" }]);
    expect(all("SELECT video_id, source, start_s FROM video_chapter_rejections")).toEqual([{ video_id: V(7), source: "comment", start_s: 90 }]);
    expect(all("SELECT video_id FROM video_audio")).toEqual([{ video_id: V(7) }]);
    expect(all("SELECT id, kind FROM song_all")).toEqual([{ id: "s1", kind: "archive" }]);
    expect(one("SELECT value FROM meta WHERE key = 'shared_schema'")).toEqual({ value: "1" });
    for (const gone of ["video", "chapter", "artist", "video_artist", "chapter_rejection", "artist_rejection", "mirror_import", "mirror_song"])
      expect(one("SELECT 1 AS x FROM sqlite_master WHERE name = ?", gone)).toBeNull();
    expect(one("SELECT favorited_at, song_id FROM chapter_full WHERE start_s = 0")).toEqual({ favorited_at: "2026-03-01T00:00:00Z", song_id: "s1" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    // a local edit stamps updated_at; an apply that sets it keeps its value
    db.exec("UPDATE videos SET updated_at = '2000-01-01T00:00:00Z' WHERE id = '" + V(7) + "'");
    expect(one("SELECT updated_at FROM videos WHERE id = ?", V(7)).updated_at).toBe("2000-01-01T00:00:00Z");
    db.exec("UPDATE videos SET title = 'x' WHERE id = '" + V(7) + "'");
    expect(one("SELECT updated_at FROM videos WHERE id = ?", V(7)).updated_at > "2026").toBe(true);
    // deleting a Video takes its children and side rows with it
    db.exec("DELETE FROM copy WHERE video_id = '" + V(7) + "'");
    db.exec("DELETE FROM videos WHERE id = '" + V(7) + "'");
    for (const t of ["video_chapters", "chapter_local", "video_artists", "video_local WHERE video_id = '" + V(7) + "'", "video_audio", "video_chapter_rejections"])
      expect(one(`SELECT COUNT(*) n FROM ${t}`).n).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("0016 backfills rutube_id from Copy filenames, strips the suffix from titles and parses rutube.ru performance URLs", () => {
    const dir = mkdtempSync(join(tmpdir(), "tuva-mig-"));
    for (const f of readdirSync(MIGRATIONS)) if (f < "0016") cpSync(join(MIGRATIONS, f), join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    const R = "bb61c508e432598c4b7fe4542b5ee204";
    const add = db.prepare("INSERT INTO videos (id, content_hash, title, title_latin, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', 'x')");
    add.run(V(1), "h1", `№ 228. Артыы-Сайыр [rutube-${R}]`, `No 228. Artyy-Saiyr [rutube-${R}]`);
    add.run(V(2), "h2", "Калдак-Хамар", null);
    add.run(V(3), "h3", "Plain", null);
    add.run(V(4), "h4", "[rutube-a555f5d081a84ab8bdb2e97107f82d2d]", null);
    db.exec(`INSERT INTO root (id, path, kind) VALUES (1, '/r', 'local');
      INSERT INTO copy (video_id, root_id, rel_path, size, mtime, playback) VALUES
        ('${V(1)}', 1, 'Batch 8/№ 228 [rutube-${R}].mp4', 1, 'x', 'native'),
        ('${V(2)}', 1, 'Batch 8/Калдак-Хамар [rutube-A555F5D081A84AB8BDB2E97107F82D2D].mp4', 1, 'x', 'native'),
        ('${V(3)}', 1, 'Plain [rutube-short].mp4', 1, 'x', 'native');
      INSERT INTO archive_song (id, name, slug) VALUES ('s1', 'S', 's');
      INSERT INTO archive_performance (id, song_id, url, display_order, is_highlighted) VALUES
        ('p1', 's1', 'https://rutube.ru/video/${R}/', 0, 0),
        ('p2', 's1', 'https://rutube.ru/video/52297c3e6db6942f45a89f3d1900e95c/?r=wd&t=336', 1, 0),
        ('p3', 's1', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', 2, 0);`);
    expect(migrate(db, MIGRATIONS)).toBe(LATEST);
    expect(db.query("SELECT rutube_id, title, title_latin FROM videos ORDER BY id").all()).toEqual([
      { rutube_id: R, title: "№ 228. Артыы-Сайыр", title_latin: "No 228. Artyy-Saiyr" },
      { rutube_id: "a555f5d081a84ab8bdb2e97107f82d2d", title: "Калдак-Хамар", title_latin: null },
      { rutube_id: null, title: "Plain", title_latin: null },
      { rutube_id: null, title: "[rutube-a555f5d081a84ab8bdb2e97107f82d2d]", title_latin: null }, // a title that is only the suffix stays
    ]);
    expect(db.query("SELECT id, rutube_id, start_s FROM archive_performance ORDER BY id").all()).toEqual([
      { id: "p1", rutube_id: R, start_s: null },
      { id: "p2", rutube_id: "52297c3e6db6942f45a89f3d1900e95c", start_s: 336 },
      { id: "p3", rutube_id: null, start_s: null },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});
