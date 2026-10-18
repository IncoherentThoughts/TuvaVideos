// The client write seam (sharing-spec §4.1–§4.3, §4.5, §4.9; ticket #145): op -> function / payload / stamp / Edits,
// routing by mode, the local routes, a line for every wire word, the conflict reducer; and the companion's reads
// (kinds, the matchers on Shared Videos, the deleted-match warning) and `removeCopies`.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editBelongsTo, ERROR_CODES, OPS, STAMP_REQUIRED, type ArchiveError, type ConflictDetail, type WireWord } from "../src/shared/archiveWire";
import type { ArtistRef } from "../src/shared/types";
import { openDb } from "../src/server/db";
import { removeCopies } from "../src/server/deleteVideo";
import { deletedMatches, kindsOf, sharedSuggestions } from "../src/server/sharedWrites";
import type { Roots } from "../src/server/roots";
import {
  archiveCall, conflictLines, conflictReducer, IDLE_CONFLICT, kindsNeeded, LOCAL_ROW_LINE, localRequest, NOTHING_TO_CHANGE, OFFLINE_WRITE_LINE, READ_ONLY_LINE,
  routeFor, SHARED_ONLY_LINE, SIGNED_OUT_WRITE_LINE, writeErrorLine,
  type ArchiveCallSpec, type ConflictEntry, type Kinds, type LinkChapter, type LinkOp, type LinkVideo,
} from "../src/web/writeOps";
import { insertChapter, insertCopy, insertVideo, U } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const STAMP = "2026-10-17T10:00:00.000Z";
const ART = (id: string, o: Partial<ArtistRef> = {}): ArtistRef => ({ id, name: `A-${id.slice(-2)}`, nameLatin: null, local: false, proposed: false, suggested: false, linkId: `L${id}`, ...o });
const video = (o: Partial<LinkVideo> = {}): LinkVideo => ({
  id: U(1), shared: true, updatedAt: STAMP, title: "Чаңгыс", titleLatin: "Chaŋgys", titleLatinSource: "table", type: "song", typeSuggested: false,
  songId: null, versionId: null, songSuggested: false, artists: [], ...o,
});
const chapter = (o: Partial<LinkChapter> = {}): LinkChapter => ({ id: U(50), videoId: U(1), startS: 30, title: "Old", suggested: false, updatedAt: "2026-10-17T09:00:00.000Z", songId: null, versionId: null, ...o });
const spec = (v: LinkVideo, op: LinkOp, kinds?: Kinds, opts?: Parameters<typeof archiveCall>[3]): ArchiveCallSpec => {
  const s = archiveCall(v, op, kinds, opts);
  if ("refused" in s) throw new Error(`refused: ${s.refused}`);
  return s;
};

/** Every call is one the archive accepts on its face: a known op, the stamp where required, Edits of its family. */
function wellFormed(s: ArchiveCallSpec) {
  expect((OPS[s.fn] as readonly string[]).includes(s.args.p_op)).toBe(true);
  if (((STAMP_REQUIRED[s.fn] ?? []) as readonly string[]).includes(s.args.p_op)) expect(s.args.p_expected_updated_at).toBeTruthy();
  expect(s.args.p_edits.length).toBeGreaterThan(0);
  for (const e of s.args.p_edits) expect(editBelongsTo(s.fn, e)).toBe(true);
  expect("id" in s.args.p_payload && s.fn === "write_videos").toBe(false);
}

const VIDEO_UPDATE_KEYS = new Set(["title", "type", "type_suggested", "song_id", "proposed_song_id", "version_id", "proposed_version_id", "song_suggested", "suggestion_source", "title_latin", "title_latin_source", "instagram_id", "rutube_id", "poster_path"]);
const CHAPTER_KEYS = new Set(["id", "start_s", "title", "title_latin", "song_id", "proposed_song_id", "version_id", "proposed_version_id", "suggested", "source"]);

