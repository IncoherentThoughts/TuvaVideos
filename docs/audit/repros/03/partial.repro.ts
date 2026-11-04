import { test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "/home/user/TuvaVideos/src/server/db";
import { Roots } from "/home/user/TuvaVideos/src/server/roots";
import { Scanner } from "/home/user/TuvaVideos/src/server/scan";
const HERE = "/tmp/claude-0/-home-user-TuvaVideos/81dd5c87-daef-5003-ad39-65f9bcc41023/scratchpad/audit-03";
test("half-copied id-less file fixes a wrong identity; a full copy becomes a second Video", async () => {
  const dir = mkdtempSync(join(HERE, "pt-")); const lib = join(dir, "lib"); mkdirSync(lib);
  const db = openDb(":memory:", "/home/user/TuvaVideos/migrations");
  const cfg = { ffprobe: "/usr/bin/ffprobe", thumbsDir: join(dir, "t"), remuxDir: join(dir, "r"), ytCacheDir: join(dir, "y"), localRoot: lib };
  const roots = new Roots(db, cfg as any); roots.seed();
  const sc = new Scanner(db, cfg as any, roots, () => {});
  const full = readFileSync(join(HERE, "c.mkv"));
  writeFileSync(join(lib, "Concert.mkv"), full.subarray(0, Math.floor(full.length / 2))); // copy in progress
  await sc.scanRoot(roots.get(1)!);
  writeFileSync(join(lib, "Concert.mkv"), full); utimesSync(join(lib, "Concert.mkv"), new Date(), new Date(Date.now() + 5000)); // copy finished
  await sc.scanRoot(roots.get(1)!);
  mkdirSync(join(lib, "backup")); copyFileSync(join(HERE, "c.mkv"), join(lib, "backup", "Concert.mkv"));
  await sc.scanRoot(roots.get(1)!);
  console.log("VIDEOS", db.query("SELECT id, substr(content_hash,1,12) h, title FROM videos").all());
  console.log("COPIES", db.query("SELECT video_id, rel_path, duration_s, substr(content_hash,1,12) h FROM copy").all());
});
