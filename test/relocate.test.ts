// Relocating a Copy (Now playing's folder button): the parts that need no ffprobe.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { relocateCopy, rootFor } from "../src/server/relocate";
import { insertChapter, insertCopy, insertVideo, V } from "./helpers/seed";

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
  insertVideo(db, { id: 1, youtube_id: "aaaaaaaaaaa", title: "Kept", created_at: "x", favorited_at: "x", thumbnail_copy_id: 10 });
  insertVideo(db, { id: 2, content_hash: "h2", title: "Stray", created_at: "x" });
  insertCopy(db, { id: 10, video_id: 1, root_id: 1, rel_path: "old/Song [aaaaaaaaaaa].mp4", mtime: "x", missing_since: "x" });
  insertCopy(db, { id: 20, video_id: 2, root_id: 1, rel_path: "moved/Song.mp4", mtime: "x" });
  insertChapter(db, { id: 5, video_id: 2, start_s: 0, title: "c", source: "manual" });
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
    expect(await relocateCopy(db, cfg, roots, V(1), { path: join(dir, "outside.mp4") })).toMatchObject({ ok: false, status: 400 });
    expect(await relocateCopy(db, cfg, roots, V(1), { path: join(dir, "nope.mp4") })).toMatchObject({ ok: false, status: 404 });
    expect(await relocateCopy(db, cfg, roots, V(1), { path: "lib/x.mp4" })).toMatchObject({ ok: false, status: 400 });
  });

  test("a file another Video owns needs merge; merging keeps this Video and drops the stray one", async () => {
    const { db, roots, lib } = setup();
    const path = join(lib, "moved", "Song.mp4");
    expect(await relocateCopy(db, cfg, roots, V(1), { path })).toMatchObject({ ok: false, status: 409, conflict: { videoId: V(2), title: "Stray" } });
    expect(await relocateCopy(db, cfg, roots, V(1), { path, merge: true })).toEqual({ ok: true, value: { copyId: 20, rootId: 1 } });
    expect(db.query("SELECT id, video_id FROM copy").all()).toEqual([{ id: 20, video_id: V(1) }]);
    expect(db.query("SELECT id FROM videos").all()).toEqual([{ id: V(1) }]);
    expect(db.query("SELECT COUNT(*) n FROM video_chapters").get()).toEqual({ n: 0 });
    expect(db.query("SELECT favorited_at, thumbnail_copy_id FROM video_full WHERE id = ?").get(V(1))).toEqual({ favorited_at: "x", thumbnail_copy_id: 20 });
  });
});