describe("routing by mode (§4.9)", () => {
  const op: LinkOp = { kind: "video.update", patch: { title: "x" } };
  test("a Shared Video on a Video Editor's machine goes to the archive", () => {
    expect(routeFor({ shared: true }, op, "editor")).toEqual({ to: "archive" });
  });
  test("a Shared Video elsewhere is read-only", () => {
    for (const m of ["member", "no-grant", "standalone"] as const) expect(routeFor({ shared: true }, op, m)).toEqual({ to: "refused", line: READ_ONLY_LINE });
  });
  test("an Unshared or Standalone Video takes the companion's routes, in every mode", () => {
    for (const m of ["editor", "member", "no-grant", "standalone"] as const) expect(routeFor({ shared: false }, op, m)).toEqual({ to: "local" });
  });
  test("soft delete, restore and matcher writes are for Shared Videos only", () => {
    for (const kind of ["video.delete", "video.restore", "video.suggest"] as const) expect(routeFor({ shared: false }, { kind }, "editor")).toEqual({ to: "refused", line: SHARED_ONLY_LINE });
  });
});

describe("the local routes are the existing ones, unchanged", () => {
  const v = { id: U(1) };
  const c = chapter();
  test.each([
    [{ kind: "video.update", patch: { title: "T" } }, "PATCH", `/api/videos/${U(1)}`, { title: "T" }],
    [{ kind: "artists.set", artistIds: ["a"] }, "PUT", `/api/videos/${U(1)}/artists`, { artistIds: ["a"] }],
    [{ kind: "artists.remove", artistId: "a" }, "DELETE", `/api/videos/${U(1)}/artists/a`, undefined],
    [{ kind: "artists.confirm" }, "POST", `/api/videos/${U(1)}/artists/confirm`, undefined],
    [{ kind: "chapter.add", chapter: { startS: 5 } }, "POST", `/api/videos/${U(1)}/chapters`, { startS: 5 }],
    [{ kind: "chapter.update", chapter: c, patch: { title: "N" } }, "PATCH", `/api/chapters/${U(50)}`, { title: "N" }],
    [{ kind: "chapter.delete", chapter: c }, "DELETE", `/api/chapters/${U(50)}`, undefined],
    [{ kind: "chapter.confirm", chapter: c }, "POST", `/api/chapters/${U(50)}/confirm`, undefined],
    [{ kind: "chapter.reject", chapter: c }, "POST", `/api/chapters/${U(50)}/reject`, undefined],
    [{ kind: "chapters.confirmAll" }, "POST", `/api/videos/${U(1)}/chapters/confirm-all`, undefined],
  ] as [LinkOp, string, string, unknown][])("%o", (op, method, url, body) => {
    expect(localRequest(v, op)).toEqual(body === undefined ? { method, url } as never : { method, url, body } as never);
  });
});

