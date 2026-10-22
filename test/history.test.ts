// Undo, edit history and Shelved edits (sharing-spec §3.6, §4.7, §4.8, §7.4; ticket #147): the op inversion table and
// its `reverses` plumbing, history grouping, and the companion's reads (`/api/videos/:id/history`, `/api/edits`,
// `/api/shelved`).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { editBelongsTo } from "../src/shared/archiveWire";
import { decodeValue, editorLabel, groupWrites, type HistoryEntry } from "../src/shared/editHistory";
import { openDb } from "../src/server/db";
import { clearShelved, dropShelved, listEdits, shelvedItems, videoHistory } from "../src/server/editHistory";
import { shelve } from "../src/server/localCopy/meta";
import {
  ALREADY_UNDONE_LINE, archiveCall, CONFIRM_NOT_UNDOABLE_LINE, copyBackOp, GONE_LINE, inverseOf, NOT_HERE_LINE, NOT_RECORDED_LINE, NOT_UNDOABLE_LINE,
  routeFor, UNDO_SHARED_LINE, UNREJECTED_GONE_LINE, undoBlock, type ArchiveCallSpec, type LinkChapter, type LinkOp, type LinkVideo, type UndoContext,
} from "../src/web/writeOps";
import { insertChapterRejection, insertVideo, U } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const STAMP = "2026-10-17T10:00:00.000Z";
const video = (o: Partial<LinkVideo> = {}): LinkVideo => ({
  id: U(1), shared: true, updatedAt: STAMP, title: "Новый", titleLatin: "Novyi", titleLatinSource: "table", type: "song", typeSuggested: false,
  songId: "S2", versionId: null, songSuggested: false, artists: [], ...o,
});
const chapter = (o: Partial<LinkChapter> = {}): LinkChapter => ({ id: U(50), videoId: U(1), startS: 31, title: "New", suggested: false, updatedAt: "2026-10-17T09:00:00.000Z", songId: null, versionId: null, ...o });
const ctx = (o: Partial<UndoContext> = {}): UndoContext => ({ video: video(), chapters: [chapter()], ...o });
let n = 0;
const E = (eventType: string, o: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: `h${++n}`, videoId: U(1), videoTitle: "Новый", targetType: "video", targetId: U(1), editorId: "u1", eventType, fieldName: null, oldValue: null, newValue: null,
  description: eventType, reverses: null, reversedBy: null, rejectionId: null, createdAt: "2026-10-17T10:00:00.000Z", ...o,
});
const plan = (entries: HistoryEntry[], c = ctx()) => {
  const p = inverseOf(entries, c);
  if ("refused" in p) throw new Error(`refused: ${p.refused}`);
  return p;
};
const spec = (v: LinkVideo, op: LinkOp, opts?: Parameters<typeof archiveCall>[3]): ArchiveCallSpec => {
  const s = archiveCall(v, op, undefined, opts);
  if ("refused" in s) throw new Error(`refused: ${s.refused}`);
  return s;
};

