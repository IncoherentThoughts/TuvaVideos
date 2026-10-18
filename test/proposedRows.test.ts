// Proposed rows, Elevate, Expose, Repoint (sharing-spec §3.4, §3.5, §4.4, §4.6, §7.5; ticket #146): op -> function /
// payload / stamp / Edits for every row write, role gating, the duplicate-candidate list's rules, the in-use line, the
// Repoint plans (and that each step is a call the archive accepts), and the companion's `GET /api/rows` read.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { editBelongsTo, OPS, STAMP_REQUIRED, type DuplicateCandidate } from "../src/shared/archiveWire";
import { openDb } from "../src/server/db";
import { rowInfo, type RowInfo } from "../src/server/sharedWrites";
import {
  archiveCall, artistRepointPlan, candidateRows, CONFIRM_PUBLIC_LINE, duplicatePrompt, ELEVATE_ROLE_LINE, ELEVATE_SONG_FIRST_LINE, EXPOSE_ROLE_LINE, inUseLine,
  LOCAL_ROW_LINE, LOCAL_TARGET_LINE, localRepointRequest, NO_ROLES, NOTHING_TO_CHANGE, PROPOSE_ROLE_LINE, repointPlan, rowCall, rowKindsNeeded, rowRefusal, rowRoles,
  type ArchiveCallSpec, type Kinds, type RowOp,
} from "../src/web/writeOps";
import { insertArchiveArtist, insertChapter, insertLocalArtist, insertVideo, linkArtist, U } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const STAMP = "2026-10-17T10:00:00.000Z";
const NEW = U(900);
const K = (o: Partial<Kinds> = {}): Kinds => ({ songs: {}, versions: {}, artists: {}, ...o });

const spec = (op: RowOp, kinds?: Kinds, opts: Parameters<typeof rowCall>[2] = { newId: NEW }): ArchiveCallSpec => {
  const s = rowCall(op, kinds, opts);
  if ("refused" in s) throw new Error(`refused: ${s.refused}`);
  return s;
};
const refused = (op: RowOp, kinds?: Kinds, opts: Parameters<typeof rowCall>[2] = { newId: NEW }) => {
  const s = rowCall(op, kinds, opts);
  return "refused" in s ? s.refused : null;
};

/** A call the archive accepts on its face: a known op, the stamp where required, Edits of its family (`[]` for elevate_*). */
function wellFormed(s: ArchiveCallSpec) {
  expect((OPS[s.fn] as readonly string[]).includes(s.args.p_op)).toBe(true);
  if (((STAMP_REQUIRED[s.fn] ?? []) as readonly string[]).includes(s.args.p_op)) expect(s.args.p_expected_updated_at).toBeTruthy();
  if (s.fn.startsWith("elevate_")) expect(s.args.p_edits).toEqual([]);
  else {
    expect(s.args.p_edits.length).toBeGreaterThan(0);
    for (const e of s.args.p_edits) expect(editBelongsTo(s.fn, e)).toBe(true);
  }
}