describe("op -> function, payload, stamp and Edits (§4.1)", () => {
  test("title: write_videos update with the Video's stamp, the Latin title computed in the browser (§4.3)", () => {
    const s = spec(video(), { kind: "video.update", patch: { title: "  Эзир-Кара  " } });
    wellFormed(s);
    expect(s.fn).toBe("write_videos");
    expect(s.args).toMatchObject({ p_op: "update", p_target: U(1), p_expected_updated_at: STAMP });
    expect(s.args.p_payload).toEqual({ title: "Эзир-Кара", title_latin: "Ezir-Kara", title_latin_source: "table" });
    expect(s.args.p_edits.map((e) => e.event_type)).toEqual(["video.title_changed", "video.title_latin_changed"]);
    expect(s.args.p_edits[0]).toMatchObject({ field_name: "title", old_value: "Чаңгыс", new_value: "Эзир-Кара" });
  });
  test("a manual Latin title is kept on a title change; a typed one is manual; clearing hands it back to the table", () => {
    expect(spec(video({ titleLatinSource: "manual", titleLatin: "Mine" }), { kind: "video.update", patch: { title: "Новый" } }).args.p_payload).toEqual({ title: "Новый" });
    expect(spec(video(), { kind: "video.update", patch: { titleLatin: " Changgys " } }).args.p_payload).toEqual({ title_latin: "Changgys", title_latin_source: "manual" });
    expect(spec(video({ titleLatin: "Mine", titleLatinSource: "manual" }), { kind: "video.update", patch: { titleLatin: "" } }).args.p_payload).toEqual({ title_latin: "Chaŋgys", title_latin_source: "table" });
    // a Latin title with no Cyrillic is null
    expect(spec(video({ title: "Ezir", titleLatin: null, titleLatinSource: null }), { kind: "video.update", patch: { title: "Kargyraa" } }).args.p_payload).toEqual({ title: "Kargyraa" });
  });
  test("an unchanged title is no call at all", () => {
    expect(archiveCall(video(), { kind: "video.update", patch: { title: "Чаңгыс" } })).toEqual({ refused: NOTHING_TO_CHANGE });
  });
  test("type and Song: manual, confirmed, pointer pairs from the kinds", () => {
    const k: Kinds = { songs: { S1: "archive", P1: "proposed" }, versions: { PV: "proposed" }, artists: {} };
    const t = spec(video({ typeSuggested: true }), { kind: "video.update", patch: { type: "concert" } }, k);
    expect(t.args.p_payload).toEqual({ type: "concert", type_suggested: false, suggestion_source: "manual" });
    const s = spec(video(), { kind: "video.update", patch: { songId: "P1", versionId: "PV" } }, k);
    wellFormed(s);
    expect(s.args.p_payload).toEqual({ song_id: null, proposed_song_id: "P1", version_id: null, proposed_version_id: "PV", song_suggested: false, suggestion_source: "manual" });
    expect(s.args.p_edits.map((e) => e.event_type)).toEqual(["video.song_changed", "video.version_changed"]);
    // a different Song starts on its default Version
    const d = spec(video({ songId: "P1", versionId: "PV" }), { kind: "video.update", patch: { songId: "S1" } }, k);
    expect(d.args.p_payload).toMatchObject({ song_id: "S1", proposed_song_id: null, version_id: null, proposed_version_id: null });
    // confirming a Suggested Song
    const c = spec(video({ songId: "S1", songSuggested: true }), { kind: "video.update", patch: { songId: "S1" } }, k);
    expect(c.args.p_payload).toMatchObject({ song_id: "S1", song_suggested: false });
    expect(c.args.p_edits[0]!.description).toBe("Song confirmed");
    for (const x of [t, s, d, c]) for (const key of Object.keys(x.args.p_payload)) expect(VIDEO_UPDATE_KEYS.has(key)).toBe(true);
  });
  test("a Local Song, Version or Artist is refused on a Shared Video", () => {
    const k: Kinds = { songs: { L1: "local" }, versions: { LV: "local" }, artists: { LA: "local" } };
    expect(archiveCall(video(), { kind: "video.update", patch: { songId: "L1" } }, k)).toEqual({ refused: LOCAL_ROW_LINE });
    expect(archiveCall(video(), { kind: "artists.set", artistIds: ["LA"] }, k)).toEqual({ refused: LOCAL_ROW_LINE });
    expect(archiveCall(video(), { kind: "chapter.add", chapter: { startS: 1, songId: "S", versionId: "LV" } }, k)).toEqual({ refused: LOCAL_ROW_LINE });
  });
  test("soft delete needs a reason; restore; both stamped (§4.5)", () => {
    expect(archiveCall(video(), { kind: "video.delete", reason: "  " })).toEqual({ refused: "a reason is required to delete a Shared Video" });
    const d = spec(video(), { kind: "video.delete", reason: " duplicate upload " });
    wellFormed(d);
    expect(d.args).toMatchObject({ p_op: "delete", p_payload: { reason: "duplicate upload" }, p_expected_updated_at: STAMP });
    expect(d.args.p_edits[0]!.event_type).toBe("video.deleted");
    const r = spec(video(), { kind: "video.restore" });
    wellFormed(r);
    expect(r.args).toMatchObject({ p_op: "restore", p_payload: {}, p_expected_updated_at: STAMP });
  });
  test("a stamp override (apply mine) replaces the row's", () => {
    expect(spec(video(), { kind: "video.restore" }, undefined, { stamp: "2026-10-17T11:11:11.000Z" }).args.p_expected_updated_at).toBe("2026-10-17T11:11:11.000Z");
    expect(spec(video(), { kind: "chapter.delete", chapter: chapter() }, undefined, { stamp: "X" }).args.p_expected_updated_at).toBe("X");
  });
  test("matcher writes are Suggested, video.suggested (§4.3)", () => {
    const s = spec(video(), { kind: "video.suggest", patch: { type: "song", songId: "S1", source: "performance" } }, { songs: { S1: "archive" }, versions: {}, artists: {} });
    wellFormed(s);
    expect(s.args.p_payload).toEqual({ suggestion_source: "performance", type: "song", type_suggested: true, song_id: "S1", proposed_song_id: null, version_id: null, proposed_version_id: null, song_suggested: true });
    expect(s.args.p_edits[0]!.event_type).toBe("video.suggested");
  });
  test("Artists: replace keeps order and Suggested flags, with the Video's stamp", () => {
    const k: Kinds = { songs: {}, versions: {}, artists: { [U(11)]: "archive", [U(12)]: "proposed", [U(13)]: "archive" } };
    const v = video({ artists: [ART(U(11)), ART(U(12), { suggested: true, proposed: true })] });
    const s = spec(v, { kind: "artists.set", artistIds: [U(12), U(11), U(13), U(11)] }, k);
    wellFormed(s);
    expect(s.fn).toBe("write_video_artists");
    expect(s.args).toMatchObject({ p_op: "replace", p_target: U(1), p_expected_updated_at: STAMP });
    expect(s.args.p_payload).toEqual({ artists: [{ proposed_artist_id: U(12), suggested: true }, { artist_id: U(11), suggested: false }, { artist_id: U(13), suggested: false }] });
  });
  test("Artists: a Suggested one is rejected by link id; a confirmed one removed by replace; confirm_all", () => {
    const k: Kinds = { songs: {}, versions: {}, artists: { [U(11)]: "archive", [U(12)]: "archive" } };
    const v = video({ artists: [ART(U(11)), ART(U(12), { suggested: true })] });
    const rej = spec(v, { kind: "artists.remove", artistId: U(12) }, k);
    wellFormed(rej);
    expect(rej.args).toMatchObject({ p_op: "reject", p_target: `L${U(12)}`, p_expected_updated_at: null });
    expect(rej.args.p_edits[0]!.event_type).toBe("artist_link.rejected");
    const rm = spec(v, { kind: "artists.remove", artistId: U(11) }, k);
    expect(rm.args).toMatchObject({ p_op: "replace", p_payload: { artists: [{ artist_id: U(12), suggested: true }] }, p_expected_updated_at: STAMP });
    const all = spec(v, { kind: "artists.confirm" });
    wellFormed(all);
    expect(all.args).toMatchObject({ p_op: "confirm_all", p_target: U(1) });
  });
  test("Chapters: add (minted id, Latin title), update (the Chapter's stamp, confirms a Suggested one), delete, confirm, reject, confirm_all", () => {
    const k: Kinds = { songs: { S1: "archive" }, versions: {}, artists: {} };
    const add = spec(video(), { kind: "chapter.add", chapter: { startS: 12.5, title: "Ыры", songId: "S1" } }, k, { newId: U(77) });
    wellFormed(add);
    expect(add.minted).toBe(U(77));
    expect(add.fn).toBe("write_video_chapters");
    expect(add.args).toMatchObject({ p_op: "add", p_target: U(1), p_expected_updated_at: null });
    expect(add.args.p_payload).toEqual({ id: U(77), start_s: 12.5, title: "Ыры", title_latin: "Yry", song_id: "S1", proposed_song_id: null, version_id: null, proposed_version_id: null, suggested: false, source: "manual" });
    // an untitled Chapter is "" (the Local copy keeps title NOT NULL; null would fail the apply)
    expect(spec(video(), { kind: "chapter.add", chapter: { startS: 3 } }).args.p_payload).toMatchObject({ title: "", title_latin: null });
    const c = chapter({ suggested: true });
    const up = spec(video(), { kind: "chapter.update", chapter: c, patch: { title: "Новое", startS: 31 } });
    wellFormed(up);
    expect(up.args).toMatchObject({ p_op: "update", p_target: U(50), p_expected_updated_at: c.updatedAt });
    expect(up.args.p_payload).toEqual({ title: "Новое", title_latin: "Novoe", start_s: 31, suggested: false });
    // attaching a Song does not confirm it
    expect(spec(video(), { kind: "chapter.update", chapter: c, patch: { songId: "S1" } }, k).args.p_payload).not.toHaveProperty("suggested");
    for (const x of [add, up]) for (const key of Object.keys(x.args.p_payload)) expect(CHAPTER_KEYS.has(key)).toBe(true);
    for (const [kind, p_op, stamp] of [["chapter.delete", "delete", c.updatedAt], ["chapter.confirm", "confirm", c.updatedAt], ["chapter.reject", "reject", c.updatedAt]] as const) {
      const s = spec(video(), { kind, chapter: c });
      wellFormed(s);
      expect(s.args).toMatchObject({ p_op, p_target: U(50), p_expected_updated_at: stamp, p_payload: {} });
    }
    const all = spec(video(), { kind: "chapters.confirmAll" });
    wellFormed(all);
    expect(all.args).toMatchObject({ p_op: "confirm_all", p_target: U(1) });
  });
  test("kindsNeeded asks for the ids the call will point at", () => {
    expect(kindsNeeded(video({ songId: "S0" }), { kind: "video.update", patch: { versionId: "V1" } })).toEqual({ songs: ["S0"], versions: ["V1"], artists: [] });
    expect(kindsNeeded(video(), { kind: "video.update", patch: { title: "x" } })).toEqual({ songs: [], versions: [], artists: [] });
    expect(kindsNeeded(video({ artists: [ART("a1"), ART("a2")] }), { kind: "artists.remove", artistId: "a1" }).artists).toEqual(["a1", "a2"]);
  });
});

