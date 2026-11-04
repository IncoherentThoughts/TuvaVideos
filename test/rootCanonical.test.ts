// Root paths are canonical, the first Root cannot be added twice, and relocate sees through symlinks (audit DB-13).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { relocateCopy } from "../src/server/relocate";
import { checkRootPath } from "../src/server/rootSetup";
import { Roots } from "../src/server/roots";
import { insertCopy, insertVideo, V } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const base = mkdtempSync(join(tmpdir(), "tuva-rootcanon-"));
const real = join(base, "Real");
const link = join(base, "link");
mkdirSync(real);
writeFileSync(join(real, "moved.mp4"), "x");
symlinkSync(real, link);
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("Root paths", () => {
  test("a Root typed through a symlink is stored by its real path", async () => {
    expect(await checkRootPath(link, "/h")).toEqual({ ok: true, path: real });
    expect(await checkRootPath(`${link}/`, "/h")).toEqual({ ok: true, path: real });
  });

  test("the whole disk is refused", async () => {
    expect(await checkRootPath("/", "/h")).toEqual({ ok: false, error: "Choose a folder, not the whole disk" });
  });

  test("the first Root is added once even when two requests race", () => {
    const db = openDb(":memory:", MIGRATIONS);
    const roots = new Roots(db, {});
    expect(roots.addFirst(real)?.path).toBe(real);
    expect(roots.addFirst(join(base, "other"))).toBeNull();
    expect(roots.list().length).toBe(1);
  });

  test("relocate finds the Root of a file given by its real path when the Root was recorded through a symlink", async () => {
    const db = openDb(":memory:", MIGRATIONS);
    db.query("INSERT INTO root (id, path, kind) VALUES (1, ?, 'local')").run(link);
    insertVideo(db, { id: 1, youtube_id: "aaaaaaaaaaa", title: "T", created_at: "x" });
    insertCopy(db, { id: 10, video_id: 1, root_id: 1, rel_path: "old.mp4", mtime: "x", missing_since: "x" });
    insertCopy(db, { id: 11, video_id: 1, root_id: 1, rel_path: "moved.mp4", mtime: "x" });
    const r = await relocateCopy(db, { ffprobe: "/nonexistent", remuxDir: base }, [{ id: 1, path: link, kind: "local" }], V(1), { path: join(real, "moved.mp4"), copyId: 10 });
    expect(r).toMatchObject({ ok: true, value: { copyId: 11, rootId: 1 } });
  });
});
