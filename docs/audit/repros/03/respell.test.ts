import { test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "/home/user/TuvaVideos/src/server/db";
import { Roots } from "/home/user/TuvaVideos/src/server/roots";
import { Scanner } from "/home/user/TuvaVideos/src/server/scan";
const HERE = "/tmp/claude-0/-home-user-TuvaVideos/81dd5c87-daef-5003-ad39-65f9bcc41023/scratchpad/audit-03";
test("NFC+NFD rows for one name abort the whole Root scan", async () => {
  const dir = mkdtempSync(join(HERE, "rs-")); const lib = join(dir, "lib"); mkdirSync(lib);
  const db = openDb(":memory:", "/home/user/TuvaVideos/migrations");
  const cfg = { ffprobe: "/usr/bin/ffprobe", thumbsDir: join(dir, "t"), remuxDir: join(dir, "r"), ytCacheDir: join(dir, "y"), localRoot: lib };
  const roots = new Roots(db, cfg as any); roots.seed();
  const nfc = "Кӧмей [aaaaaaaaaaa].mp4";
  copyFileSync(join(HERE, "a.mp4"), join(lib, nfc));
  copyFileSync(join(HERE, "b.mp4"), join(lib, "Other [bbbbbbbbbbb].mp4"));
  const now = new Date().toISOString();
  db.query("INSERT INTO videos (id, youtube_id, title, created_at, updated_at) VALUES ('v1','aaaaaaaaaaa','x',?,?)").run(now, now);
  db.query("INSERT INTO copy (video_id, root_id, rel_path, size, mtime, playback) VALUES ('v1',1,?,1,'x','native')").run(nfc);
  db.query("INSERT INTO copy (video_id, root_id, rel_path, size, mtime, playback) VALUES ('v1',1,?,1,'x','native')").run(nfc.normalize("NFD"));
  const sc = new Scanner(db, cfg as any, roots, () => {});
  try { await sc.scanRoot(roots.get(1)!); console.log("scan returned"); } catch (e) { console.log("SCAN THREW:", String(e)); }
  console.log(db.query("SELECT id, rel_path, length(rel_path) l, missing_since FROM copy").all());
});
