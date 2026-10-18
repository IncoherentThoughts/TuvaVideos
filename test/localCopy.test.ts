// The Local copy (sharing-spec §6.1, §6.2, §5.2, §8.2; ticket #112): the deterministic integer -> uuid map, Rutube
// filenames, timestamps and the skip guard, applyShared's children / tombstone / reindex rules and the views over an
// in-memory database, the meta seams (Session record, Shelved edits, pending_share), the data dir per platform and
// the Origin/Host check of POST /api/cache/apply.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { dataDirFor } from "../src/server/config";
import { parseFilename } from "../src/server/filename";
import { applyShared, heldIsNewer, REBUILD_THRESHOLD, tsMicros } from "../src/server/localCopy/apply";
import { legacyIdOf, legacyUuid } from "../src/server/localCopy/ids";
import {
  clearSessionRecord, clearShelved, listShelved, localSharedSchema, machineMode, pendingShareIds, readSessionRecord, setPendingShare, SHARED_SCHEMA, shelve, writeSessionRecord,
} from "../src/server/localCopy/meta";
import { songPointers } from "../src/server/localCopy/rows";
import { localRequestError } from "../src/server/localOnly";
import type { SharedChapterRow, SharedVideoRow } from "../src/shared/sharedRows";
import { insertVideo, U, V } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const open = () => openDb(":memory:", MIGRATIONS);
const T = (n: number) => `2026-10-${String(n).padStart(2, "0")}T00:00:00.000000+00:00`;

const video = (id: string, o: Partial<SharedVideoRow> = {}): SharedVideoRow => ({
  id, youtube_id: null, content_hash: `hash-${id}`, instagram_id: null, rutube_id: null, title: `T ${id.slice(-4)}`, title_latin: null, title_latin_source: null,
  type: "song", type_suggested: false, song_id: null, proposed_song_id: null, version_id: null, proposed_version_id: null, song_suggested: false,
  suggestion_source: null, poster_path: null, deleted_at: null, deleted_by: null, delete_reason: null, created_at: T(1), updated_at: T(10), ...o,
});
const chapter = (id: string, videoId: string, startS: number, o: Partial<SharedChapterRow> = {}): SharedChapterRow => ({
  id, video_id: videoId, start_s: startS, title: `ch ${startS}`, title_latin: null, title_latin_source: null, song_id: null, proposed_song_id: null,
  version_id: null, proposed_version_id: null, suggested: false, source: "manual", updated_at: T(10), ...o,
});
const SV1 = "11111111-1111-4111-8111-111111111111";
const SV2 = "22222222-2222-4222-8222-222222222222";
const CH = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("the integer -> uuid map", () => {
  test("legacyUuid is deterministic, round-trips and agrees with migration 0015's printf", () => {
    expect(legacyUuid("video", 1)).toBe("76696400-0000-8000-8000-000000000001");
    expect(legacyUuid("chapter", 2867)).toBe("63687000-0000-8000-8000-000000000b33");
    expect(legacyUuid("artist", 111)).toBe("61727400-0000-8000-8000-00000000006f");
    for (const [k, n] of [["video", 2265], ["chapter", 1], ["artist", 157]] as const) expect(legacyIdOf(legacyUuid(k, n))).toEqual({ kind: k, id: n });
    expect(legacyIdOf(crypto.randomUUID())).toBeNull();
    expect(() => legacyUuid("video", -1)).toThrow();
    const db = new Database(":memory:");
    for (const n of [1, 255, 2265, 2 ** 40]) {
      const sql = db.query("SELECT printf('76696400-0000-8000-8000-%012x', ?) u").get(n) as { u: string };
      expect(sql.u).toBe(legacyUuid("video", n));
    }
    // legacy uuids sort like the integers they came from
    expect([legacyUuid("video", 10), legacyUuid("video", 9), legacyUuid("video", 300)].sort()).toEqual([legacyUuid("video", 9), legacyUuid("video", 10), legacyUuid("video", 300)]);
  });
});