describe("role gating (§3.5, §4.4, §7.5)", () => {
  test("from the Session record's grant and archive_role", () => {
    expect(rowRoles(null)).toEqual(NO_ROLES);
    expect(rowRoles({ grantLevel: "member", archiveRole: null })).toEqual({ propose: false, elevate: false, expose: false });
    expect(rowRoles({ grantLevel: "editor", archiveRole: null })).toEqual({ propose: true, elevate: false, expose: false });
    expect(rowRoles({ grantLevel: "editor", archiveRole: "moderator" })).toEqual({ propose: true, elevate: true, expose: false });
    expect(rowRoles({ grantLevel: "editor", archiveRole: "admin" })).toEqual({ propose: true, elevate: true, expose: true });
    // Expose is the archive admin's alone (set_song_exposure gates get_my_role() = 'admin'); Elevate needs the grant too
    expect(rowRoles({ grantLevel: "member", archiveRole: "admin" })).toEqual({ propose: false, elevate: false, expose: true });
    expect(rowRoles({ grantLevel: null, archiveRole: "moderator" })).toEqual(NO_ROLES);
  });
  test("each op is refused in the browser without its role", () => {
    const editor = rowRoles({ grantLevel: "editor", archiveRole: null });
    const create: RowOp = { kind: "proposed.create", table: "song", fields: { name: "X" } };
    const elevate: RowOp = { kind: "elevate", table: "song", id: U(1), name: "X" };
    const expose: RowOp = { kind: "exposure", target: "song", id: U(1), name: "X", expose: true };
    const repoint: RowOp = { kind: "artists.repoint", from: { id: U(1), name: "A" }, to: { id: U(2), name: "B" } };
    expect(rowRefusal(create, NO_ROLES)).toBe(PROPOSE_ROLE_LINE);
    expect(rowRefusal(repoint, NO_ROLES)).toBe(PROPOSE_ROLE_LINE);
    expect(rowRefusal(create, editor)).toBeNull();
    expect(rowRefusal(elevate, editor)).toBe(ELEVATE_ROLE_LINE);
    expect(rowRefusal(expose, editor)).toBe(EXPOSE_ROLE_LINE);
    expect(rowRefusal(elevate, rowRoles({ grantLevel: "editor", archiveRole: "moderator" }))).toBeNull();
    expect(rowRefusal(expose, rowRoles({ grantLevel: "member", archiveRole: "admin" }))).toBeNull();
  });
});

describe("Proposed rows (§3.4)", () => {
  test("create a Song: the minted id, the cleaned columns, one proposed.song_created Edit; force only when asked", () => {
    const s = spec({ kind: "proposed.create", table: "song", fields: { name: "  Ezir   Kara ", english_name: "", notes: "from a concert" } });
    wellFormed(s);
    expect(s.fn).toBe("write_proposed_songs");
    expect(s.minted).toBe(NEW);
    expect(s.args).toMatchObject({ p_op: "create", p_target: NEW, p_expected_updated_at: null, p_payload: { name: "Ezir Kara", notes: "from a concert" } });
    expect("english_name" in s.args.p_payload).toBe(false);
    expect("force" in s.args.p_payload).toBe(false);
    expect(s.args.p_edits).toEqual([{ event_type: "proposed.song_created", field_name: "name", new_value: "Ezir Kara", description: "Proposed Song created: Ezir Kara" }]);
    expect(spec({ kind: "proposed.create", table: "song", fields: { name: "X" }, force: true }).args.p_payload.force).toBe(true);
  });
  test("create needs a name and a minted id", () => {
    expect(refused({ kind: "proposed.create", table: "artist", fields: { name: "  " } })).toContain("needs a name");
    expect(refused({ kind: "proposed.create", table: "artist", fields: { name: "A" } }, undefined, {})).toContain("minted id");
  });
  test("create a Version: the parent pair by kind; a Local Song is never sent", () => {
    const op = (p: string): RowOp => ({ kind: "proposed.create", table: "version", fields: { label: "Live 2019", song_id: p } });
    expect(rowKindsNeeded(op("s1"))).toEqual({ songs: ["s1"], versions: [], artists: [] });
    const a = spec(op("s1"), K({ songs: { s1: "archive" } }));
    wellFormed(a);
    expect(a.args.p_payload).toEqual({ label: "Live 2019", song_id: "s1" });
    expect(a.args.p_edits[0]!.event_type).toBe("proposed.version_created");
    expect(spec(op("s2"), K({ songs: { s2: "proposed" } })).args.p_payload).toEqual({ label: "Live 2019", proposed_song_id: "s2" });
    expect(refused(op("s3"), K({ songs: { s3: "local" } }))).toBe(LOCAL_ROW_LINE);
    expect(refused({ kind: "proposed.create", table: "version", fields: { label: "x" } })).toContain("needs its Song");
  });
  test("update: only changed columns, one Edit each, the row's stamp", () => {
    const before = { name: "Ezir Kara", english_name: null, alternate_titles: null, notes: null };
    const s = spec({ kind: "proposed.update", table: "song", id: U(5), stamp: STAMP, before, fields: { name: "Ezir-Kara", english_name: "Black eagle", notes: null } });
    wellFormed(s);
    expect(s.args).toMatchObject({ p_op: "update", p_target: U(5), p_expected_updated_at: STAMP, p_payload: { name: "Ezir-Kara", english_name: "Black eagle" } });
    expect(s.args.p_edits.map((e) => [e.event_type, e.field_name, e.old_value, e.new_value])).toEqual([
      ["proposed.song_changed", "name", "Ezir Kara", "Ezir-Kara"],
      ["proposed.song_changed", "english_name", null, "Black eagle"],
    ]);
    expect(refused({ kind: "proposed.update", table: "song", id: U(5), stamp: STAMP, before, fields: { name: "Ezir Kara" } })).toBe(NOTHING_TO_CHANGE);
    expect(refused({ kind: "proposed.update", table: "artist", id: U(5), stamp: STAMP, before: { name: "A" }, fields: { name: " " } })).toContain("cannot be empty");
    expect(refused({ kind: "proposed.update", table: "artist", id: U(5), stamp: null, before: { name: "A" }, fields: { name: "B" } })).toContain("no stamp");
    // apply mine: the stamp from the conflict's DETAIL wins
    expect(spec({ kind: "proposed.update", table: "artist", id: U(5), stamp: STAMP, before: { name: "A" }, fields: { name: "B" } }, undefined, { stamp: "2026-10-17T11:00:00.000Z" }).args.p_expected_updated_at).toBe("2026-10-17T11:00:00.000Z");
  });
  test("delete: one proposed.*_deleted Edit quoting the name", () => {
    for (const table of ["song", "version", "artist"] as const) {
      const s = spec({ kind: "proposed.delete", table, id: U(6), name: "Old", stamp: STAMP });
      wellFormed(s);
      expect(s.fn).toBe(`write_proposed_${table}s`);
      expect(s.args).toMatchObject({ p_op: "delete", p_target: U(6), p_payload: {}, p_expected_updated_at: STAMP });
      expect(s.args.p_edits[0]).toMatchObject({ event_type: `proposed.${table}_deleted`, old_value: "Old" });
    }
  });
});

