// Relocating a Copy (Now playing's folder button): the parts that need no ffprobe.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { relocateCopy, rootFor } from "../src/server/relocate";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const cfg = { ffprobe: "/nonexistent/ffprobe", remuxDir: "/nonexistent" };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tuva-reloc-"));
  const lib = join(dir, "lib");
  mkdirSync(join(lib, "moved"), { recursive: true });
  writeFileSync(join(lib, "moved", "Song.mp4"), "x");
  writeFileSync(join(dir, "outside.mp4"), "x");
  const db = openDb(":memory:", MIGRATIONS);
  db.query("INSERT INTO root (id, path, kind) VALUES (1, ?, 'local')").run(lib);
  db.exec(`INSERT INTO video (id, youtube_id, title, created_at, favorited_at, thumbnail_copy_id) VALUES (1, 'aaaaaaaaaaa', 'Kept', 'x', 'x', 10);
    INSERT INTO video (id, content_hash, title, created_at) VALUES (2, 'h2', 'Stray', 'x');
    INSERT INTO copy (id, video_id, root_id, rel_path, size, mtime, playback, missing_since) VALUES (10, 1, 1, 'old/Song [aaaaaaaaaaa].mp4', 1, 'x', 'native', 'x');
    INSERT INTO copy (id, video_id, root_id, rel_path, size, mtime, playback) VALUES (20, 2, 1, 'moved/Song.mp4', 1, 'x', 'native');
    INSERT INTO chapter (id, video_id, start_s, title, source) VALUES (5, 2, 0, 'c', 'manual');`);
  return { db, roots: [{ id: 1, path: lib, kind: "local" as const }], lib, dir };
}

describe("relocate a Copy", () => {
  test("rootFor picks the deepest Root holding the path", () => {
    const roots = [{ id: 1, path: "/a", kind: "local" as const }, { id: 2, path: "/a/b", kind: "external" as const }];
    expect(rootFor(roots, "/a/b/c.mp4")?.id).toBe(2);
    expect(rootFor(roots, "/a/x.mp4")?.id).toBe(1);
    expect(rootFor(roots, "/ab/x.mp4")).toBeNull();
  });

  test("refuses a file outside every Root, a missing file and a relative path", async () => {
    const { db, roots, dir } = setup();
    expect(await relocateCopy(db, cfg, roots, 1, { path: join(dir, "outside.mp4") })).toMatchObject({ ok: false, status: 400 });
    expect(await relocateCopy(db, cfg, roots, 1, { path: join(dir, "nope.mp4") })).toMatchObject({ ok: false, status: 404 });
    expect(await relocateCopy(db, cfg, roots, 1, { path: "lib/x.mp4" })).toMatchObject({ ok: false, status: 400 });
  });

  test("a file another Video owns needs merge; merging keeps this Video and drops the stray one", async () => {
    const { db, roots, lib } = setup();
    const path = join(lib, "moved", "Song.mp4");
    expect(await relocateCopy(db, cfg, roots, 1, { path })).toMatchObject({ ok: false, status: 409, conflict: { videoId: 2, title: "Stray" } });
    expect(await relocateCopy(db, cfg, roots, 1, { path, merge: true })).toEqual({ ok: true, value: { copyId: 20, rootId: 1 } });
    expect(db.query("SELECT id, video_id FROM copy").all()).toEqual([{ id: 20, video_id: 1 }]);
    expect(db.query("SELECT id FROM video").all()).toEqual([{ id: 1 }]);
    expect(db.query("SELECT COUNT(*) n FROM chapter").get()).toEqual({ n: 0 });
    expect(db.query("SELECT favorited_at, thumbnail_copy_id FROM video WHERE id = 1").get()).toEqual({ favorited_at: "x", thumbnail_copy_id: 20 });
  });
});