describe("Rutube filenames (ADR 0008)", () => {
  test("[rutube-<32 hex>] is parsed, lowercased and stripped from the title; anything else is left alone", () => {
    const p = parseFilename("Аас-чогаал бөлүү Өлчей - Калдак-Хамар ⧸ Тыва [rutube-A555F5D081A84AB8BDB2E97107F82D2D].mp4");
    expect(p).toMatchObject({ skip: null, rutubeId: "a555f5d081a84ab8bdb2e97107f82d2d", youtubeId: null, instagramId: null, title: "Аас-чогаал бөлүү Өлчей - Калдак-Хамар ⧸ Тыва" });
    expect(parseFilename("x [rutube-abc].mp4")).toMatchObject({ rutubeId: null, title: "x [rutube-abc]" });
    expect(parseFilename("Alash [dQw4w9WgXcQ].webm")).toMatchObject({ rutubeId: null, youtubeId: "dQw4w9WgXcQ" });
    expect(parseFilename("[rutube-a555f5d081a84ab8bdb2e97107f82d2d].mp4").title).toBe("[rutube-a555f5d081a84ab8bdb2e97107f82d2d]");
  });
});

describe("timestamps and the skip guard", () => {
  test("Postgres and ISO forms compare by instant, to the microsecond", () => {
    expect(tsMicros("2026-10-17T12:34:56.123456+00:00")).toBe(Date.parse("2026-10-17T12:34:56Z") * 1000 + 123456);
    expect(tsMicros("2026-10-17 12:34:56.1+00")).toBe(Date.parse("2026-10-17T12:34:56Z") * 1000 + 100000);
    expect(tsMicros("2026-10-17T14:34:56+02:00")).toBe(tsMicros("2026-10-17T12:34:56Z"));
    expect(tsMicros("2026-10-17T12:34:56.123Z")).toBe(tsMicros("2026-10-17T12:34:56.123000+00:00"));
    expect(tsMicros("not a time")).toBeNull();
    expect(heldIsNewer("2026-10-17T12:00:00.000001+00", "2026-10-17T12:00:00Z")).toBe(false); // incoming newer: apply
    expect(heldIsNewer("2026-10-17T12:00:00Z", "2026-10-17T12:00:00.000+00:00")).toBe(true); // equal: skip
    expect(heldIsNewer("2026-10-16T12:00:00Z", "2026-10-17T12:00:00Z")).toBe(true);
    expect(heldIsNewer("2026-10-16T12:00:00Z", null)).toBe(false); // nothing known held: apply
  });
});

