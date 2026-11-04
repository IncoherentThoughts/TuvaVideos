// Regression tests for the sync and shared-data audit (docs/audit/02-sync-shared-data.md, SYNC-1 to SYNC-16, and
// DOC-2 of 08-spec-drift.md). Each one failed on the audited commit (2f7b8bf) and passes with its fix.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb, type Db } from "../src/server/db";
import { applyShared } from "../src/server/localCopy/apply";
import { reconcileBatch, planFor } from "../src/server/reconcile";
import { wipeShared } from "../src/server/sync";
import type { SharedChanges, SharedChapterRow, SharedVideoRow } from "../src/shared/sharedRows";
import { C, insertChapter, insertCopy, insertVideo, V } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const T = (d: number) => `2026-10-${String(d).padStart(2, "0")}T00:00:00.000000+00:00`;
const sv = (id: string, o: Partial<SharedVideoRow> = {}): SharedVideoRow => ({
  id, youtube_id: null, content_hash: `hash-${id}`, instagram_id: null, rutube_id: null, title: "Shared one", title_latin: null, title_latin_source: null,
  type: "song", type_suggested: false, song_id: null, proposed_song_id: null, version_id: null, proposed_version_id: null, song_suggested: false,
  suggestion_source: null, poster_path: null, deleted_at: null, deleted_by: null, delete_reason: null, created_at: T(1), updated_at: T(10), ...o,
});
const sc = (id: string, video_id: string, start_s: number, title: string, o: Partial<SharedChapterRow> = {}): SharedChapterRow => ({
  id, video_id, start_s, title, title_latin: null, song_id: null, proposed_song_id: null, version_id: null, proposed_version_id: null, suggested: false,
  source: "manual", created_at: T(1), updated_at: T(10), ...o,
});
const batch = (videos: SharedVideoRow[], chapters: SharedChapterRow[] = [], o: Partial<SharedChanges> = {}): SharedChanges => ({
  shared_schema: 1, server_time: T(12), since: null, watermark: T(12), tables: { videos, video_chapters: chapters }, ...o,
});
const fresh = (): Db => {
  const db = openDb(":memory:", MIGRATIONS);
  db.exec(`INSERT INTO root (id, path, kind) VALUES (1, '/r', 'local')`);
  return db;
};
const stampOf = (db: Db, table: string, id: string) => (db.query(`SELECT updated_at FROM ${table} WHERE id = ?`).get(id) as { updated_at: string } | null)?.updated_at;

const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const CH1 = "cccccccc-0000-4000-8000-000000000001";
const CH2 = "cccccccc-0000-4000-8000-000000000002";

describe("SYNC-2: an apply never restamps a row with this machine's clock", () => {
  test("a bumped Video's unchanged Chapter keeps the archive's stamp", () => {
    const db = fresh();
    applyShared(db, batch([sv(S1)], [sc(CH1, S1, 0, "A")]));
    applyShared(db, batch([sv(S1, { updated_at: T(11) })], [sc(CH1, S1, 0, "A"), sc(CH2, S1, 30, "B", { updated_at: T(11) })]));
    expect(stampOf(db, "video_chapters", CH1)).toBe(T(10));
    expect(stampOf(db, "video_chapters", CH2)).toBe(T(11));
  });

  test("a full refetch (wipe + apply) keeps every Chapter's and Artist link's stamp", () => {
    const db = fresh();
    const link = { id: "dddddddd-0000-4000-8000-000000000001", video_id: S1, artist_id: "00000000-0000-4000-8000-000000000777", proposed_artist_id: null, position: 0, suggested: false, created_at: T(1), updated_at: T(10) };
    const b = batch([sv(S1)], [sc(CH1, S1, 0, "A")]);
    b.tables!.video_artists = [link as never];
    applyShared(db, b);
    db.transaction(() => {
      wipeShared(db);
      applyShared(db, b);
    })();
    expect(stampOf(db, "video_chapters", CH1)).toBe(T(10));
    expect(stampOf(db, "video_artists", link.id)).toBe(T(10));
    expect(stampOf(db, "videos", S1)).toBe(T(10));
  });

  test("a local edit still stamps, and no apply flag is left behind", () => {
    const db = fresh();
    applyShared(db, batch([sv(S1)], [sc(CH1, S1, 0, "A")]));
    db.query("UPDATE video_chapters SET title = 'local' WHERE id = ?").run(CH1);
    expect(stampOf(db, "video_chapters", CH1)).not.toBe(T(10));
    expect(db.query("SELECT COUNT(*) AS n FROM meta WHERE key = 'applying_shared'").get()).toEqual({ n: 0 });
  });

  test("a failed apply leaves no apply flag either", () => {
    const db = fresh();
    expect(() => applyShared(db, { tables: { videos: [sv(S1)] }, tombstones: [{ table_name: "nope" } as never] })).toThrow();
    expect(db.query("SELECT COUNT(*) AS n FROM meta WHERE key = 'applying_shared'").get()).toEqual({ n: 0 });
  });
});
