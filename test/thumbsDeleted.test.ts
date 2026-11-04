// A Thumbnail that finishes after its Video was deleted is thrown away, not published as orphan files (audit DB-14).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/server/db";
import { Roots } from "../src/server/roots";
import { Thumbnails } from "../src/server/thumbs";
import { insertCopy, insertVideo, V } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const { ffmpeg, cwebp } = loadConfig({});
const dir = mkdtempSync(join(tmpdir(), "tuva-thumbdel-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("generate() for a Video deleted meanwhile leaves no poster or strip in thumbs/", async () => {
  const lib = join(dir, "lib");
  const thumbsDir = join(dir, "thumbs");
  mkdirSync(lib);
  const p = Bun.spawn([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(lib, "a.mp4")]);
  expect(await p.exited).toBe(0);
  const db = openDb(":memory:", MIGRATIONS);
  db.query("INSERT INTO root (id, path, kind) VALUES (1, ?, 'local')").run(lib);
  insertVideo(db, { id: 1, content_hash: "h", title: "T", created_at: "x" });
  insertCopy(db, { id: 1, video_id: 1, root_id: 1, rel_path: "a.mp4", mtime: "x", duration_s: 1, video_codec: "h264" });
  const roots = new Roots(db, {});
  await roots.check(1);
  const thumbs = new Thumbnails(db, { thumbsDir, ffmpeg, cwebp }, roots, () => false);
  const src = { id: 1, root_id: 1, root_kind: "local", root_path: lib, rel_path: "a.mp4", size: 1, duration_s: 1, video_codec: "h264", width: 64, height: 48, playback: "native" };
  // the Video is deleted while its Thumbnail is being made
  db.query("DELETE FROM copy WHERE id = 1").run();
  db.query("DELETE FROM videos WHERE id = ?").run(V(1));
  await (thumbs as any).generate(V(1), src);
  expect(readdirSync(thumbsDir).filter((f) => f.endsWith(".webp"))).toEqual([]);
}, 30_000);