describe("applyShared", () => {
  test("a Video arrives Shared, with its children; its side row is created and marked shared", () => {
    const db = open();
    const r = applyShared(db, { videos: [video(SV1)], video_chapters: [chapter(CH(1), SV1, 0), chapter(CH(2), SV1, 60)] });
    expect(r.applied).toEqual({ videos: 1, video_chapters: 2 });
    expect(r.watermark).toBe(T(10));
    expect(db.query("SELECT shared, pending_share FROM video_full WHERE id = ?").get(SV1)).toEqual({ shared: 1, pending_share: 0 });
    expect(db.query("SELECT COUNT(*) n FROM search WHERE kind IN ('video', 'chapter')").get()).toEqual({ n: 3 });
    expect(db.query("SELECT type_suggested FROM videos WHERE id = ?").get(SV1)).toEqual({ type_suggested: 0 }); // booleans as 0/1
  });

  test("children are replaced per bumped parent: missing ones go, kept ones keep this machine's Favorite", () => {
    const db = open();
    applyShared(db, { videos: [video(SV1)], video_chapters: [chapter(CH(1), SV1, 0), chapter(CH(2), SV1, 60)] });
    db.query("INSERT INTO chapter_local (chapter_id, favorited_at) VALUES (?, 'fav')").run(CH(1));
    db.query("UPDATE video_local SET view_count = 5 WHERE video_id = ?").run(SV1);
    const r = applyShared(db, { videos: [video(SV1, { updated_at: T(11) })], video_chapters: [chapter(CH(1), SV1, 0, { title: "renamed" }), chapter(CH(3), SV1, 120)] });
    expect(r.removed).toBe(1);
    expect(db.query("SELECT id, title, favorited_at FROM chapter_full ORDER BY start_s").all()).toEqual([
      { id: CH(1), title: "renamed", favorited_at: "fav" },
      { id: CH(3), title: "ch 120", favorited_at: null },
    ]);
    expect(db.query("SELECT view_count FROM video_full WHERE id = ?").get(SV1)).toEqual({ view_count: 5 }); // the side table is untouched
    // a bumped parent with no children left loses them all
    applyShared(db, { videos: [video(SV1, { updated_at: T(12) })] });
    expect(db.query("SELECT COUNT(*) n FROM video_chapters").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) n FROM search WHERE kind = 'chapter'").get()).toEqual({ n: 0 });
  });

  test("the guard: an older or equal Video is skipped with its children; children without their Video are upserted one by one", () => {
    const db = open();
    applyShared(db, { videos: [video(SV1, { updated_at: T(10) })], video_chapters: [chapter(CH(1), SV1, 0)] });
    const r = applyShared(db, { videos: [video(SV1, { title: "stale", updated_at: T(9) })], video_chapters: [chapter(CH(9), SV1, 30, { updated_at: T(9) })] });
    expect(r.applied).toEqual({});
    expect(r.skipped).toEqual({ videos: 1, video_chapters: 1 });
    expect(db.query("SELECT title FROM videos").get()).toEqual({ title: "T 1111" });
    expect(db.query("SELECT COUNT(*) n FROM video_chapters").get()).toEqual({ n: 1 });
    // a lone Chapter (the parent not in the batch): applied when newer, skipped when not, nothing else removed
    applyShared(db, { video_chapters: [chapter(CH(1), SV1, 0, { title: "newer", updated_at: T(11) }), chapter(CH(2), SV1, 5, { updated_at: T(11) })] });
    expect(db.query("SELECT id, title FROM video_chapters ORDER BY start_s").all()).toEqual([{ id: CH(1), title: "newer" }, { id: CH(2), title: "ch 5" }]);
    expect(applyShared(db, { video_chapters: [chapter(CH(1), SV1, 0, { title: "older", updated_at: T(10) })] }).skipped).toEqual({ video_chapters: 1 });
  });

  test("a Chapter that moved onto another's start replaces it; a Video whose identity is held under another id refuses the batch", () => {
    const db = open();
    applyShared(db, { videos: [video(SV1)], video_chapters: [chapter(CH(1), SV1, 0), chapter(CH(2), SV1, 60)] });
    applyShared(db, { videos: [video(SV1, { updated_at: T(11) })], video_chapters: [chapter(CH(2), SV1, 0)] });
    expect(db.query("SELECT id, start_s FROM video_chapters").all()).toEqual([{ id: CH(2), start_s: 0 }]);
    insertVideo(db, { id: 5, youtube_id: "aaaaaaaaaaa", title: "Unshared here" });
    expect(() => applyShared(db, { videos: [video(SV2, { youtube_id: "aaaaaaaaaaa", content_hash: null })] })).toThrow(/reconcile/);
    expect(db.query("SELECT COUNT(*) n FROM videos WHERE id = ?").get(SV2)).toEqual({ n: 0 });
  });

  test("Proposed rows read through the *_all views with kind proposed; pointers resolve through the pairs; tombstones", () => {
    const db = open();
    const PS = U(901);
    const PV = U(902);
    const PA = U(903);
    applyShared(db, {
      video_proposed_songs: [{ id: PS, name: "zz-test Song", english_name: null, alternate_titles: null, notes: null, updated_at: T(5) }],
      video_proposed_versions: [{ id: PV, song_id: null, proposed_song_id: PS, version_label: "Complete", lyrics_cyrillic: "<p>Сөс</p>", lyrics_transliteration: null, lyrics_translation: null, footnotes_cyrillic: [{ id: 1, text: "n" }], footnotes_transliteration: null, updated_at: T(5) }],
      video_proposed_artists: [{ id: PA, name: "zz-test Artist", updated_at: T(5) }],
      videos: [video(SV1, { proposed_song_id: PS, proposed_version_id: PV })],
      video_artists: [{ id: U(904), video_id: SV1, artist_id: null, proposed_artist_id: PA, position: 0, suggested: true, updated_at: T(10) }],
    });
    expect(db.query("SELECT kind FROM song_all WHERE id = ?").get(PS)).toEqual({ kind: "proposed" });
    expect(db.query("SELECT song_id, label, kind, footnotes_cyrillic, footnotes_transliteration FROM version_all WHERE id = ?").get(PV)).toEqual({
      song_id: PS, label: "Complete", kind: "proposed", footnotes_cyrillic: '[{"id":1,"text":"n"}]', footnotes_transliteration: "[]",
    });
    expect(db.query("SELECT name, kind FROM artist_all WHERE id = ?").get(PA)).toEqual({ name: "zz-test Artist", kind: "proposed" });
    expect(db.query("SELECT song_id, version_id FROM video_full WHERE id = ?").get(SV1)).toEqual({ song_id: PS, version_id: PV });
    expect(db.query("SELECT artist_id, suggested FROM video_artist_full WHERE video_id = ?").get(SV1)).toEqual({ artist_id: PA, suggested: 1 });
    expect(songPointers(db, PS, PV)).toEqual({ song_id: null, proposed_song_id: PS, version_id: null, proposed_version_id: PV });
    // an elevated Song leaves the Proposed table (its archive row keeps the id); a deleted Artist goes
    const r = applyShared(db, {
      songs: [{ id: PS, name: "zz-test Song", slug: "zz-test-song", is_hidden: true, updated_at: T(6) }],
      tombstones: [{ table_name: "video_proposed_songs", row_id: PS, kind: "elevated", at: T(6) }, { table: "video_proposed_artists", row_id: PA, kind: "deleted", at: T(6) }],
    });
    expect(r.tombstones).toBe(2);
    expect(db.query("SELECT kind FROM song_all WHERE id = ?").all(PS)).toEqual([{ kind: "archive" }]);
    expect(db.query("SELECT COUNT(*) n FROM artist_all WHERE id = ?").get(PA)).toEqual({ n: 0 });
    expect(db.query("SELECT table_name, kind FROM shared_tombstone ORDER BY table_name").all()).toEqual([
      { table_name: "video_proposed_artists", kind: "deleted" }, { table_name: "video_proposed_songs", kind: "elevated" },
    ]);
    expect(() => applyShared(db, { tombstones: [{ table_name: "videos", row_id: SV1, kind: "deleted", at: T(7) }] })).toThrow(/unknown table/);
  });

  test("a soft-deleted Video leaves the views and the index; it stays in the Local copy", () => {
    const db = open();
    applyShared(db, { videos: [video(SV1)], video_chapters: [chapter(CH(1), SV1, 0)] });
    applyShared(db, { videos: [video(SV1, { deleted_at: T(11), delete_reason: "duplicate", updated_at: T(11) })], video_chapters: [chapter(CH(1), SV1, 0)] });
    expect(db.query("SELECT COUNT(*) n FROM video_full").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) n FROM chapter_full").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) n FROM videos").get()).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) n FROM search WHERE kind IN ('video', 'chapter')").get()).toEqual({ n: 0 });
  });

  test("a changed Song reindexes its Videos; above the threshold the index is rebuilt once", () => {
    const db = open();
    applyShared(db, { songs: [{ id: U(1), name: "Мезегей", slug: "m", updated_at: T(1) }], videos: [video(SV1, { song_id: U(1), title: "Untitled" })] });
    expect((db.query("SELECT text FROM search WHERE kind = 'video' AND ref_id = ?").get(SV1) as any).text).toContain("Мезегей");
    const r = applyShared(db, { songs: [{ id: U(1), name: "Межегей", slug: "m", updated_at: T(2) }] });
    expect(r.reindex).toBe("rows");
    expect((db.query("SELECT text FROM search WHERE kind = 'video' AND ref_id = ?").get(SV1) as any).text).toContain("Межегей");
    const many = Array.from({ length: REBUILD_THRESHOLD + 1 }, (_, i) => video(`aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`));
    expect(applyShared(db, { videos: many }).reindex).toBe("rebuild");
    expect(db.query("SELECT COUNT(*) n FROM search WHERE kind = 'video'").get()).toEqual({ n: REBUILD_THRESHOLD + 2 });
  });

  test("columns the Local copy does not hold are ignored; history rows are kept once", () => {
    const db = open();
    const h = { id: U(50), video_id: SV1, target_type: "video", target_id: SV1, editor_id: U(60), event_type: "video.scanned", field_name: null, old_value: null, new_value: { title: "x" }, description: null, created_at: T(10) };
    applyShared(db, { videos: [{ ...video(SV1), created_by: "someone" } as any], video_edit_history: [h, h] });
    expect(db.query("SELECT event_type, new_value FROM video_edit_history").all()).toEqual([{ event_type: "video.scanned", new_value: '{"title":"x"}' }]);
  });
});