describe("Elevate (§4.4) and Expose (§3.5)", () => {
  test("elevate a Song or Artist: definer function, p_edits [], use_existing / force when chosen", () => {
    const s = spec({ kind: "elevate", table: "song", id: U(7), name: "New" });
    wellFormed(s);
    expect(s.fn).toBe("elevate_song");
    expect(s.args).toMatchObject({ p_op: "elevate", p_target: U(7), p_payload: {}, p_edits: [] });
    expect(spec({ kind: "elevate", table: "artist", id: U(7), name: "A", useExisting: U(8) }).args.p_payload).toEqual({ use_existing: U(8) });
    expect(spec({ kind: "elevate", table: "artist", id: U(7), name: "A", force: true }).args.p_payload).toEqual({ force: true });
  });
  test("a Version under a public Song needs confirm_public; under a Proposed Song it is refused", () => {
    const pub = { id: U(1), kind: "archive" as const, hidden: false };
    expect(refused({ kind: "elevate", table: "version", id: U(9), name: "v", parent: pub })).toBe(CONFIRM_PUBLIC_LINE);
    const ok = spec({ kind: "elevate", table: "version", id: U(9), name: "v", parent: pub, confirmPublic: true });
    wellFormed(ok);
    expect(ok.fn).toBe("elevate_version");
    expect(ok.args.p_payload).toEqual({ confirm_public: true });
    // under a hidden archive Song the Version stays out of sight: no confirm_public
    expect(spec({ kind: "elevate", table: "version", id: U(9), name: "v", parent: { ...pub, hidden: true }, confirmPublic: true }).args.p_payload).toEqual({});
    expect(refused({ kind: "elevate", table: "version", id: U(9), name: "v", parent: { ...pub, kind: "proposed" } })).toBe(ELEVATE_SONG_FIRST_LINE);
  });
  test("expose / unexpose a Song, or an Artist with {kind: 'artist'}", () => {
    const s = spec({ kind: "exposure", target: "song", id: U(3), name: "Hidden", expose: true });
    wellFormed(s);
    expect(s.args).toMatchObject({ p_op: "expose", p_target: U(3), p_payload: {} });
    expect(s.args.p_edits[0]).toMatchObject({ event_type: "exposure.exposed", field_name: "song_id", new_value: U(3) });
    const a = spec({ kind: "exposure", target: "artist", id: U(4), name: "A", expose: false });
    wellFormed(a);
    expect(a.args).toMatchObject({ p_op: "unexpose", p_payload: { kind: "artist" } });
    expect(a.args.p_edits[0]!.event_type).toBe("exposure.unexposed");
  });
});

