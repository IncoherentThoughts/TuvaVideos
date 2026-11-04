// Scanner robustness (audit DB-1, DB-2, DB-3, DB-4, DB-8, DB-11), on tiny ffmpeg-made files in temp dirs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/server/db";
import { createLocalSong } from "../src/server/localSongs";
import { Roots } from "../src/server/roots";
import { Scanner } from "../src/server/scan";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const { ffmpeg, ffprobe } = loadConfig({});
const base = mkdtempSync(join(tmpdir(), "tuva-scanrob-"));
const A = join(base, "a.mp4");
const B = join(base, "b.mkv");

async function ff(...args: string[]) {
  const p = Bun.spawn([ffmpeg, "-v", "error", "-y", ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}

beforeAll(async () => {
  await ff("-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", A);
  await ff("-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", B);
}, 30_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

function env() {
  const dir = mkdtempSync(join(base, "run-"));
  const lib = join(dir, "lib");
  mkdirSync(lib);
  const db = openDb(":memory:", MIGRATIONS);
  const cfg = { ffprobe, thumbsDir: join(dir, "thumbs"), remuxDir: join(dir, "remux"), ytCacheDir: join(dir, "yt"), localRoot: lib };
  const roots = new Roots(db, cfg);
  roots.seed();
  const scanner = new Scanner(db, cfg, roots, () => {});
  const scan = () => scanner.scanRoot(roots.get(1)!);
  const copies = () => db.query("SELECT id, video_id, rel_path, missing_since, content_hash FROM copy ORDER BY id").all() as any[];
  return { dir, lib, db, roots, scanner, scan, copies, cfg };
}

describe("scanning", () => {
  test("an emptied mount point (drive unmounted, fresh process) marks nothing Missing (DB-1)", async () => {
    const { lib, db, cfg, copies, scan } = env();
    copyFileSync(A, join(lib, "One [aaaaaaaaaaa].mp4"));
    copyFileSync(B, join(lib, "Two.mkv"));
    expect((await scan())!.newCopies).toBe(2);
    for (const f of readdirSync(lib)) rmSync(join(lib, f));
    const roots = new Roots(db, cfg); // after a restart nothing is learned about the device
    const s = await new Scanner(db, cfg, roots, () => {}).scanRoot(roots.get(1)!);
    expect(s).toBeNull(); // not available: the scan changes nothing
    expect(copies().every((c) => c.missing_since === null)).toBe(true);
  });

  test("a decomposed (NFD) filename is added under its on-disk spelling and opens (DB-2)", async () => {
    const { lib, copies, scan } = env();
    const nfd = "Кӧмей [aaaaaaaaaaa].mp4".normalize("NFD");
    expect(nfd).not.toBe(nfd.normalize("NFC"));
    copyFileSync(A, join(lib, nfd));
    const s = (await scan())!;
    expect(s.probeFailed).toBe(0);
    expect(s.newCopies).toBe(1);
    expect(copies()[0].rel_path).toBe(nfd);
    expect((await scan())!.updatedCopies).toBe(0); // stable on the next scan
  });

  test("two rows for two spellings of one file: the extra row is marked Missing, not left as a phantom (DB-2)", async () => {
    const { lib, db, copies, scan } = env();
    const nfc = "Хөөмей [aaaaaaaaaaa].mp4".normalize("NFC");
    copyFileSync(A, join(lib, nfc));
    await scan();
    const [row] = copies();
    db.query("INSERT INTO copy (video_id, root_id, rel_path, size, mtime, playback) SELECT video_id, root_id, ?, size, mtime, playback FROM copy WHERE id = ?").run(nfc.normalize("NFD"), row.id);
    const s = (await scan())!;
    expect(s.markedMissing).toBe(1);
    const rows = copies();
    expect(rows.find((c) => c.rel_path === nfc).missing_since).toBeNull();
    expect(rows.find((c) => c.rel_path !== nfc).missing_since).not.toBeNull();
  });

  test("an id-less file that changed in place carries its Video's identity along: an identical copy joins it (DB-3)", async () => {
    const { lib, db, copies, scan } = env();
    const f = join(lib, "Concert.mkv");
    copyFileSync(A, f); // what a scan saw first (a half-copied file, or the old footage)
    await scan();
    copyFileSync(B, f);
    await scan();
    const vid = db.query("SELECT id, content_hash FROM videos").all() as any[];
    expect(vid.length).toBe(1);
    expect(vid[0].content_hash).toBe(copies()[0].content_hash);
    mkdirSync(join(lib, "backup"));
    copyFileSync(B, join(lib, "backup", "Concert.mkv"));
    await scan();
    expect((db.query("SELECT COUNT(*) AS n FROM videos").get() as any).n).toBe(1);
    expect(copies().length).toBe(2);
  });

  test("a changed file whose new bytes belong to another Video leaves both identities alone (DB-3)", async () => {
    const { lib, db, scan } = env();
    copyFileSync(A, join(lib, "one.mp4"));
    copyFileSync(B, join(lib, "two.mkv"));
    await scan();
    const before = db.query("SELECT id, content_hash FROM videos ORDER BY id").all();
    copyFileSync(B, join(lib, "one.mp4"));
    await scan();
    expect(db.query("SELECT id, content_hash FROM videos ORDER BY id").all()).toEqual(before);
  });

  test("new Videos get their Song suggestion from the batched pass (DB-4)", async () => {
    const { lib, db, scan } = env();
    expect(createLocalSong(db, { name: "Ösküs Urug" }).ok).toBe(true);
    copyFileSync(A, join(lib, "Ösküs Urug [aaaaaaaaaaa].mp4"));
    copyFileSync(B, join(lib, "Something else.mkv"));
    await scan();
    const v = db.query("SELECT song_id, suggestion_source FROM videos WHERE youtube_id = 'aaaaaaaaaaa'").get() as any;
    expect(v.song_id).toBeTruthy();
    expect(v.suggestion_source).toBe("title");
  });

  test("symlinks are counted, not silently dropped (DB-8)", async () => {
    const { dir, lib, scan } = env();
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    copyFileSync(A, join(elsewhere, "Linked [bbbbbbbbbbb].mp4"));
    symlinkSync(join(elsewhere, "Linked [bbbbbbbbbbb].mp4"), join(lib, "Linked [bbbbbbbbbbb].mp4"));
    symlinkSync(elsewhere, join(lib, "linkdir"));
    const s = (await scan())!;
    expect(s.skippedSymlinks).toBe(2);
    expect(s.newCopies).toBe(0);
  });

  test("files of a deleted Video are counted as skipped (DB-11)", async () => {
    const { lib, db, scan } = env();
    db.query("INSERT INTO deleted_video (youtube_id, content_hash, title, deleted_at) VALUES ('ccccccccccc', NULL, 't', 'x')").run();
    copyFileSync(A, join(lib, "Gone [ccccccccccc].mp4"));
    writeFileSync(join(lib, "readme.txt"), "x");
    const s = (await scan())!;
    expect(s.skippedDeleted).toBe(1);
    expect(s.newCopies).toBe(0);
  });
});