describe("meta: the Shared schema, the Session record, Shelved edits, pending_share", () => {
  test("shared_schema is recorded by the migrations and matches the constant", () => {
    expect(localSharedSchema(open())).toBe(SHARED_SCHEMA);
  });
  test("the Session record is token-free, one row, kept per user, cleared by sign-out", () => {
    const db = open();
    expect(readSessionRecord(db)).toBeNull();
    expect(machineMode(null)).toBe("standalone");
    writeSessionRecord(db, { userId: U(1), email: "member@example.test", grantLevel: "member", displayName: "M" });
    writeSessionRecord(db, { userId: U(1), lastSyncAt: T(10), watermark: T(9) });
    const rec = readSessionRecord(db)!;
    expect(rec).toMatchObject({ userId: U(1), email: "member@example.test", grantLevel: "member", displayName: "M", lastSyncAt: T(10), watermark: T(9) });
    expect(Object.keys(rec).some((k) => /token/i.test(k))).toBe(false);
    expect(machineMode(rec)).toBe("member");
    writeSessionRecord(db, { userId: U(2), grantLevel: null });
    expect(readSessionRecord(db)).toMatchObject({ userId: U(2), email: null, watermark: null });
    expect(machineMode(readSessionRecord(db))).toBe("no-grant");
    clearSessionRecord(db);
    expect(readSessionRecord(db)).toBeNull();
  });
  test("Shelved edits: kept per Video, read back, cleared per Video or all", () => {
    const db = open();
    insertVideo(db, { id: 1, youtube_id: "aaaaaaaaaaa", title: "A" });
    insertVideo(db, { id: 2, youtube_id: "bbbbbbbbbbb", title: "B" });
    shelve(db, V(1), { kind: "title", title: "Old", titleLatin: null });
    shelve(db, V(1), { kind: "chapter", startS: 10, title: "c", songId: null, versionId: null, favoritedAt: "fav" });
    shelve(db, V(2), { kind: "artists", artistIds: [U(3)] });
    expect(listShelved(db, V(1)).map((s) => s.payload.kind)).toEqual(["title", "chapter"]);
    expect(clearShelved(db, V(1))).toBe(2);
    expect(listShelved(db).map((s) => s.videoId)).toEqual([V(2)]);
    expect(clearShelved(db)).toBe(1);
  });
  test("pending_share is a queue in video_local", () => {
    const db = open();
    insertVideo(db, { id: 1, youtube_id: "aaaaaaaaaaa", title: "A", created_at: T(2) });
    insertVideo(db, { id: 2, youtube_id: "bbbbbbbbbbb", title: "B", created_at: T(1) });
    setPendingShare(db, V(1), true);
    setPendingShare(db, V(2), true);
    expect(pendingShareIds(db)).toEqual([V(2), V(1)]);
    setPendingShare(db, V(2), false);
    expect(pendingShareIds(db)).toEqual([V(1)]);
  });
});

