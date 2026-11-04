// Relocate fixes (audit DB-2, DB-6 = PLAY-10, PLAY-9): the new file's spelling is kept, its keyframe index starts over,
// and a superseded Copy's Fallback file is removed with its row.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/server/db";
import { relocateCopy } from "../src/server/relocate";
import { insertCopy, insertVideo, V } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const { ffmpeg, ffprobe } = loadConfig({});
const base = mkdtempSync(join(tmpdir(), "tuva-relocfix-"));
const lib = join(base, "lib");
const remuxDir = join(base, "remux");
const cfg = { ffprobe, remuxDir };
const NFD = "Хөөмей.mp4".normalize("NFD");

beforeAll(async () => {
  mkdirSync(lib, { recursive: true });
  mkdirSync(remuxDir, { recursive: true });
  const p = Bun.spawn([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(lib, "Other encode.mp4")]);
  expect(await p.exited).toBe(0);
  await Bun.write(join(lib, NFD), Bun.file(join(lib, "Other encode.mp4")));
}, 30_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

function setup() {
  const db = openDb(":memory:", MIGRATIONS);
  db.query("INSERT INTO root (id, path, kind) VALUES (1, ?, 'local')").run(lib);
  insertVideo(db, { id: 1, youtube_id: "aaaaaaaaaaa", title: "Kept", created_at: "x" });
  insertCopy(db, { id: 10, video_id: 1, root_id: 1, rel_path: "old.mp4", mtime: "x", missing_since: "x", keyframes: new Uint8Array([232, 3, 0, 0]), fallback_file: "10.mkv" });
  return { db, roots: [{ id: 1, path: lib, kind: "local" as const }] };
}

describe("relocate", () => {
  test("pointing a Copy at another encode clears its keyframe index (DB-6, PLAY-10)", async () => {
    const { db, roots } = setup();
    const r = await relocateCopy(db, cfg, roots, V(1), { path: join(lib, "Other encode.mp4") });
    expect(r.ok).toBe(true);
    const row = db.query("SELECT rel_path, keyframes, fallback_file FROM copy WHERE id = 10").get() as any;
    expect(row).toEqual({ rel_path: "Other encode.mp4", keyframes: null, fallback_file: null });
  });

  test("a decomposed file name is stored as given, and found again under its NFC spelling (DB-2)", async () => {
    const { db, roots } = setup();
    expect((await relocateCopy(db, cfg, roots, V(1), { path: join(lib, NFD) })).ok).toBe(true);
    expect((db.query("SELECT rel_path FROM copy WHERE id = 10").get() as any).rel_path).toBe(NFD);
  });

  test("a Copy recorded under the NFC spelling of a decomposed file is that file's row: respelled, not duplicated (DB-2)", async () => {
    const { db, roots } = setup();
    insertCopy(db, { id: 11, video_id: 1, root_id: 1, rel_path: NFD.normalize("NFC"), mtime: "x" }); // what the old scanner stored
    const r = await relocateCopy(db, cfg, roots, V(1), { path: join(lib, NFD), copyId: 10 });
    expect(r).toMatchObject({ ok: true, value: { copyId: 11 } });
    expect(db.query("SELECT id, rel_path FROM copy").all()).toEqual([{ id: 11, rel_path: NFD }]);
  });

  test("a superseded Copy's Fallback file is removed with its row (PLAY-9)", async () => {
    const { db, roots } = setup();
    writeFileSync(join(remuxDir, "10.mkv"), "x");
    insertCopy(db, { id: 11, video_id: 1, root_id: 1, rel_path: "Other encode.mp4", mtime: "x" }); // a scan already found it
    const r = await relocateCopy(db, cfg, roots, V(1), { path: join(lib, "Other encode.mp4"), copyId: 10 });
    expect(r).toMatchObject({ ok: true, value: { copyId: 11 } });
    expect(db.query("SELECT 1 FROM copy WHERE id = 10").get()).toBeNull();
    expect(existsSync(join(remuxDir, "10.mkv"))).toBe(false);
  });
});
