// The scanner's error paths (audit BLD-6): the ones that decide whether Copies go Missing when a drive is flaky.
// A fake ffprobe answers canned JSON (or an I/O error for names listed in a file), so no media is needed; directory
// read failures are injected by replacing the scanner's readdirRetry for one folder.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/server/db";
import { Roots, type RootRow } from "../src/server/roots";
import { Scanner } from "../src/server/scan";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const base = mkdtempSync(join(tmpdir(), "tuva-scanerr-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ioList = join(base, "io-names.txt");
const ffprobe = join(base, "ffprobe");
const PROBE_JSON = JSON.stringify({
  streams: [
    { codec_type: "video", codec_name: "h264", width: 320, height: 240, r_frame_rate: "25/1" },
    { codec_type: "audio", codec_name: "aac" },
  ],
  format: { duration: "2.000000" },
});
writeFileSync(
  ffprobe,
  `#!/bin/sh
for last; do :; done
name=$(basename "$last")
if [ -f "${ioList}" ] && grep -qxF "$name" "${ioList}"; then echo "$last: Input/output error" >&2; exit 1; fi
echo '${PROBE_JSON}'
`,
);
chmodSync(ffprobe, 0o755);

let n = 0;
let db: Db;
let roots: Roots;
let scanner: Scanner;
let dirs: { thumbsDir: string; remuxDir: string; ytCacheDir: string };

const file = (root: string, rel: string, bytes = "x") => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, bytes);
  return p;
};
const copy = (rel: string) =>
  db.query("SELECT id, size, mtime, missing_since, fallback_file FROM copy WHERE rel_path = ?").get(rel) as
    | { id: number; size: number; mtime: string; missing_since: string | null; fallback_file: string | null }
    | null;
const addRoot = (path: string): RootRow => {
  mkdirSync(path, { recursive: true });
  return roots.add(path);
};

beforeEach(() => {
  const dir = join(base, `lib-${++n}`);
  dirs = { thumbsDir: join(dir, "thumbs"), remuxDir: join(dir, "remux"), ytCacheDir: join(dir, "yt") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  db = openDb(join(dir, "library.db"), MIGRATIONS);
  roots = new Roots(db, { localRoot: undefined, externalRoot: undefined } as never);
  scanner = new Scanner(db, { ffprobe, ...dirs }, roots, () => {});
  rmSync(ioList, { force: true });
});

describe("scan error paths", () => {
  test("a probe I/O error leaves an existing Copy as it was and inserts nothing for a new file", async () => {
    const root = addRoot(join(base, `r-${n}`));
    const a = file(root.path, "A [aaaaaaaaaaa].mp4");
    file(root.path, "B [bbbbbbbbbbb].mp4");
    expect(await scanner.scanRoot(root)).toMatchObject({ newCopies: 2, ioErrors: 0, probeFailed: 0 });
    const before = copy("A [aaaaaaaaaaa].mp4")!;

    writeFileSync(a, "changed bytes"); // A must be probed again ...
    file(root.path, "C [ccccccccccc].mp4");
    writeFileSync(ioList, "A [aaaaaaaaaaa].mp4\nC [ccccccccccc].mp4\n"); // ... and the drive fails for A and the new C
    const s = await scanner.scanRoot(root);
    expect(s).toMatchObject({ newCopies: 0, updatedCopies: 0, ioErrors: 2, probeFailed: 0, markedMissing: 0 });
    expect(copy("A [aaaaaaaaaaa].mp4")).toEqual(before); // old size and mtime: the next scan tries again
    expect(copy("C [ccccccccccc].mp4")).toBeNull();
    expect(copy("B [bbbbbbbbbbb].mp4")!.missing_since).toBeNull();
  }, 30_000); // probeFile retries an I/O error with a 2 s and a 4 s backoff

  test("a folder that cannot be read is named in dirErrors, and nothing under it is marked Missing", async () => {
    const root = addRoot(join(base, `r-${n}`));
    file(root.path, "sub/D [ddddddddddd].mp4");
    const gone = file(root.path, "E [eeeeeeeeeee].mp4");
    file(root.path, "F [fffffffffff].mp4"); // keeps the Root answering its availability read
    expect(await scanner.scanRoot(root)).toMatchObject({ newCopies: 3 });

    unlinkSync(join(root.path, "sub", "D [ddddddddddd].mp4")); // really gone, but the folder listing fails
    unlinkSync(gone); // gone, and its folder lists fine: this one is Missing
    const s = scanner as unknown as { readdirRetry(dir: string): Promise<unknown> };
    const real = s.readdirRetry.bind(scanner);
    s.readdirRetry = async (dir: string) => {
      if (dir.endsWith("/sub")) throw Object.assign(new Error("EIO: i/o error, scandir"), { code: "EIO" });
      return real(dir);
    };
    const summary = await scanner.scanRoot(root);
    expect(summary!.dirErrors).toEqual(["sub: EIO: i/o error, scandir"]);
    expect(summary!.markedMissing).toBe(1);
    expect(copy("sub/D [ddddddddddd].mp4")!.missing_since).toBeNull();
    expect(copy("E [eeeeeeeeeee].mp4")!.missing_since).not.toBeNull();
  });

  test("a changed file is probed again: updatedCopies, its Fallback cleared and the remux file deleted", async () => {
    const root = addRoot(join(base, `r-${n}`));
    const a = file(root.path, "A [aaaaaaaaaaa].mp4");
    await scanner.scanRoot(root);
    const id = copy("A [aaaaaaaaaaa].mp4")!.id;
    db.query("UPDATE copy SET fallback_file = ? WHERE id = ?").run(`${id}.mkv`, id);
    writeFileSync(join(dirs.remuxDir, `${id}.mkv`), "fallback");
    writeFileSync(a, "new bytes, new size");
    utimesSync(a, new Date(), new Date(Date.now() + 5000));
    expect(await scanner.scanRoot(root)).toMatchObject({ updatedCopies: 1, newCopies: 0 });
    expect(copy("A [aaaaaaaaaaa].mp4")).toMatchObject({ id, size: "new bytes, new size".length, fallback_file: null, missing_since: null });
    expect(existsSync(join(dirs.remuxDir, `${id}.mkv`))).toBe(false);
  });

  test("a Root whose scan throws does not stop the next Root; whenIdle still resolves", async () => {
    const r1 = addRoot(join(base, `r-${n}-one`));
    const r2 = addRoot(join(base, `r-${n}-two`));
    file(r1.path, "One [aaaaaaaaaaa].mp4");
    file(r2.path, "Two [bbbbbbbbbbb].mp4");
    const real = scanner.scanRoot.bind(scanner);
    scanner.scanRoot = async (r: RootRow) => {
      if (r.id === r1.id) throw new Error("drive fell off");
      return real(r);
    };
    scanner.request(r1.id);
    scanner.request(r2.id);
    await scanner.whenIdle();
    expect(copy("One [aaaaaaaaaaa].mp4")).toBeNull();
    expect(copy("Two [bbbbbbbbbbb].mp4")).not.toBeNull();
    expect(scanner.progress()).toMatchObject({ running: false, phase: "idle" });
    expect(scanner.progress().last.map((x) => x.rootId)).toEqual([r2.id]);
  });
});