describe("data dir per platform (§8.2)", () => {
  test("macOS, Linux with and without XDG_DATA_HOME, Windows, and TUVA_DATA_DIR over all", () => {
    expect(dataDirFor("darwin", {}, "/Users/u")).toBe("/Users/u/Library/Application Support/TuvaVideos");
    expect(dataDirFor("linux", {}, "/home/u")).toBe("/home/u/.local/share/TuvaVideos");
    expect(dataDirFor("linux", { XDG_DATA_HOME: "/data" }, "/home/u")).toBe("/data/TuvaVideos");
    expect(dataDirFor("freebsd", {}, "/home/u")).toBe("/home/u/.local/share/TuvaVideos");
    expect(dataDirFor("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Roaming\\TuvaVideos");
    expect(dataDirFor("win32", {}, "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Roaming\\TuvaVideos");
    for (const p of ["darwin", "linux", "win32"] as const) expect(dataDirFor(p, { TUVA_DATA_DIR: "/tmp/m1" }, "/h")).toBe("/tmp/m1");
  });
});

describe("Origin and Host checks", () => {
  const req = (h: Record<string, string>) => new Request("http://localhost:4817/api/cache/apply", { method: "POST", headers: h });
  test("this companion's own pages pass; other sites, rebound hosts and Origin-less requests do not", () => {
    expect(localRequestError(req({ host: "localhost:4817", origin: "http://localhost:4817" }))).toBeNull();
    expect(localRequestError(req({ host: "127.0.0.1:4400", origin: "http://127.0.0.1:4400" }))).toBeNull();
    expect(localRequestError(req({ host: "localhost:4817", origin: "https://evil.example" }))).toMatch(/Origin/);
    expect(localRequestError(req({ host: "evil.example", origin: "http://evil.example" }))).toMatch(/Host/);
    expect(localRequestError(req({ host: "localhost:4817" }))).toMatch(/Origin/);
    expect(localRequestError(req({ host: "localhost:4817", origin: "http://localhost:4400" }))).toMatch(/Origin/); // another port is another origin
  });
});
