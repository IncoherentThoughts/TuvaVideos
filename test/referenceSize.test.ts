// Reference size (docs/downloader-spec.md §3.2-3.3): which Copy gives it, the candidates list, migration 0022 applying out
// of order, the three columns riding applyShared, and the browser's fill over mocked calls (no RPC is ever live here).
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../src/server/db";
import { applyShared } from "../src/server/localCopy/apply";
import { referenceSizeCandidates } from "../src/server/referenceSize";
import { EVENT_TYPES, editBelongsTo } from "../src/shared/archiveWire";
import { chooseReferenceCopy, fillReferenceSizes, referenceSizeEdit, type ReferenceSizeCandidate } from "../src/shared/referenceSize";
import type { SharedVideoRow } from "../src/shared/sharedRows";
import { insertCopy, insertVideo, U, V } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const dir = mkdtempSync(join(tmpdir(), "tuva-refsize-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const T = (n: number) => `2026-03-01T00:00:${String(n).padStart(2, "0")}.000Z`;

const c = (size: number, height: number | null, duration_s: number | null = 100) => ({ size, height, duration_s });

describe("chooseReferenceCopy", () => {
  test("the greatest height at or under 1080 wins, however large a taller Copy is", () => {
    expect(chooseReferenceCopy([c(900, 2160), c(300, 720), c(500, 1080), c(50, 480)])).toEqual(c(500, 1080));
  });
  test("equal heights go to the larger size; a full tie keeps the earlier Copy", () => {
    expect(chooseReferenceCopy([c(100, 720), c(300, 720), c(200, 720)])).toEqual(c(300, 720));
    const a = c(100, 720), b = c(100, 720);
    expect(chooseReferenceCopy([a, b])).toBe(a);
  });
  test("when every Copy is taller than 1080, the largest by size", () => {
    expect(chooseReferenceCopy([c(300, 1440), c(900, 2160), c(500, 4320)])).toEqual(c(900, 2160));
  });
  test("a Copy without a positive size, duration or height is no candidate", () => {
    expect(chooseReferenceCopy([c(100, null), c(100, 720, null), c(0, 720), c(100, 0)])).toBeNull();
    expect(chooseReferenceCopy([c(999, null), c(10, 360)])).toEqual(c(10, 360));
    expect(chooseReferenceCopy([])).toBeNull();
  });
});

describe("migration 0022", () => {
  test("a file numbered below one already applied still runs once and is recorded", () => {
    const d = mkdtempSync(join(dir, "mig-"));
    for (const f of readdirSync(MIGRATIONS)) if (!f.startsWith("0022")) cpSync(join(MIGRATIONS, f), join(d, f));
    const db = new Database(":memory:");
    migrate(db, d);
    const cols = () => (db.query("PRAGMA table_info(videos)").all() as { name: string }[]).map((x) => x.name);
    expect(cols()).not.toContain("size_bytes");
    const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    cpSync(join(MIGRATIONS, "0022_reference_size.sql"), join(d, "0022_reference_size.sql"));
    migrate(db, d);
    expect(cols()).toEqual(expect.arrayContaining(["size_bytes", "duration_s", "height"]));
    expect(db.query("SELECT 1 FROM migration WHERE name = '0022_reference_size.sql'").get()).toBeTruthy();
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(uv); // never lowered
    migrate(db, d); // and not again
  });

  test("the columns are nullable, positive when set", () => {
    const db = openDb(join(dir, "check.db"), MIGRATIONS);
    const id = insertVideo(db, { title: "x", youtube_id: "aaaaaaaaaaa" });
    expect(db.query("SELECT size_bytes, duration_s, height FROM videos WHERE id = ?").get(id)).toEqual({ size_bytes: null, duration_s: null, height: null });
    expect(() => db.query("UPDATE videos SET size_bytes = 0 WHERE id = ?").run(id)).toThrow();
    expect(() => db.query("UPDATE videos SET duration_s = -1 WHERE id = ?").run(id)).toThrow();
    expect(() => db.query("UPDATE videos SET height = 0 WHERE id = ?").run(id)).toThrow();
    db.close();
  });
});

const vrow = (o: Partial<SharedVideoRow> = {}): SharedVideoRow => ({
  id: U(1), youtube_id: "aaaaaaaaaaa", content_hash: null, instagram_id: null, rutube_id: null, title: "T", title_latin: null, title_latin_source: null,
  type: "song", type_suggested: false, song_id: null, proposed_song_id: null, version_id: null, proposed_version_id: null, song_suggested: false,
  suggestion_source: null, poster_path: null, deleted_at: null, deleted_by: null, delete_reason: null, created_at: T(1), updated_at: T(10), ...o,
});
const bundle = (videos: SharedVideoRow[]) => ({ shared_schema: 1, server_time: T(20), since: null, watermark: T(19), tables: { videos } });

describe("applyShared carries the Reference size", () => {
  test("the three fields land, a later pull without them (an archive not yet migrated) keeps them, a newer one replaces them", () => {
    const db = openDb(join(dir, "apply.db"), MIGRATIONS);
    applyShared(db, bundle([vrow({ size_bytes: 123456789, duration_s: 212.5, height: 720 })]));
    const read = () => db.query("SELECT size_bytes, duration_s, height FROM videos WHERE id = ?").get(U(1));
    expect(read()).toEqual({ size_bytes: 123456789, duration_s: 212.5, height: 720 });
    applyShared(db, bundle([vrow({ title: "T2", updated_at: T(11) })]));
    expect(read()).toEqual({ size_bytes: 123456789, duration_s: 212.5, height: 720 });
    applyShared(db, bundle([vrow({ updated_at: T(12), size_bytes: 5, duration_s: 6, height: 1080 })]));
    expect(read()).toEqual({ size_bytes: 5, duration_s: 6, height: 1080 });
    db.close();
  });
});

describe("referenceSizeCandidates", () => {
  const db = openDb(join(dir, "cand.db"), MIGRATIONS);
  db.query("INSERT INTO root (id, path, kind) VALUES (1, '/r', 'local')").run();
  const mk = (n: number, local: Record<string, unknown> = {}, v: Record<string, unknown> = {}) =>
    insertVideo(db, { id: n, title: `v${n}`, content_hash: `h${n}`, shared: 1, updated_at: T(n), ...v, ...local });

  test("Shared, all three null, and a non-Missing Copy that can fill them", () => {
    mk(1); // two Copies: the 1080 one wins over the larger 2160 one
    insertCopy(db, { video_id: 1, root_id: 1, rel_path: "a1.mkv", size: 900, height: 2160, duration_s: 60 });
    insertCopy(db, { video_id: 1, root_id: 1, rel_path: "a2.mkv", size: 400, height: 1080, duration_s: 60.5 });
    mk(2); // no Copy
    mk(3); // only a Missing Copy
    insertCopy(db, { video_id: 3, root_id: 1, rel_path: "a3.mkv", size: 10, height: 480, duration_s: 5, missing_since: T(1) });
    mk(4); // a Copy ffprobe could not read
    insertCopy(db, { video_id: 4, root_id: 1, rel_path: "a4.mkv", size: 10 });
    mk(5, {}, { size_bytes: 1 }); // already (partly) filled: never overwritten
    insertCopy(db, { video_id: 5, root_id: 1, rel_path: "a5.mkv", size: 10, height: 480, duration_s: 5 });
    mk(6, {}, { deleted_at: T(1) }); // soft-deleted
    insertCopy(db, { video_id: 6, root_id: 1, rel_path: "a6.mkv", size: 10, height: 480, duration_s: 5 });
    mk(7, { shared: 0 }); // Unshared
    insertCopy(db, { video_id: 7, root_id: 1, rel_path: "a7.mkv", size: 10, height: 480, duration_s: 5 });
    mk(8); // newer, first in the list
    insertCopy(db, { video_id: 8, root_id: 1, rel_path: "a8.mkv", size: 77, height: 360, duration_s: 9 });
    expect(referenceSizeCandidates(db)).toEqual([
      { videoId: V(8), updatedAt: T(8), size_bytes: 77, duration_s: 9, height: 360 },
      { videoId: V(1), updatedAt: T(1), size_bytes: 400, duration_s: 60.5, height: 1080 },
    ]);
  });
});

describe("fillReferenceSizes", () => {
  const items: ReferenceSizeCandidate[] = [1, 2, 3, 4].map((n) => ({ videoId: U(n), updatedAt: T(n), size_bytes: n * 1000, duration_s: n * 10, height: 720 }));

  test("one write_videos update per Video with its stamp and one reference_size Edit; each result applied", async () => {
    const writes: unknown[] = [];
    const applied: unknown[] = [];
    const videoId = (res: unknown) => (res as { tables: { videos: { id: string }[] } }).tables.videos[0]!.id;
    const r =await fillReferenceSizes(items, {
      async write(videoId, payload, updatedAt, edit) {
        writes.push({ videoId, payload, updatedAt, edit });
        if (videoId === U(2)) return { ok: false, error: "conflict" };
        if (videoId === U(3)) throw new Error("network");
        return { ok: true, value: { tables: { videos: [{ id: videoId }] } } };
      },
      async apply(result) {
        applied.push(result);
        return videoId(result) !== U(4); // the cache refuses the fourth
      },
    });
    expect(r.filled).toBe(1); // 1 ok; 2 refused, 3 threw, 4 not taken by the cache
    expect(r.failed).toBe(3);
    expect(r.errors).toHaveLength(3);
    expect(writes).toHaveLength(4);
    expect(writes[0]).toEqual({
      videoId: U(1), payload: { size_bytes: 1000, duration_s: 10, height: 720 }, updatedAt: T(1),
      edit: { event_type: "video.reference_size_changed", field_name: "reference_size", old_value: null, new_value: { size_bytes: 1000, duration_s: 10, height: 720 }, description: "Reference size filled" },
    });
    expect(applied).toHaveLength(2);
  });

  test("the Edit is one the archive accepts for write_videos", () => {
    const e = referenceSizeEdit({ size_bytes: 1, duration_s: 1, height: 1 });
    expect((EVENT_TYPES as readonly string[]).includes(e.event_type)).toBe(true);
    expect(editBelongsTo("write_videos", e)).toBe(true);
  });
});