describe("the duplicate-candidate prompt (§3.4, VD422)", () => {
  const detail: DuplicateCandidate[] = [
    { kind: "proposed", id: "p2", name: "Ezir-Kara" },
    { kind: "archive", id: "a2", name: "Ezir kara (live)" },
    { kind: "archive", id: "a1", name: "Ezir-Kara" },
    { kind: "proposed", id: "p2", name: "Ezir-Kara" },
    { kind: "proposed", id: "self", name: "Ezir Kara" },
  ];
  test("archive rows first, then Proposed, each once, by name; never the row itself", () => {
    expect(candidateRows(detail, { exclude: "self" }).map((r) => [r.id, r.where])).toEqual([
      ["a2", "in the archive"],
      ["a1", "in the archive"],
      ["p2", "Proposed"],
    ]);
  });
  test("Elevation folds into archive rows only", () => {
    expect(candidateRows(detail, { exclude: "self", archiveOnly: true }).map((r) => r.id)).toEqual(["a2", "a1"]);
    expect(candidateRows([])).toEqual([]);
  });
  test("the prompt's words, create and elevate", () => {
    const one = candidateRows([{ kind: "archive", id: "a1", name: "X" }]);
    expect(duplicatePrompt("song", "Ezir Kara", "create", one)).toEqual({ title: "A Song like “Ezir Kara” already exists.", use: "Use this one", force: "Create “Ezir Kara” anyway" });
    expect(duplicatePrompt("artist", "Alash", "elevate", candidateRows(detail)).title).toBe("The archive already has 4 Artists like “Alash”.");
    expect(duplicatePrompt("artist", "Alash", "elevate", one).force).toBe("Elevate as a new Artist");
  });
  test("the in-use line names the count and offers Repoint", () => {
    expect(inUseLine("song", "Ezir Kara", 3)).toBe("“Ezir Kara” is still used by 3 Videos or Chapters, so it cannot be deleted. Repoint them to another Song first?");
    expect(inUseLine("artist", "Alash", 1)).toBe("“Alash” is still used by 1 Video, so it cannot be deleted. Repoint it to another Artist first?");
    expect(inUseLine("version", "Live", null)).toContain("still used by some");
  });
});

const info = (o: Partial<RowInfo>): RowInfo => ({
  table: "song", id: "from", kind: "proposed", name: "From", updatedAt: STAMP, fields: null, hidden: false, exposed: false, parent: null,
  uses: { videos: [], chapters: [], artistLinks: [] }, ...o,
});

