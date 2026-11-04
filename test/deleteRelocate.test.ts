// deleteVideo (trash, tombstone, caches) and relocateCopy (probe, UPDATE/INSERT copy, Fallback unlink): the paths that
// move or trash the user's media and rewrite Copy rows (audit BLD-5). Fake trash scripts stand in for the OS Trash;
// relocate probes real files made with the app's own ffmpeg, and a fake ffprobe plays the unreadable-file cases.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBin } from "../src/server/config";
import { openDb, type Db } from "../src/server/db";
import { deleteVideo, isDeleted } from "../src/server/deleteVideo";
import { relocateCopy } from "../src/server/relocate";
import type { Roots } from "../src/server/roots";
import { rebuildSearchIndex } from "../src/server/search";
import { TV_PROFILE } from "../src/shared/playbackProfile";
import { insertChapter, insertCopy, insertVideo } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const base = mkdtempSync(join(tmpdir(), "tuva-delreloc-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const script = (name: string, body: string) => {
  const p = join(base, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const fakeRoots = (paths: Record<number, string>, mounted = true) =>
  ({ get: (id: number) => (paths[id] ? { id, path: paths[id], kind: "local" } : undefined), isAvailable: () => mounted }) as unknown as Roots;
const count = (db: Db, sql: string, ...p: any[]) => (db.query(sql).get(...p) as { n: number }).n;

describe("deleteVideo", () => {
  let n = 0;
  /** A fresh library: one Root dir with one file, a Video with a Chapter, a Copy with a Fallback, Poster and Strip caches. */
  function setup(video: Record<string, unknown> = {}) {
    const dir = join(base, `del-${++n}`);
    const root = join(dir, "root");
    const thumbsDir = join(dir, "thumbs");
    const remuxDir = join(dir, "remux");
    for (const d of [root, thumbsDir, remuxDir]) mkdirSync(d, { recursive: true });
    const db = openDb(":memory:", MIGRATIONS);
    db.query("INSERT INTO root (id, path, kind) VALUES (1, ?, 'local')").run(root);
    const v = insertVideo(db, { title: "Doomed", youtube_id: "aaaaaaaaaaa", ...video });
    insertChapter(db, { video_id: v, start_s: 3, title: "Verse" });
    const file = join(root, "Doomed [aaaaaaaaaaa].mp4");
    writeFileSync(file, "x");
    const copyId = insertCopy(db, { video_id: v, root_id: 1, rel_path: "Doomed [aaaaaaaaaaa].mp4", fallback_file: "fb.mkv" });
    const caches = [join(remuxDir, "fb.mkv"), join(thumbsDir, `${v}.poster.webp`), join(thumbsDir, `${v}.strip.webp`)];
    for (const c of caches) writeFileSync(c, "cache");
    rebuildSearchIndex(db);
    return { db, v, file, root, caches, copyId, cfg: (trash: string) => ({ thumbsDir, remuxDir, trash }) };
  }
  const searchRows = (db: Db, v: string) =>
    count(db, "SELECT COUNT(*) n FROM search WHERE (kind = 'video' AND ref_id = ?) OR (kind = 'chapter' AND ref_id IN (SELECT id FROM video_chapters WHERE video_id = ?))", v, v);

  test("media delete: a trash that fails keeps the file, reports its stderr, and tombstones the Video", async () => {
    const s = setup();
    const trash = script("trash-fails.sh", 'echo "trash: permission denied" >&2\nexit 1');
    expect(searchRows(s.db, s.v)).toBeGreaterThan(0);
    const r = await deleteVideo(s.db, s.cfg(trash), fakeRoots({ 1: s.root }), s.v, { media: true });
    expect(r).toEqual({ deleted: true, trashed: [], kept: [{ path: s.file, reason: "trash: permission denied" }], tombstoned: true });
    expect(existsSync(s.file)).toBe(true);
    expect(count(s.db, "SELECT COUNT(*) n FROM deleted_video WHERE youtube_id = 'aaaaaaaaaaa' AND content_hash IS NULL AND title = 'Doomed'")).toBe(1);
    expect(isDeleted(s.db, { youtubeId: "aaaaaaaaaaa", contentHash: null })).toBe(true); // a rescan skips the file left behind
    expect(count(s.db, "SELECT COUNT(*) n FROM videos")).toBe(0);
    expect(count(s.db, "SELECT COUNT(*) n FROM copy")).toBe(0);
    expect(count(s.db, "SELECT COUNT(*) n FROM video_chapters")).toBe(0);
    expect(searchRows(s.db, s.v)).toBe(0);
    for (const c of s.caches) expect(existsSync(c)).toBe(false); // caches go whatever happens to the media
  });

  test("media delete: a trash that works moves the file and leaves no tombstone", async () => {
    const s = setup();
    const bin = join(base, "bin-ok");
    mkdirSync(bin, { recursive: true });
    const trash = script("trash-ok.sh", `mv "$1" "${bin}/"`);
    const r = await deleteVideo(s.db, s.cfg(trash), fakeRoots({ 1: s.root }), s.v, { media: true });
    expect(r).toEqual({ deleted: true, trashed: [s.file], kept: [], tombstoned: false });
    expect(existsSync(s.file)).toBe(false);
    expect(existsSync(join(bin, "Doomed [aaaaaaaaaaa].mp4"))).toBe(true);
    expect(count(s.db, "SELECT COUNT(*) n FROM deleted_video")).toBe(0);
  });

  test("media delete on an unmounted Root keeps the file as 'drive not mounted' and tombstones it", async () => {
    const s = setup();
    const trash = script("trash-never.sh", "echo called >&2\nexit 7");
    const r = await deleteVideo(s.db, s.cfg(trash), fakeRoots({ 1: s.root }, false), s.v, { media: true });
    expect(r).toEqual({ deleted: true, trashed: [], kept: [{ path: s.file, reason: "drive not mounted" }], tombstoned: true });
    expect(existsSync(s.file)).toBe(true);
    expect(isDeleted(s.db, { youtubeId: "aaaaaaaaaaa", contentHash: null })).toBe(true);
  });

  test("a Missing Copy has nothing to trash or keep: no tombstone", async () => {
    const s = setup();
    s.db.query("UPDATE copy SET missing_since = '2026-10-01T00:00:00Z'").run();
    const trash = script("trash-never2.sh", "exit 7");
    expect(await deleteVideo(s.db, s.cfg(trash), fakeRoots({ 1: s.root }), s.v, { media: true })).toEqual({ deleted: true, trashed: [], kept: [], tombstoned: false });
  });

  test("entry-only delete keeps every file, drops caches and search rows, tombstones by content hash when there is no YouTube id", async () => {
    const s = setup({ youtube_id: null, content_hash: "hash-1" });
    const trash = script("trash-unused.sh", "exit 7");
    const r = await deleteVideo(s.db, s.cfg(trash), fakeRoots({ 1: s.root }), s.v, { media: false });
    expect(r).toEqual({ deleted: true, trashed: [], kept: [{ path: s.file, reason: "kept" }], tombstoned: true });
    expect(existsSync(s.file)).toBe(true);
    for (const c of s.caches) expect(existsSync(c)).toBe(false);
    expect(searchRows(s.db, s.v)).toBe(0);
    expect(isDeleted(s.db, { youtubeId: null, contentHash: "hash-1" })).toBe(true);
  });

  test("a Shared Video is refused and nothing is touched; an unknown Video is null", async () => {
    const s = setup({ shared: 1 });
    const trash = script("trash-unused2.sh", "exit 7");
    expect(await deleteVideo(s.db, s.cfg(trash), fakeRoots({ 1: s.root }), s.v, { media: true })).toEqual({ refused: expect.any(String) });
    expect(existsSync(s.file)).toBe(true);
    for (const c of s.caches) expect(existsSync(c)).toBe(true);
    expect(count(s.db, "SELECT COUNT(*) n FROM copy")).toBe(1);
    expect(count(s.db, "SELECT COUNT(*) n FROM video_chapters")).toBe(1);
    expect(count(s.db, "SELECT COUNT(*) n FROM deleted_video")).toBe(0);
    expect(await deleteVideo(s.db, s.cfg(trash), fakeRoots({ 1: s.root }), "00000000-0000-4000-8000-000000000999", { media: true })).toBeNull();
  });
});

describe("relocateCopy probing a real file", () => {
  const ffmpeg = findBin("ffmpeg");
  const ffprobe = findBin("ffprobe");
  const lib = join(base, "reloc-lib");
  const remuxDir = join(base, "reloc-remux");
  const cfg = { ffprobe, remuxDir };
  const moved = join(lib, "moved", "Song [aaaaaaaaaaa].mp4");
  const audioOnly = join(lib, "moved", "Sound [eeeeeeeeeee].mp4");

  async function ff(...args: string[]) {
    const p = Bun.spawn([ffmpeg, "-v", "error", "-y", ...args], { stdout: "ignore", stderr: "pipe" });
    if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  }

  beforeAll(async () => {
    mkdirSync(join(lib, "moved"), { recursive: true });
    mkdirSync(remuxDir, { recursive: true });
    await ff("-f", "lavfi", "-i", "testsrc=size=160x120:rate=25:duration=1", "-f", "lavfi", "-i", "sine=duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", moved);
    await ff("-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac", audioOnly);
  }, 30_000);

  function setup() {
    const db = openDb(":memory:", MIGRATIONS);
    db.query("INSERT INTO root (id, path, kind) VALUES (1, ?, 'local')").run(lib);
    const v = insertVideo(db, { title: "Song", youtube_id: "aaaaaaaaaaa", favorited_at: "x" });
    const copyId = insertCopy(db, {
      video_id: v, root_id: 1, rel_path: "old/Song [aaaaaaaaaaa].mp4", size: 1, mtime: "x", missing_since: "2026-10-01T00:00:00Z",
      fallback_file: "old.mkv", tv_playback: '{"video":"transcode","audio":"transcode","reason":"stale"}', tv_profile_version: 0,
    });
    writeFileSync(join(remuxDir, "old.mkv"), "stale fallback");
    return { db, v, copyId, roots: [{ id: 1, path: lib, kind: "local" as const }] };
  }

  test("moves the Copy to the new file: probed facts, Fallback cleared and unlinked, TV judged again, no longer Missing", async () => {
    const { db, v, copyId, roots } = setup();
    expect(await relocateCopy(db, cfg, roots, v, { path: moved })).toEqual({ ok: true, value: { copyId, rootId: 1 } });
    const row = db.query("SELECT rel_path, size, container, video_codec, audio_codec, width, height, fallback_file, missing_since, tv_playback, tv_profile_version FROM copy WHERE id = ?").get(copyId) as any;
    expect(row).toMatchObject({ rel_path: "moved/Song [aaaaaaaaaaa].mp4", container: "mp4", video_codec: "h264", audio_codec: "aac", width: 160, height: 120, fallback_file: null, missing_since: null });
    expect(row.size).toBe(Bun.file(moved).size);
    expect(row.tv_profile_version).toBe(TV_PROFILE.version);
    expect(row.tv_playback).not.toContain("stale");
    expect(existsSync(join(remuxDir, "old.mkv"))).toBe(false);
    expect(db.query("SELECT favorited_at FROM video_full WHERE id = ?").get(v)).toEqual({ favorited_at: "x" }); // the edits stay
  });

  test("a ~/ path is expanded against HOME", async () => {
    const { db, v, copyId, roots } = setup();
    const home = process.env.HOME;
    process.env.HOME = base;
    try {
      expect(await relocateCopy(db, cfg, roots, v, { path: "~/reloc-lib/moved/Song [aaaaaaaaaaa].mp4" })).toEqual({ ok: true, value: { copyId, rootId: 1 } });
    } finally {
      process.env.HOME = home;
    }
  });

  test("a Video with no Copy gets a new one", async () => {
    const { db, roots } = setup();
    const v = insertVideo(db, { title: "Bare", youtube_id: "fffffffffff" });
    const r = await relocateCopy(db, cfg, roots, v, { path: moved });
    expect(r).toMatchObject({ ok: true, value: { rootId: 1 } });
    const id = (r as { value: { copyId: number } }).value.copyId;
    expect(db.query("SELECT video_id, rel_path, tv_profile_version FROM copy WHERE id = ?").get(id)).toEqual({ video_id: v, rel_path: "moved/Song [aaaaaaaaaaa].mp4", tv_profile_version: TV_PROFILE.version });
  });

  test("refuses a folder, an audio-only file and a copyId that is not this Video's (a string included)", async () => {
    const { db, v, copyId, roots } = setup();
    expect(await relocateCopy(db, cfg, roots, v, { path: join(lib, "moved") })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("folder") });
    expect(await relocateCopy(db, cfg, roots, v, { path: audioOnly })).toMatchObject({ ok: false, status: 400, error: "that file has no video stream" });
    expect(await relocateCopy(db, cfg, roots, v, { path: moved, copyId: copyId + 100 })).toMatchObject({ ok: false, status: 404 });
    expect(await relocateCopy(db, cfg, roots, v, { path: moved, copyId: String(copyId) as any })).toMatchObject({ ok: false, status: 404 });
    expect(db.query("SELECT rel_path, fallback_file FROM copy WHERE id = ?").get(copyId)).toEqual({ rel_path: "old/Song [aaaaaaaaaaa].mp4", fallback_file: "old.mkv" });
  });

  test("a file ffprobe cannot read: an I/O error is a 503 (retry later), anything else a 400; the row is untouched", async () => {
    const { db, v, copyId, roots } = setup();
    const broken = { ffprobe: script("ffprobe-broken.sh", 'echo "moov atom not found" >&2\nexit 1'), remuxDir };
    expect(await relocateCopy(db, broken, roots, v, { path: moved })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("moov atom not found") });
    const eio = { ffprobe: script("ffprobe-eio.sh", 'echo "Input/output error" >&2\nexit 1'), remuxDir };
    expect(await relocateCopy(db, eio, roots, v, { path: moved })).toMatchObject({ ok: false, status: 503 }); // after probeFile's retries
    expect(db.query("SELECT rel_path, fallback_file, missing_since FROM copy WHERE id = ?").get(copyId)).toEqual({ rel_path: "old/Song [aaaaaaaaaaa].mp4", fallback_file: "old.mkv", missing_since: "2026-10-01T00:00:00Z" });
    expect(existsSync(join(remuxDir, "old.mkv"))).toBe(true);
  }, 20_000);
});