describe("the inversion table (§4.7)", () => {
  test("a title change goes back, its generated Latin title with it; each Edit points at the row it inverts", () => {
    const t = E("video.title_changed", { fieldName: "title", oldValue: "Старый", newValue: "Новый" });
    const l = E("video.title_latin_changed", { fieldName: "title_latin", oldValue: "Staryi", newValue: "Novyi" });
    const p = plan([t, l]);
    expect(p.op).toEqual({ kind: "video.update", patch: { title: "Старый" } });
    const s = spec(video(), p.op, { reverses: p.reverses });
    expect(s.fn).toBe("write_videos");
    expect(s.args.p_expected_updated_at).toBe(STAMP); // checked against updated_at like any write
    expect(s.args.p_payload).toMatchObject({ title: "Старый", title_latin: "Staryi", title_latin_source: "table" });
    expect(s.args.p_edits.map((e) => [e.event_type, e.reverses])).toEqual([["video.title_changed", t.id], ["video.title_latin_changed", l.id]]);
  });
  test("a Latin title typed alone is put back as it was; type, Song and Version go back", () => {
    expect(plan([E("video.title_latin_changed", { fieldName: "title_latin", oldValue: "Old" })]).op).toEqual({ kind: "video.update", patch: { titleLatin: "Old" } });
    expect(plan([E("video.type_changed", { fieldName: "type", oldValue: "concert", newValue: "song" })]).op).toEqual({ kind: "video.update", patch: { type: "concert" } });
    const s = E("video.song_changed", { fieldName: "song_id", oldValue: "S1", newValue: "S2" });
    const v = E("video.version_changed", { fieldName: "version_id", oldValue: "V1", newValue: null });
    expect(plan([s, v]).op).toEqual({ kind: "video.update", patch: { songId: "S1", versionId: "V1" } });
    expect(plan([E("video.song_changed", { fieldName: "song_id", oldValue: null, newValue: "S2" })]).op).toEqual({ kind: "video.update", patch: { songId: null } });
  });
  test("soft delete and restore invert each other", () => {
    expect(plan([E("video.deleted", { fieldName: "delete_reason", newValue: "dup" })]).op).toEqual({ kind: "video.restore" });
    const p = plan([E("video.restored")]).op;
    expect(p.kind).toBe("video.delete");
    expect(spec(video(), p).args.p_op).toBe("delete");
  });
  test("Chapters: added -> deleted, changed -> the old values, deleted -> added back from the recorded Chapter", () => {
    expect(plan([E("chapter.added", { targetType: "chapter", targetId: U(50) })]).op).toEqual({ kind: "chapter.delete", chapter: chapter() });
    const ch = plan([
      E("chapter.changed", { targetType: "chapter", targetId: U(50), fieldName: "title", oldValue: "Old", newValue: "New" }),
      E("chapter.changed", { targetType: "chapter", targetId: U(50), fieldName: "start_s", oldValue: 30, newValue: 31 }),
    ]);
    expect(ch.op).toEqual({ kind: "chapter.update", chapter: chapter(), patch: { title: "Old", startS: 30 } });
    const s = spec(video(), ch.op, { reverses: ch.reverses });
    expect(s.args.p_expected_updated_at).toBe(chapter().updatedAt);
    expect(s.args.p_edits.map((e) => e.reverses)).toEqual(ch.reverses.map((r) => r.id));
    const del = spec(video(), { kind: "chapter.delete", chapter: chapter({ songId: "S1" }) });
    const back = plan([E("chapter.deleted", { targetType: "chapter", targetId: U(50), fieldName: "chapter", oldValue: del.args.p_edits[0]!.old_value })]);
    expect(back.op).toEqual({ kind: "chapter.add", chapter: { startS: 31, title: "New", songId: "S1", versionId: null } });
  });
  test("rejections are unrejected by the rejection's id, through their own function", () => {
    const c = plan([E("chapter.rejected", { targetType: "chapter", fieldName: "start_s", oldValue: 30, rejectionId: "R1" })]);
    expect(c.op).toEqual({ kind: "chapter.unreject", rejectionId: "R1" });
    const cs = spec(video(), c.op, { reverses: c.reverses });
    expect(cs).toMatchObject({ fn: "write_video_chapters", args: { p_op: "unreject", p_target: "R1" } });
    expect(editBelongsTo(cs.fn, cs.args.p_edits[0]!)).toBe(true);
    const a = plan([E("artist_link.rejected", { targetType: "artist_link", fieldName: "artist_id", oldValue: "A1", rejectionId: "R2" })]);
    const as = spec(video(), a.op);
    expect(as).toMatchObject({ fn: "write_video_artists", args: { p_op: "unreject", p_target: "R2" } });
    expect(editBelongsTo(as.fn, as.args.p_edits[0]!)).toBe(true);
    // undo-only ops never go to the companion's routes
    expect(routeFor({ shared: false }, c.op, "editor")).toEqual({ to: "refused", line: UNDO_SHARED_LINE });
  });
  test("Artists replaced -> the old list with its Suggested flags (ids recorded with names)", () => {
    const s = spec(video({ artists: [{ id: "A1", name: "Ай", nameLatin: null, local: false, proposed: false, suggested: false, linkId: "L1" }] }), { kind: "artists.set", artistIds: ["A2"] });
    const p = plan([E("artists.replaced", { fieldName: "artists", oldValue: s.args.p_edits[0]!.old_value, newValue: s.args.p_edits[0]!.new_value })]);
    expect(p.op).toEqual({ kind: "artists.set", artistIds: ["A1"], suggested: [] });
    // rows recorded before the flags: each Artist keeps its current flag
    expect(plan([E("artists.replaced", { fieldName: "artists", oldValue: [{ id: "A1", name: "Ай" }] })]).op).toEqual({ kind: "artists.set", artistIds: ["A1"] });
  });
  test("not undoable: scans, suggestions, elevations, the migration, confirmations, an undone write, unrecorded or gone rows", () => {
    for (const t of ["video.scanned", "video.migrated", "video.suggested", "chapter.suggested", "artists.suggested", "proposed.song_elevated", "proposed.migrated"])
      expect(undoBlock([E(t)])).toBe(NOT_UNDOABLE_LINE);
    expect(undoBlock([E("chapter.confirmed")])).toBe(CONFIRM_NOT_UNDOABLE_LINE);
    expect(undoBlock([E("video.type_changed", { oldValue: "song", newValue: "song" })])).toBe(CONFIRM_NOT_UNDOABLE_LINE);
    expect(undoBlock([E("video.title_changed", { reversedBy: "hX" })])).toBe(ALREADY_UNDONE_LINE);
    expect(undoBlock([E("chapter.deleted", { oldValue: 30 })])).toBe(NOT_RECORDED_LINE); // before the whole Chapter was recorded
    expect(undoBlock([E("artists.replaced", { oldValue: ["Ай"] })])).toBe(NOT_RECORDED_LINE);
    expect(undoBlock([E("chapter.rejected", { oldValue: 30 })])).toBe(UNREJECTED_GONE_LINE);
    for (const t of ["artist_link.repointed", "exposure.exposed", "proposed.song_created", "video.poster_changed"]) expect(undoBlock([E(t)])).toBe(NOT_HERE_LINE);
    expect(inverseOf([E("chapter.added", { targetId: "gone" })], ctx())).toEqual({ refused: GONE_LINE });
  });
  test("a confirmation inside a mixed write stays; the rest goes back", () => {
    const p = plan([E("video.type_changed", { fieldName: "type", oldValue: "song", newValue: "song" }), E("video.title_changed", { fieldName: "title", oldValue: "Старый" })]);
    expect(p.op).toEqual({ kind: "video.update", patch: { title: "Старый" } });
    expect(p.reverses).toHaveLength(1);
  });
});