describe("Repoint (§4.6)", () => {
  const uses = {
    videos: [{ id: U(1), shared: true, updatedAt: STAMP, title: "V1", songId: "from", versionId: null }, { id: U(2), shared: false, updatedAt: STAMP, title: "V2", songId: "from", versionId: null }],
    chapters: [{ id: U(50), videoId: U(3), shared: true, startS: 42, title: "Ch", suggested: false, updatedAt: STAMP, songId: "from", versionId: null }],
    artistLinks: [],
  };
  test("a Song: every Video pointer a video.update, every Chapter a chapter.update; each a call the archive takes", () => {
    const plan = repointPlan(info({ uses }), { id: "to", kind: "archive" });
    if ("refused" in plan) throw new Error(plan.refused);
    expect(plan.map((s) => [s.op.kind, s.video.id, s.video.shared])).toEqual([
      ["video.update", U(1), true],
      ["video.update", U(2), false],
      ["chapter.update", U(3), true],
    ]);
    const kinds = K({ songs: { to: "archive", from: "proposed" } });
    const v = archiveCall(plan[0]!.video, plan[0]!.op, kinds);
    if ("refused" in v) throw new Error(v.refused);
    expect(v.args.p_payload).toMatchObject({ song_id: "to", proposed_song_id: null, version_id: null });
    expect(v.args.p_edits[0]).toMatchObject({ event_type: "video.song_changed", old_value: "from", new_value: "to" });
    const c = archiveCall(plan[2]!.video, plan[2]!.op, kinds);
    if ("refused" in c) throw new Error(c.refused);
    expect(c).toMatchObject({ fn: "write_video_chapters", args: { p_op: "update", p_target: U(50), p_expected_updated_at: STAMP, p_payload: { song_id: "to" } } });
  });
  test("a Version moves with its Song; a Local target cannot take Shared uses", () => {
    const plan = repointPlan(info({ table: "version", uses }), { id: "v2", kind: "proposed", songId: "s9" });
    if ("refused" in plan) throw new Error(plan.refused);
    expect(plan[0]!.op).toEqual({ kind: "video.update", patch: { songId: "s9", versionId: "v2" } });
    expect(repointPlan(info({ uses }), { id: "mine", kind: "local" })).toEqual({ refused: LOCAL_TARGET_LINE });
    // only Unshared uses: a Local target is fine (the companion's routes)
    expect("refused" in repointPlan(info({ uses: { ...uses, videos: [uses.videos[1]!], chapters: [] } }), { id: "mine", kind: "local" })).toBe(false);
  });
  test("an Artist: one archive repoint for the Shared links, artists.set (renumbered, deduped) for each Unshared Video", () => {
    const links = [
      { videoId: U(1), shared: true, updatedAt: STAMP, artistIds: ["from", "x"] },
      { videoId: U(2), shared: false, updatedAt: STAMP, artistIds: ["to", "from", "y"] },
    ];
    const p = artistRepointPlan(info({ table: "artist", uses: { videos: [], chapters: [], artistLinks: links } }), "to");
    expect(p.archive).toBe(true);
    expect(p.local).toEqual([{ video: { id: U(2), shared: false, updatedAt: STAMP }, op: { kind: "artists.set", artistIds: ["to", "y"] } }]);
    expect(artistRepointPlan(info({ table: "artist", uses: { videos: [], chapters: [], artistLinks: [links[1]!] } }), "to").archive).toBe(false);
  });
  test("the archive repoint: target null, refs by kind, exactly one artist_link.repointed template Edit", () => {
    const op: RowOp = { kind: "artists.repoint", from: { id: "pa", name: "Alash (proposed)" }, to: { id: "aa", name: "Alash" } };
    expect(rowKindsNeeded(op)).toEqual({ songs: [], versions: [], artists: ["pa", "aa"] });
    const s = spec(op, K({ artists: { pa: "proposed", aa: "archive" } }));
    wellFormed(s);
    expect(s.args).toMatchObject({ p_op: "repoint", p_target: null, p_expected_updated_at: null, p_payload: { from: { proposed_artist_id: "pa" }, to: { artist_id: "aa" } } });
    expect(s.args.p_edits).toEqual([{ event_type: "artist_link.repointed", field_name: "artist_id", old_value: "pa", new_value: "aa", description: "Repointed Alash (proposed) → Alash" }]);
    expect(refused({ ...op, to: { id: "la", name: "Mine" } }, K({ artists: { pa: "proposed", la: "local" } }))).toBe(LOCAL_TARGET_LINE);
    expect(refused({ ...op, to: op.from })).toContain("itself");
  });
  test("a Local Artist's repoint is the companion's merge (it was 'merge into…')", () => {
    expect(localRepointRequest({ kind: "artists.repoint", from: { id: "la", name: "L" }, to: { id: "aa", name: "A" } })).toEqual({ method: "POST", url: "/api/artists/la/merge-into/aa" });
  });
});

