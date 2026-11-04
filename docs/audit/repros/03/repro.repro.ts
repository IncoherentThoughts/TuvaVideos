import { test, expect } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, readdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "/home/user/TuvaVideos/src/server/db";
import { Roots } from "/home/user/TuvaVideos/src/server/roots";
import { Scanner } from "/home/user/TuvaVideos/src/server/scan";
import { parseFilename } from "/home/user/TuvaVideos/src/server/filename";
import { relocateCopy } from "/home/user/TuvaVideos/src/server/relocate";

const HERE = "/tmp/claude-0/-home-user-TuvaVideos/81dd5c87-daef-5003-ad39-65f9bcc41023/scratchpad/audit-03";
const MIG = "/home/user/TuvaVideos/migrations";

function env() {
  const dir = mkdtempSync(join(HERE, "run-"));
  const lib = join(dir, "lib");
  mkdirSync(lib, { recursive: true });
  const db = openDb(":memory:", MIG);
  const cfg = { ffprobe: "/usr/bin/ffprobe", thumbsDir: join(dir, "thumbs"), remuxDir: join(dir, "remux"), ytCacheDir: join(dir, "yt"), localRoot: lib };
  const roots = new Roots(db, cfg as any);
  roots.seed();
  const scanner = new Scanner(db, cfg as any, roots, () => {});
  return { dir, lib, db, roots, scanner, cfg };
}

test("NFD filename on Linux: stored NFC, file unreachable", async () => {
  const { lib, db, roots, scanner } = env();
  const nfd = "Кӧмей [aaaaaaaaaaa].mp4"; // o + combining diaeresis
  copyFileSync(join(HERE, "a.mp4"), join(lib, nfd));
  const s = await scanner.scanRoot(roots.get(1)!);
  console.log("NFD summary", JSON.stringify(s));
  const rows = db.query("SELECT rel_path FROM copy").all() as { rel_path: string }[];
  console.log("NFD copies", rows.map((r) => [r.rel_path, r.rel_path === r.rel_path.normalize("NFC"), existsSync(join(lib, r.rel_path))]));
});

test("unmounted Linux mountpoint left as an empty dir: every Copy marked Missing", async () => {
  const { lib, db, roots, scanner } = env();
  copyFileSync(join(HERE, "a.mp4"), join(lib, "One [aaaaaaaaaaa].mp4"));
  copyFileSync(join(HERE, "b.mp4"), join(lib, "Two.mp4"));
  await scanner.scanRoot(roots.get(1)!);
  console.log("before", db.query("SELECT rel_path, missing_since FROM copy").all());
  // "unmount": the mountpoint stays as an empty directory
  for (const f of readdirSync(lib)) rmSync(join(lib, f));
  const avail = await roots.check(1);
  const s = await scanner.scanRoot(roots.get(1)!);
  console.log("available after unmount?", avail, "markedMissing", s?.markedMissing);
  console.log("after", db.query("SELECT rel_path, missing_since FROM copy").all());
});

test("symlinked files and dirs are ignored", async () => {
  const { dir, lib, db, roots, scanner } = env();
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(elsewhere);
  copyFileSync(join(HERE, "a.mp4"), join(elsewhere, "Linked [bbbbbbbbbbb].mp4"));
  symlinkSync(join(elsewhere, "Linked [bbbbbbbbbbb].mp4"), join(lib, "Linked [bbbbbbbbbbb].mp4"));
  symlinkSync(elsewhere, join(lib, "linkdir"));
  const s = await scanner.scanRoot(roots.get(1)!);
  console.log("symlink summary filesSeen", s?.filesSeen, "copies", db.query("SELECT COUNT(*) n FROM copy").get());
});

test("bracketed 11-char tags parse as YouTube ids", () => {
  for (const n of ["Kongurei [1080p60_HDR].mp4", "Концерт [Live_Kyzyl].mp4", "Song [remastered].mkv"]) console.log(n, "->", parseFilename(n).youtubeId);
});

test("two different files with the same false id collapse into one Video", async () => {
  const { lib, db, roots, scanner } = env();
  copyFileSync(join(HERE, "a.mp4"), join(lib, "Alash [Live_Kyzyl].mp4"));
  copyFileSync(join(HERE, "b.mp4"), join(lib, "Huun-Huur-Tu [Live_Kyzyl].mp4"));
  await scanner.scanRoot(roots.get(1)!);
  console.log("videos", db.query("SELECT id, youtube_id, title FROM videos").all(), "copies", db.query("SELECT video_id, rel_path FROM copy").all());
});

test("file content replaced in place keeps old identity (id-less)", async () => {
  const { lib, db, roots, scanner } = env();
  copyFileSync(join(HERE, "a.mp4"), join(lib, "Clip.mp4"));
  await scanner.scanRoot(roots.get(1)!);
  const v1 = db.query("SELECT id, content_hash FROM videos").all();
  copyFileSync(join(HERE, "b.mp4"), join(lib, "Clip.mp4"));
  await scanner.scanRoot(roots.get(1)!);
  console.log("v before", v1, "v after", db.query("SELECT id, content_hash FROM videos").all(), "copy hash", db.query("SELECT content_hash FROM copy").all());
});

test("rename: old Copy stays Missing forever, new Copy added", async () => {
  const { lib, db, roots, scanner } = env();
  copyFileSync(join(HERE, "a.mp4"), join(lib, "Clip.mp4"));
  await scanner.scanRoot(roots.get(1)!);
  renameSync(join(lib, "Clip.mp4"), join(lib, "Clip renamed.mp4"));
  await scanner.scanRoot(roots.get(1)!);
  console.log("rename", db.query("SELECT video_id, rel_path, missing_since FROM copy").all(), db.query("SELECT COUNT(*) n FROM videos").get());
});

test("relocate keeps the old keyframe index", async () => {
  const { lib, db, roots, scanner, cfg } = env();
  copyFileSync(join(HERE, "a.mp4"), join(lib, "Clip [ccccccccccc].mp4"));
  await scanner.scanRoot(roots.get(1)!);
  db.query("UPDATE copy SET keyframes = x'e8030000'").run();
  rmSync(join(lib, "Clip [ccccccccccc].mp4"));
  await scanner.scanRoot(roots.get(1)!);
  copyFileSync(join(HERE, "b.mp4"), join(lib, "Other encode.mp4"));
  const vid = (db.query("SELECT id FROM videos").get() as any).id;
  const r = await relocateCopy(db, cfg as any, roots.list(), vid, { path: join(lib, "Other encode.mp4") });
  console.log("relocate", r, db.query("SELECT rel_path, hex(keyframes) k, missing_since FROM copy").all());
});
