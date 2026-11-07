// Root availability when the sampled Copies are gone (audit DB-1): an empty mount point left behind by an unmounted
// drive is not a mounted Root, a mounted Root whose files were deleted still is, and a drive coming back after its
// Copies were marked Missing fires the remount scan.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { Roots } from "../src/server/roots";
import { insertCopy, insertVideo } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");

function setup(files = 2) {
  const dir = mkdtempSync(join(tmpdir(), "tuva-mount-"));
  const lib = join(dir, "mnt");
  mkdirSync(lib);
  const db = openDb(":memory:", MIGRATIONS);
  db.query("INSERT INTO root (id, path, kind) VALUES (1, ?, 'external')").run(lib);
  for (let i = 1; i <= files; i++) {
    insertVideo(db, { id: i, content_hash: `h${i}`, title: `T${i}`, created_at: "x" });
    insertCopy(db, { id: i, video_id: i, root_id: 1, rel_path: `f${i}.mp4`, mtime: "x" });
    writeFileSync(join(lib, `f${i}.mp4`), "x");
  }
  const roots = () => new Roots(db, {});
  return { dir, lib, db, roots };
}

const empty = (lib: string) => {
  rmSync(lib, { recursive: true, force: true });
  mkdirSync(lib);
};

describe("Roots.check with every sampled Copy gone (DB-1)", () => {
  test("an empty mount point on its parent's device is not mounted", async () => {
    const { db, lib, roots } = setup();
    expect(await roots().check(1)).toBe(true);
    empty(lib); // `umount /mnt` leaves the directory behind, empty
    db.query("DELETE FROM meta WHERE key = 'root_device:1'").run();
    const r = roots(); // a fresh process, and no device ever learned
    expect(await r.check(1)).toBe(false);
    expect(r.isAvailable(1)).toBe(false);
  });

  test("after a restart the remembered device decides: the drive's own device is gone, its leftover mount point is not mounted", async () => {
    const { db, lib, roots } = setup();
    expect(await roots().check(1)).toBe(true); // learns and stores the device
    empty(lib);
    db.query("UPDATE meta SET value = '-1' WHERE key = 'root_device:1'").run(); // as if the drive had been on another device
    expect(await roots().check(1)).toBe(false);
  });

  test("a folder Root emptied of every file is still mounted after a restart (its Copies can go Missing)", async () => {
    const { lib, roots } = setup();
    expect(await roots().check(1)).toBe(true);
    empty(lib); // every video deleted from a plain folder on the boot disk
    expect(await roots().check(1)).toBe(true); // a fresh process: the stored device matches
  });

  test("a mounted Root whose sampled files were deleted stays available when the directory holds anything", async () => {
    const { lib, roots } = setup();
    rmSync(join(lib, "f1.mp4"));
    rmSync(join(lib, "f2.mp4"));
    writeFileSync(join(lib, "notes.txt"), "x");
    expect(await roots().check(1)).toBe(true);
  });

  test("a fourth known Copy still on disk keeps the Root available", async () => {
    const { lib, roots } = setup(4);
    for (const n of [1, 2, 3]) rmSync(join(lib, `f${n}.mp4`));
    expect(await roots().check(1)).toBe(true);
  });

  test("the learned device decides: a directory on another device than the one Copies were read from is not mounted", async () => {
    const { lib, roots } = setup();
    const r = roots();
    expect(await r.check(1)).toBe(true); // learns the device
    for (const n of [1, 2]) rmSync(join(lib, `f${n}.mp4`));
    writeFileSync(join(lib, "leftover"), "x");
    expect(await r.check(1)).toBe(true); // same device: files deleted from a mounted drive
    (r as any).devices.set(1, -1); // as if the drive had been read on another device
    expect(await r.check(1)).toBe(false);
  });

  test("a drive back after its Copies were marked Missing fires onBecameAvailable once", async () => {
    const { db, lib, roots } = setup();
    db.exec("UPDATE copy SET missing_since = 'x'");
    rmSync(join(lib, "f1.mp4"));
    rmSync(join(lib, "f2.mp4"));
    const r = roots();
    const fired: number[] = [];
    r.onBecameAvailable((root) => fired.push(root.id));
    expect(await r.check(1)).toBe(true); // first check: the directory exists
    expect(fired).toEqual([1]);
    expect(await r.check(1)).toBe(true);
    expect(fired).toEqual([1]); // nothing new
    writeFileSync(join(lib, "f1.mp4"), "x"); // remounted
    expect(await r.check(1)).toBe(true);
    expect(fired).toEqual([1, 1]);
    expect(await r.check(1)).toBe(true);
    expect(fired).toEqual([1, 1]); // once
  });
});