describe("GET /api/rows/:table/:id (the companion's read)", () => {
  test("a Proposed Song with its stamp, columns and every Video and Chapter on it", () => {
    const db = openDb(":memory:", MIGRATIONS);
    db.exec("INSERT INTO video_proposed_songs (id, name, english_name, updated_at) VALUES ('ps-000001', 'Ezir Kara', 'Black eagle', '2026-10-17T00:00:00Z')");
    const shared = insertVideo(db, { title: "Shared", content_hash: "h1", proposed_song_id: "ps-000001", shared: 1 });
    const unshared = insertVideo(db, { title: "Unshared", content_hash: "h2", shared: 0 });
    insertChapter(db, { video_id: unshared, start_s: 12, title: "Ch", proposed_song_id: "ps-000001" });
    insertVideo(db, { title: "Other", content_hash: "h3", shared: 1 });
    const r = rowInfo(db, "song", "ps-000001")!;
    expect(r).toMatchObject({ kind: "proposed", name: "Ezir Kara", updatedAt: "2026-10-17T00:00:00Z", hidden: false, exposed: false });
    expect(r.fields).toEqual({ name: "Ezir Kara", english_name: "Black eagle", alternate_titles: null, notes: null });
    expect(r.uses.videos.map((v) => [v.id, v.shared, v.songId])).toEqual([[shared, true, "ps-000001"]]);
    expect(r.uses.chapters.map((c) => [c.videoId, c.shared, c.startS, c.songId])).toEqual([[unshared, false, 12, "ps-000001"]]);
    expect(rowInfo(db, "song", "nope-0000")).toBeNull();
  });
  test("a hidden, Exposed archive Song; a Version's parent; an Artist's links with their whole list", () => {
    const db = openDb(":memory:", MIGRATIONS);
    db.exec("INSERT INTO archive_song (id, name, slug, is_hidden) VALUES ('as-000001', 'Hidden', 'hidden', 1)");
    db.exec("INSERT INTO video_exposed_songs (id, song_id, exposed_at, updated_at) VALUES ('e1', 'as-000001', '2026-10-17T00:00:00Z', '2026-10-17T00:00:00Z')");
    db.exec("INSERT INTO video_proposed_versions (id, song_id, label, updated_at) VALUES ('pv-000001', 'as-000001', 'Live', '2026-10-17T00:00:00Z')");
    expect(rowInfo(db, "song", "as-000001")).toMatchObject({ kind: "archive", hidden: true, exposed: true, updatedAt: null, fields: null });
    expect(rowInfo(db, "version", "pv-000001")).toMatchObject({ kind: "proposed", name: "Live", parent: { id: "as-000001", kind: "archive", hidden: true } });
    insertArchiveArtist(db, { id: "aa-000001", name: "Alash" });
    const la = insertLocalArtist(db, { name: "Alash!" });
    const v = insertVideo(db, { title: "V", content_hash: "h", shared: 0 });
    linkArtist(db, v, "aa-000001", 0);
    linkArtist(db, v, la, 1);
    const a = rowInfo(db, "artist", la)!;
    expect(a.kind).toBe("local");
    expect(a.uses.artistLinks).toEqual([{ videoId: v, shared: false, updatedAt: expect.any(String), artistIds: ["aa-000001", la] }]);
  });
});