describe("a line for every wire word (§4.2)", () => {
  const err = (word: WireWord, detail: unknown = null) => ({ word, code: Object.entries(ERROR_CODES).find(([, w]) => w === word)![0], message: "raw", detail }) as ArchiveError;
  test("each word has its own non-empty line", () => {
    const lines = (Object.values(ERROR_CODES) as WireWord[]).map((w) => writeErrorLine(err(w, w === "duplicate-candidate" ? [] : null)));
    for (const l of lines) expect(l.length).toBeGreaterThan(10);
    expect(new Set(lines).size).toBe(lines.length);
  });
  test("details are used", () => {
    expect(writeErrorLine(err("duplicate-candidate", [{ kind: "archive", id: "x", name: "Ezir-Kara" }]))).toBe("Already exists: Ezir-Kara (archive).");
    expect(writeErrorLine(err("in-use", { count: 3 }))).toBe("Still in use by 3 rows.");
    expect(writeErrorLine(err("malformed"))).toContain("raw");
  });
  test("unreachable and unauthorized win over the word", () => {
    const u = { word: "unknown", code: null, message: "fetch failed", detail: null } as ArchiveError;
    expect(writeErrorLine(u, { unreachable: true })).toBe(OFFLINE_WRITE_LINE);
    expect(writeErrorLine(u, { unauthorized: true })).toBe(SIGNED_OUT_WRITE_LINE);
    expect(writeErrorLine(u)).toBe("fetch failed");
  });
});