describe("Shelved copy back (§7.4)", () => {
  test("each kind is an ordinary write", () => {
    expect(copyBackOp({ kind: "title", payload: { title: "Мой", titleLatin: null } })).toEqual({ kind: "video.update", patch: { title: "Мой" } });
    expect(copyBackOp({ kind: "type", payload: { type: "concert" } })).toEqual({ kind: "video.update", patch: { type: "concert" } });
    expect(copyBackOp({ kind: "song", payload: { songId: "S1", versionId: null } })).toEqual({ kind: "video.update", patch: { songId: "S1", versionId: null } });
    expect(copyBackOp({ kind: "artists", payload: { artistIds: ["A1", "A2"] } })).toEqual({ kind: "artists.set", artistIds: ["A1", "A2"] });
    expect(copyBackOp({ kind: "chapter", payload: { startS: 12, title: "X", songId: null, versionId: null, favoritedAt: null } })).toEqual({ kind: "chapter.add", chapter: { startS: 12, title: "X", songId: null, versionId: null } });
    expect(copyBackOp({ kind: "title", payload: { title: " " } })).toBeNull();
  });
});

describe("history grouping and values (§4.8)", () => {
  test("one call's Edits are one write; order kept, newest first", () => {
    const a = E("video.title_changed", { createdAt: "2026-10-17T10:00:02Z" });
    const b = E("video.title_latin_changed", { createdAt: "2026-10-17T10:00:02Z" });
    const c = E("video.type_changed", { createdAt: "2026-10-17T10:00:01Z" });
    const d = E("video.type_changed", { createdAt: "2026-10-17T10:00:01Z", editorId: "u2" });
    const g = groupWrites([a, b, c, d]);
    expect(g.map((x) => x.entries.map((e) => e.id))).toEqual([[a.id, b.id], [c.id], [d.id]]);
  });
  test("editor labels and decoded values", () => {
    expect(editorLabel("u1", "u1")).toBe("You");
    expect(editorLabel("abcdef0123456789", "u1")).toBe("Video Editor abcdef01");
    expect(editorLabel(null, "u1")).toBe("Unknown editor");
    expect(decodeValue('{"start_s":3}')).toEqual({ start_s: 3 });
    expect(decodeValue('"\\"A\\""')).toBe("A");
    expect(decodeValue("plain")).toBe("plain");
    expect(decodeValue(30)).toBe(30);
    expect(decodeValue(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The companion's reads
// ---------------------------------------------------------------------------------------------------------------

function seedHistory() {
  const db = openDb(":memory:", MIGRATIONS);
  const v1 = insertVideo(db, { title: "Хоомей", content_hash: "h1", shared: 1 });
  const v2 = insertVideo(db, { title: "Каргыраа", content_hash: "h2", shared: 1 });
  const h = db.prepare(
    "INSERT INTO video_edit_history (id, video_id, target_type, target_id, editor_id, event_type, field_name, old_value, new_value, description, reverses, created_at, updated_at) VALUES (?, ?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const row = (id: string, vid: string, editor: string, type: string, field: string | null, oldV: unknown, newV: unknown, at: string, reverses: string | null = null) =>
    h.run(id, vid, vid, editor, type, field, oldV as never, newV as never, type, reverses, at, at);
  row("h1", v1, "u1", "video.title_changed", "title", "Old", "Хоомей", "2026-10-17T10:00:01Z");
  row("h2", v1, "u1", "video.title_latin_changed", "title_latin", "Old", "Khoomei", "2026-10-17T10:00:01Z");
  row("h3", v1, "u2", "chapter.rejected", "start_s", 30, null, "2026-10-17T10:00:02Z");
  row("h4", v2, "u2", "chapter.deleted", "chapter", JSON.stringify({ start_s: 5, title: "Ч", song_id: null, version_id: null }), null, "2026-10-17T10:00:03Z");
  row("h5", v1, "u1", "video.title_changed", "title", "Хоомей", "Old", "2026-10-17T10:00:04Z", "h1");
  return { db, v1, v2 };
}

describe("GET /api/videos/:id/history and GET /api/edits", () => {
  test("a Video's history, newest first, with reversedBy, the held rejection and decoded values", () => {
    const { db, v1, v2 } = seedHistory();
    insertChapterRejection(db, { video_id: v1, source: "description", start_s: 30 });
    const rej = (db.query("SELECT id FROM video_chapter_rejections").get() as { id: string }).id;
    const h = videoHistory(db, v1);
    expect(h.map((e) => e.id)).toEqual(["h5", "h3", "h1", "h2"]);
    expect(h.find((e) => e.id === "h1")).toMatchObject({ reversedBy: "h5", videoTitle: "Хоомей", oldValue: "Old" });
    expect(h.find((e) => e.id === "h3")!.rejectionId).toBe(rej);
    expect(videoHistory(db, v2)[0]!.oldValue).toEqual({ start_s: 5, title: "Ч", song_id: null, version_id: null });
    expect(groupWrites(h).map((g) => g.entries.length)).toEqual([1, 1, 2]);
  });
  test("the Edits view filters by editor and type, and pages without splitting a write", () => {
    const { db } = seedHistory();
    expect(listEdits(db).entries.map((e) => e.id)).toEqual(["h5", "h4", "h3", "h1", "h2"]);
    expect(listEdits(db).editors).toEqual(["u1", "u2"]);
    expect(listEdits(db, { editor: "u2" }).entries.map((e) => e.id)).toEqual(["h4", "h3"]);
    expect(listEdits(db, { type: "chapter." }).entries.map((e) => e.id)).toEqual(["h4", "h3"]);
    expect(listEdits(db, { type: "artists.|artist_link." }).entries).toEqual([]);
    expect(listEdits(db, { type: "x'; drop" }).entries).toHaveLength(5); // a bad prefix is ignored, never SQL
    const p1 = listEdits(db, { limit: 4 });
    // h1 and h2 are one write: the cut falls inside it, so the page stops before it
    expect(p1.entries.map((e) => e.id)).toEqual(["h5", "h4", "h3"]);
    expect(p1.next).toBe("2026-10-17T10:00:02Z");
    expect(listEdits(db, { before: p1.next }).entries.map((e) => e.id)).toEqual(["h1", "h2"]);
  });
});

describe("Shelved edits: list, drop, clear (§7.4)", () => {
  test("the drawer's list names what the values point at; one, one Video's, or all go", () => {
    const db = openDb(":memory:", MIGRATIONS);
    db.exec("INSERT INTO archive_song (id, name, slug) VALUES ('s1', 'Mezhegei', 'mezhegei')");
    const v1 = insertVideo(db, { title: "Один", content_hash: "a", shared: 1 });
    const v2 = insertVideo(db, { title: "Два", content_hash: "b", shared: 1 });
    const a = shelve(db, v1, { kind: "title", title: "Мой", titleLatin: null }, "2026-10-17T10:00:00Z");
    shelve(db, v1, { kind: "song", songId: "s1", versionId: null }, "2026-10-17T10:00:00Z");
    shelve(db, v2, { kind: "chapter", startS: 75, title: "Ыр", songId: null, versionId: null, favoritedAt: null }, "2026-10-17T10:00:00Z");
    const all = shelvedItems(db);
    expect(all.map((i) => [i.videoTitle, i.kind, i.summary])).toEqual([
      ["Один", "title", "Title: Мой"],
      ["Один", "song", "Song: Mezhegei"],
      ["Два", "chapter", "Chapter at 1:15 “Ыр”"],
    ]);
    expect(all[0]).toMatchObject({ shared: true, payload: { title: "Мой", titleLatin: null } });
    // #157: each item is a red/green row against what the Video says now.
    expect(all.map((i) => i.diff)).toEqual([
      { attr: "title", label: "Title", before: "Мой", after: "Один" },
      { attr: "song", label: "Song", before: "Mezhegei", after: "No Song" },
      { attr: "chapter", label: "Chapter at 1:15", before: "“Ыр”", after: "No Chapter here" },
    ]);
    expect(shelvedItems(db, v2)).toHaveLength(1);
    expect(dropShelved(db, a)).toBe(true);
    expect(dropShelved(db, a)).toBe(false);
    expect(clearShelved(db, v1)).toBe(1);
    expect(clearShelved(db)).toBe(1);
    expect(shelvedItems(db)).toEqual([]);
  });
});