describe("the conflict notice's reducer (§4.2)", () => {
  const detail: ConflictDetail = { table: "videos", id: U(1), updated_at: "2026-10-17T10:05:00.000Z", last_edit: { id: "h1", editor_id: "u2", event_type: "video.title_changed", field_name: "title", old_value: "A", new_value: "B", created_at: "2026-10-17T10:05:00.000Z" } };
  const entry: ConflictEntry = { video: video(), op: { kind: "video.update", patch: { title: "Mine" } }, detail };
  test("raised -> reloading -> shown -> keep theirs (the default) -> idle", () => {
    let s = conflictReducer(IDLE_CONFLICT, { type: "raised", entry });
    expect(s.phase).toBe("reloading");
    const fresh = video({ title: "B", updatedAt: detail.updated_at });
    s = conflictReducer(s, { type: "reloaded", video: fresh });
    expect(s).toEqual({ phase: "shown", entry: { ...entry, video: fresh }, error: null });
    expect(conflictReducer(s, { type: "keep-theirs" })).toBe(IDLE_CONFLICT);
  });
  test("apply mine -> applying -> applied, or failed back to shown, or another conflict reloads again", () => {
    const shown = conflictReducer(conflictReducer(IDLE_CONFLICT, { type: "raised", entry }), { type: "reloaded" });
    const applying = conflictReducer(shown, { type: "apply-mine" });
    expect(applying.phase).toBe("applying");
    expect(conflictReducer(applying, { type: "keep-theirs" })).toBe(applying); // buttons are disabled meanwhile
    expect(conflictReducer(applying, { type: "applied" })).toBe(IDLE_CONFLICT);
    expect(conflictReducer(applying, { type: "failed", error: "offline" })).toMatchObject({ phase: "shown", error: "offline" });
    const again = conflictReducer(applying, { type: "conflict-again", detail: null });
    expect(again).toMatchObject({ phase: "reloading", entry: { detail: null } });
  });
  test("stray actions are ignored when idle", () => {
    for (const a of [{ type: "keep-theirs" }, { type: "apply-mine" }, { type: "applied" }, { type: "reloaded" }] as const) expect(conflictReducer(IDLE_CONFLICT, a)).toBe(IDLE_CONFLICT);
  });
  test("who, when, old -> new", () => {
    const now = Date.parse("2026-10-17T10:08:00.000Z");
    expect(conflictLines(detail, "u1", now)).toEqual({ who: "Another Video Editor", when: "3 min ago", change: "title: A → B" });
    expect(conflictLines(detail, "u2", now).who).toContain("You");
    expect(conflictLines(null, "u1", now)).toEqual({ who: "Someone", when: null, change: null });
    // JSON-encoded history values read as their text
    expect(conflictLines({ ...detail, last_edit: { ...detail.last_edit!, old_value: '"A"', new_value: '"B"' } }, "u1", now).change).toBe("title: A → B");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The companion's side
// ---------------------------------------------------------------------------------------------------------------

const fakeRoots = (paths: Record<number, string>, mounted = true) => ({ get: (id: number) => (paths[id] ? { id, path: paths[id], kind: "local" } : undefined), isAvailable: () => mounted }) as unknown as Roots;

describe("kinds, the matchers on Shared Videos, deleted matches (§4.3, §4.5)", () => {
  test("GET /api/kinds", () => {
    const db = openDb(":memory:", MIGRATIONS);
    db.exec("INSERT INTO archive_song (id, name, slug) VALUES ('s-archive-1', 'Mezhegei', 'mezhegei')");
    db.exec("INSERT INTO video_proposed_songs (id, name, updated_at) VALUES ('s-proposed-1', 'New', '2026-10-17T00:00:00Z')");
    db.exec("INSERT INTO local_song (id, name, created_at) VALUES ('s-local-01', 'Mine', '2026-10-17T00:00:00Z')");
    const k = kindsOf(db, new URLSearchParams({ songs: "s-archive-1,s-proposed-1,s-local-01,unknown-id1,x;drop" }));
    expect(k.songs).toEqual({ "s-archive-1": "archive", "s-proposed-1": "proposed", "s-local-01": "local" });
  });
  test("matchers run against Shared Videos without writing, only where nothing was set", () => {
    const db = openDb(":memory:", MIGRATIONS);
    db.exec("INSERT INTO archive_song (id, name, slug) VALUES ('m1', 'Mezhegei', 'mezhegei'), ('m2', 'Karachal', 'karachal')");
    db.exec("INSERT INTO archive_performance (id, song_id, youtube_id, display_order, is_highlighted) VALUES ('p1', 'm2', 'aaaaaaaaaaa', 1, 0)");
    const perf = insertVideo(db, { title: "Concert clip", youtube_id: "aaaaaaaaaaa", type: "song", shared: 1 });
    const byTitle = insertVideo(db, { title: "Huun Huur Tu - Mezhegei", content_hash: "h1", type: "other", shared: 1 });
    const manual = insertVideo(db, { title: "Alash - Mezhegei", content_hash: "h2", type: "other", suggestion_source: "manual", shared: 1 });
    const unshared = insertVideo(db, { title: "Tyva - Mezhegei", content_hash: "h3", type: "other", shared: 0 });
    const out = sharedSuggestions(db);
    expect(out.map((o) => [o.videoId, o.patch])).toEqual([
      [perf, { type: "song", songId: "m2", source: "performance" }],
      [byTitle, { songId: "m1", source: "title", type: "song" }],
    ]);
    expect(out.some((o) => o.videoId === manual || o.videoId === unshared)).toBe(false);
    // nothing was written to the Shared rows
    expect(db.query("SELECT COUNT(*) n FROM videos WHERE song_id IS NOT NULL AND id IN (?, ?)").get(perf, byTitle)).toEqual({ n: 0 });
  });
  test("a soft-deleted Video with a file here is a scan warning; Missing Copies are not", () => {
    const db = openDb(":memory:", MIGRATIONS);
    db.exec("INSERT INTO root (id, path, kind) VALUES (1, '/r', 'local')");
    const gone = insertVideo(db, { title: "Gone", content_hash: "g", shared: 1, deleted_at: "2026-10-16T00:00:00Z", deleted_by: "u2", delete_reason: "duplicate" });
    const alive = insertVideo(db, { title: "Alive", content_hash: "a", shared: 1 });
    insertCopy(db, { video_id: gone, root_id: 1, rel_path: "g.mp4" });
    insertCopy(db, { video_id: gone, root_id: 1, rel_path: "g2.mp4", missing_since: "2026-10-16T00:00:00Z" });
    insertCopy(db, { video_id: alive, root_id: 1, rel_path: "a.mp4" });
    const w = deletedMatches(db, fakeRoots({ 1: "/r" }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ id: gone, title: "Gone", deletedBy: "u2", reason: "duplicate", files: ["/r/g.mp4"] });
  });
});

describe("DELETE /api/videos/:id/copies (§4.5)", () => {
  const base = mkdtempSync(join(tmpdir(), "tuva-copies-"));
  const rootDir = join(base, "root");
  const trashDir = join(base, "trash");
  mkdirSync(rootDir, { recursive: true });
  mkdirSync(trashDir, { recursive: true });
  const bin = join(base, "fake-trash.sh");
  writeFileSync(bin, `#!/bin/sh\nmv "$1" "${trashDir}/"\n`);
  chmodSync(bin, 0o755);

  test("trashes this machine's files, keeps the Video and its Chapters; a missing Copy's row goes too", async () => {
    const db = openDb(":memory:", MIGRATIONS);
    db.exec(`INSERT INTO root (id, path, kind) VALUES (1, '${rootDir}', 'local')`);
    const v = insertVideo(db, { title: "Shared one", content_hash: "s", shared: 1 });
    insertChapter(db, { video_id: v, start_s: 3 });
    writeFileSync(join(rootDir, "s.mp4"), "x");
    insertCopy(db, { video_id: v, root_id: 1, rel_path: "s.mp4" });
    insertCopy(db, { video_id: v, root_id: 1, rel_path: "old.mp4", missing_since: "2026-10-01T00:00:00Z" });
    const r = await removeCopies(db, { remuxDir: base, trash: bin }, fakeRoots({ 1: rootDir }), v);
    expect(r).toEqual({ trashed: [join(rootDir, "s.mp4")], kept: [], remaining: 0 });
    expect(existsSync(join(trashDir, "s.mp4"))).toBe(true);
    expect(db.query("SELECT COUNT(*) n FROM copy").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) n FROM video_full WHERE id = ?").get(v)).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) n FROM video_chapters WHERE video_id = ?").get(v)).toEqual({ n: 1 });
  });
  test("an unmounted drive keeps its file and its Copy; an unknown Video is null", async () => {
    const db = openDb(":memory:", MIGRATIONS);
    db.exec(`INSERT INTO root (id, path, kind) VALUES (1, '${rootDir}', 'external')`);
    const v = insertVideo(db, { title: "Elsewhere", content_hash: "e", shared: 1 });
    insertCopy(db, { video_id: v, root_id: 1, rel_path: "e.mp4" });
    const r = await removeCopies(db, { remuxDir: base, trash: bin }, fakeRoots({ 1: rootDir }, false), v);
    expect(r).toEqual({ trashed: [], kept: [{ path: join(rootDir, "e.mp4"), reason: "drive not mounted" }], remaining: 1 });
    expect(await removeCopies(db, { remuxDir: base, trash: bin }, fakeRoots({}), U(999))).toBeNull();
  });
});
