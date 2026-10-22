// Undo round trips (sharing-spec §4.7): every undoable write is made against a simulated archive (the write functions'
// effects and `video_log` rows, as archive migration 130 has them), then undone from its history rows the way
// `undoWrite` does it (groupWrites → inverseOf → archiveCall with `reverses`), then the undo undone.
import { describe, expect, test } from "bun:test";
import { decodeValue, groupWrites, type HistoryEntry } from "../src/shared/editHistory";
import { latinByTable } from "../src/shared/translit";
import type { ChapterDto } from "../src/shared/types";
import { ALREADY_UNDONE_LINE, archiveCall, CONFIRM_NOT_UNDOABLE_LINE, inverseOf, undoBlock, type ArchiveCallSpec, type LinkOp } from "../src/web/writeOps";

interface Ch { id: string; startS: number; title: string; suggested: boolean; source: ChapterDto["source"]; songId: string | null; versionId: string | null; updatedAt: string }
interface Ar { id: string; name: string; suggested: boolean; linkId: string }
interface Row { id: string; target_type: string; target_id: string; event_type: string; field_name: string | null; old_value: unknown; new_value: unknown; description: string; reverses: string | null; created_at: string }

const NAMES: Record<string, string> = { A1: "Хуун-Хуур-Ту", A2: "Ятха", A3: "Алаш" };

class Archive {
  tick = 0;
  ids = 0;
  v = {
    id: "V1", title: "Песня степи", titleLatin: latinByTable("Песня степи"), titleLatinSource: "table" as string | null, type: "song" as string | null, typeSuggested: false,
    songId: "S1" as string | null, versionId: "R1" as string | null, songSuggested: false, deleted: false, updatedAt: this.stamp(),
  };
  artists: Ar[] = [
    { id: "A1", name: NAMES.A1!, suggested: false, linkId: this.id("l") },
    { id: "A2", name: NAMES.A2!, suggested: false, linkId: this.id("l") },
  ];
  chapters: Ch[] = [{ id: this.id("c"), startS: 30, title: "Начало", suggested: false, source: "manual", songId: "S2", versionId: "R2", updatedAt: this.stamp() }];
  chRej: { id: string; startS: number; source: string }[] = [];
  arRej: { id: string; artistId: string }[] = [];
  rows: Row[] = [];

  id(p: string) { return `${p}${++this.ids}`; }
  stamp() { return `2026-10-21T10:00:${String(++this.tick).padStart(2, "0")}.000Z`; }

  /** The Video as `api.video` gives it. */
  video() {
    const { deleted, ...v } = this.v;
    return { ...v, shared: true, artists: this.artists.map((a) => ({ ...a })) } as never;
  }
  chapterDtos() { return this.chapters.map((c) => ({ ...c, videoId: "V1" })); }
  snapshot() {
    return JSON.parse(JSON.stringify({
      v: { ...this.v, updatedAt: undefined },
      artists: this.artists.map(({ id, suggested }) => ({ id, suggested })),
      chapters: this.chapters.map(({ startS, title, suggested, songId, versionId }) => ({ startS, title, suggested, songId, versionId })).sort((a, b) => a.startS - b.startS),
      chRej: this.chRej.map((r) => r.startS), arRej: this.arRej.map((r) => r.artistId),
    }));
  }

  /** The write functions, as far as the client can observe them. */
  apply(spec: ArchiveCallSpec) {
    const { fn, args } = spec;
    const p = args.p_payload as Record<string, never>;
    const now = this.stamp();
    let target = { type: "video", id: "V1" };
    if (fn === "write_videos") {
      if (args.p_expected_updated_at !== this.v.updatedAt) throw new Error("conflict");
      if (args.p_op === "update") {
        const map: Record<string, keyof typeof this.v> = { title: "title", title_latin: "titleLatin", title_latin_source: "titleLatinSource", type: "type", type_suggested: "typeSuggested", song_id: "songId", version_id: "versionId", song_suggested: "songSuggested" };
        for (const [k, f] of Object.entries(map)) if (k in p) (this.v as Record<string, unknown>)[f] = p[k];
      } else if (args.p_op === "delete") this.v.deleted = true;
      else if (args.p_op === "restore") this.v.deleted = false;
    } else if (fn === "write_video_artists") {
      if (args.p_op === "replace") {
        if (args.p_expected_updated_at !== this.v.updatedAt) throw new Error("conflict");
        this.artists = (p.artists as { artist_id: string; suggested: boolean }[]).map((a) => ({ id: a.artist_id, name: NAMES[a.artist_id]!, suggested: a.suggested, linkId: this.id("l") }));
        target = { type: "artist_link", id: "V1" };
      } else if (args.p_op === "reject") {
        const link = this.artists.find((a) => a.linkId === args.p_target)!;
        const rej = { id: this.id("ar"), artistId: link.id };
        this.arRej.push(rej);
        this.artists = this.artists.filter((a) => a !== link);
        target = { type: "artist_rejection", id: rej.id };
      } else if (args.p_op === "unreject") {
        const i = this.arRej.findIndex((r) => r.id === args.p_target);
        if (i < 0) throw new Error("not-found");
        this.arRej.splice(i, 1);
        target = { type: "artist_rejection", id: args.p_target! };
      } else throw new Error(`unsimulated ${fn} ${args.p_op}`);
    } else if (fn === "write_video_chapters") {
      if (args.p_op === "add") {
        if (this.chapters.some((c) => c.startS === p.start_s)) throw new Error("exists");
        const c: Ch = { id: (p.id as string) ?? this.id("c"), startS: p.start_s, title: p.title, suggested: !!p.suggested, source: p.source, songId: p.song_id, versionId: p.version_id, updatedAt: now };
        this.chapters.push(c);
        target = { type: "chapter", id: c.id };
      } else if (args.p_op === "unreject") {
        const i = this.chRej.findIndex((r) => r.id === args.p_target);
        if (i < 0) throw new Error("not-found");
        this.chRej.splice(i, 1);
        target = { type: "chapter_rejection", id: args.p_target! };
      } else {
        const c = this.chapters.find((x) => x.id === args.p_target);
        if (!c) throw new Error("not-found");
        if (args.p_op !== "confirm" && args.p_expected_updated_at !== c.updatedAt) throw new Error("conflict");
        target = { type: "chapter", id: c.id };
        if (args.p_op === "update") {
          const map: Record<string, keyof Ch> = { start_s: "startS", title: "title", song_id: "songId", version_id: "versionId", suggested: "suggested" };
          for (const [k, f] of Object.entries(map)) if (k in p) (c as unknown as Record<string, unknown>)[f] = p[k];
          c.updatedAt = now;
        } else if (args.p_op === "delete") this.chapters = this.chapters.filter((x) => x !== c);
        else if (args.p_op === "confirm") (c.suggested = false), (c.updatedAt = now);
        else if (args.p_op === "reject") {
          const rej = { id: this.id("cr"), startS: c.startS, source: c.source };
          this.chRej.push(rej);
          this.chapters = this.chapters.filter((x) => x !== c);
          target = { type: "chapter_rejection", id: rej.id };
        }
      }
    } else throw new Error(`unsimulated ${fn}`);
    this.v.updatedAt = now; // a child write bumps the Video by trigger
    if (!args.p_edits.length) throw new Error("22023: no Edit");
    for (const e of args.p_edits)
      this.rows.push({
        id: this.id("h"), target_type: target.type, target_id: target.id, event_type: e.event_type, field_name: e.field_name ?? null,
        old_value: e.old_value ?? null, new_value: e.new_value ?? null, description: e.description, reverses: e.reverses ?? null, created_at: now,
      });
  }

  /** `GET /api/videos/:id/history` after the pull: SQLite's encoding of jsonb, decoded; newest first. */
  history(): HistoryEntry[] {
    const sqlite = (v: unknown) => (v == null ? null : typeof v === "number" ? v : typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v));
    return [...this.rows].reverse().map((r) => {
      const oldValue = decodeValue(sqlite(r.old_value));
      let rejectionId: string | null = null;
      if (r.event_type === "chapter.rejected") rejectionId = [...this.chRej].reverse().find((x) => x.startS === Number(oldValue))?.id ?? null;
      if (r.event_type === "artist_link.rejected") rejectionId = [...this.arRej].reverse().find((x) => x.artistId === oldValue)?.id ?? null;
      return {
        id: r.id, videoId: "V1", videoTitle: this.v.title, targetType: r.target_type, targetId: r.target_id, editorId: "me", eventType: r.event_type, fieldName: r.field_name,
        oldValue, newValue: decodeValue(sqlite(r.new_value)), description: r.description, reverses: r.reverses,
        reversedBy: [...this.rows].reverse().find((x) => x.reverses === r.id)?.id ?? null, rejectionId, createdAt: r.created_at,
      };
    });
  }

  write(op: LinkOp) {
    const s = archiveCall(this.video(), op, undefined, { newId: op.kind === "chapter.add" ? this.id("c") : undefined });
    if ("refused" in s) throw new Error(`refused: ${s.refused}`);
    this.apply(s);
  }

  /** `undoWrite` on the newest write (or the write holding `rowId`). Returns the refusal line, if any. */
  undo(rowId?: string): string | null {
    const groups = groupWrites(this.history());
    const g = rowId ? groups.find((x) => x.entries.some((e) => e.id === rowId))! : groups[0]!;
    const plan = inverseOf(g.entries, { video: this.video(), chapters: this.chapterDtos() as never });
    if ("refused" in plan) return plan.refused;
    const s = archiveCall(this.video(), plan.op, undefined, { reverses: plan.reverses, newId: plan.op.kind === "chapter.add" ? this.id("c") : undefined });
    if ("refused" in s) return s.refused;
    this.apply(s);
    return null;
  }

  lastWriteIds() { return groupWrites(this.history())[0]!.entries.map((e) => e.id); }
}

/** Write, undo (state back to before, every Edit pointing at a row of the write), undo the undo (state as after). */
function roundTrip(a: Archive, op: LinkOp | ((a: Archive) => LinkOp)): void {
  const before = a.snapshot();
  a.write(typeof op === "function" ? op(a) : op);
  const after = a.snapshot();
  expect(after).not.toEqual(before);
  const forward = a.lastWriteIds();
  expect(a.undo()).toBeNull();
  expect(a.snapshot()).toEqual(before);
  const undoRows = groupWrites(a.history())[0]!.entries;
  for (const e of undoRows) expect(forward).toContain(e.reverses!);
  // the original now reads as undone, and is refused a second time
  expect(a.undo(forward[0])).toBe(ALREADY_UNDONE_LINE);
  expect(a.undo()).toBeNull();
  expect(a.snapshot()).toEqual(after);
}

describe("Undo round trips: Video fields", () => {
  test("title (generated Latin title regenerated from the old title)", () => roundTrip(new Archive(), { kind: "video.update", patch: { title: "Новая песня" } }));
  test("Latin title typed alone", () => roundTrip(new Archive(), { kind: "video.update", patch: { titleLatin: "Pesnya Stepi (manual)" } }));
  test("title under a manual Latin title", () => {
    const a = new Archive();
    a.write({ kind: "video.update", patch: { titleLatin: "Manual" } });
    roundTrip(a, { kind: "video.update", patch: { title: "Другая" } });
  });
  test("Type", () => roundTrip(new Archive(), { kind: "video.update", patch: { type: "interview" as never } }));
  test("Song (its Version reset with it)", () => roundTrip(new Archive(), { kind: "video.update", patch: { songId: "S9" } }));
  test("Song cleared", () => roundTrip(new Archive(), { kind: "video.update", patch: { songId: null } }));
  test("Version only", () => roundTrip(new Archive(), { kind: "video.update", patch: { versionId: "R7" } }));
  test("Song and Version together", () => roundTrip(new Archive(), { kind: "video.update", patch: { songId: "S9", versionId: "R9" } }));
  test("title, Type and Song in one write", () => roundTrip(new Archive(), { kind: "video.update", patch: { title: "Всё сразу", type: "interview" as never, songId: "S9" } }));
  test("soft delete ↔ restore", () => roundTrip(new Archive(), { kind: "video.delete", reason: "duplicate" }));
  test("a Type confirmation alone is refused; inside a mixed write it stays", () => {
    const a = new Archive();
    a.v.typeSuggested = true;
    a.write({ kind: "video.update", patch: { type: "song" as never } });
    expect(a.undo()).toBe(CONFIRM_NOT_UNDOABLE_LINE);
    a.v.typeSuggested = true;
    const before = a.snapshot();
    a.write({ kind: "video.update", patch: { type: "song" as never, title: "Подтверждено" } });
    expect(a.undo()).toBeNull();
    expect({ ...a.snapshot(), v: { ...a.snapshot().v, typeSuggested: true } }).toEqual(before); // confirmed stays confirmed
    expect(a.snapshot().v.typeSuggested).toBe(false);
  });
});

describe("Undo round trips: Chapters", () => {
  test("add", () => roundTrip(new Archive(), { kind: "chapter.add", chapter: { startS: 95, title: "Припев", songId: "S3", versionId: "R3" } }));
  test("title, start and Song in one write", () =>
    roundTrip(new Archive(), (a) => ({ kind: "chapter.update", chapter: a.chapterDtos()[0]!, patch: { title: "Начало (ред.)", startS: 32, songId: "S4" } })));
  test("title only", () => roundTrip(new Archive(), (a) => ({ kind: "chapter.update", chapter: a.chapterDtos()[0]!, patch: { title: "Другое" } })));
  test("Song only (the old Version comes back with it)", () =>
    roundTrip(new Archive(), (a) => ({ kind: "chapter.update", chapter: a.chapterDtos()[0]!, patch: { songId: "S4" } })));
  test("Version only", () => roundTrip(new Archive(), (a) => ({ kind: "chapter.update", chapter: a.chapterDtos()[0]!, patch: { versionId: "R8" } })));
  test("delete (added back with its title, Song and Version)", () => roundTrip(new Archive(), (a) => ({ kind: "chapter.delete", chapter: a.chapterDtos()[0]! })));
  test("delete of a Suggested Chapter", () => {
    const a = new Archive();
    a.chapters[0]!.suggested = true;
    roundTrip(a, (x) => ({ kind: "chapter.delete", chapter: x.chapterDtos()[0]! }));
  });
  // §4.7: an undone rejection is only taken back; the matcher may suggest the Chapter again
  test("reject: the rejection is taken back, the Suggested Chapter is not re-added", () => {
    const a = new Archive();
    a.chapters[0]!.suggested = true;
    a.chapters[0]!.source = "description";
    const before = a.snapshot();
    a.write({ kind: "chapter.reject", chapter: a.chapterDtos()[0]! });
    expect(a.undo()).toBeNull();
    expect(a.snapshot()).toEqual({ ...before, chapters: [] });
  });
});

describe("Undo round trips: Artists", () => {
  test("replace", () => roundTrip(new Archive(), { kind: "artists.set", artistIds: ["A3", "A1"] }));
  test("reorder", () => roundTrip(new Archive(), { kind: "artists.set", artistIds: ["A2", "A1"] }));
  test("remove a confirmed Artist (order kept)", () => roundTrip(new Archive(), { kind: "artists.remove", artistId: "A1" }));
  test("remove a Suggested Artist from a list with confirmed ones", () => {
    const a = new Archive();
    a.artists[1]!.suggested = true;
    roundTrip(a, { kind: "artists.set", artistIds: ["A1", "A3"] });
  });
  test("reject a Suggested Artist: the rejection is taken back, the link is not re-added", () => {
    const a = new Archive();
    a.artists[1]!.suggested = true;
    const before = a.snapshot();
    a.write({ kind: "artists.remove", artistId: "A2" });
    expect(a.undo()).toBeNull();
    expect(a.snapshot()).toEqual({ ...before, artists: before.artists.filter((x: { id: string }) => x.id !== "A2") });
  });
});

describe("Undo chains and the toast", () => {
  test("undo, redo, undo again: three levels deep", () => {
    const a = new Archive();
    const start = a.snapshot();
    a.write({ kind: "video.update", patch: { title: "Раз" } });
    const one = a.snapshot();
    for (let i = 0; i < 4; i++) {
      expect(a.undo()).toBeNull();
      expect(a.snapshot()).toEqual(i % 2 ? one : start);
    }
  });
  test("an older write is undone past newer writes to other fields", () => {
    const a = new Archive();
    a.write({ kind: "video.update", patch: { title: "Старое" } });
    const first = a.lastWriteIds()[0]!;
    a.write({ kind: "video.update", patch: { type: "interview" as never } });
    a.write({ kind: "chapter.add", chapter: { startS: 120, title: "Конец" } });
    expect(a.undo(first)).toBeNull();
    expect(a.v.title).toBe("Песня степи");
    expect(a.v.titleLatin).toBe(latinByTable("Песня степи"));
    expect(a.v.type).toBe("interview");
    expect(a.chapters).toHaveLength(2);
  });
  test("an added Chapter deleted since: the undo is refused, not sent", () => {
    const a = new Archive();
    a.write({ kind: "chapter.add", chapter: { startS: 60, title: "Х" } });
    const add = a.lastWriteIds()[0]!;
    a.write({ kind: "chapter.delete", chapter: a.chapterDtos().find((c) => c.startS === 60)! });
    expect(a.undo(add)).toMatch(/no longer here/);
  });
  test("the toast offers Undo for exactly the writes the History tab can undo", () => {
    const cases: [string, (a: Archive) => LinkOp][] = [
      ["title", () => ({ kind: "video.update", patch: { title: "Т" } })],
      ["delete", () => ({ kind: "video.delete", reason: "x" })],
      ["chapter add", () => ({ kind: "chapter.add", chapter: { startS: 77, title: "" } })],
      ["chapter delete", (a) => ({ kind: "chapter.delete", chapter: a.chapterDtos()[0]! })],
      ["artists", () => ({ kind: "artists.set", artistIds: ["A3"] })],
    ];
    for (const [, op] of cases) {
      const a = new Archive();
      a.write(op(a));
      // the toast's check: bundle rows, a rejection assumed held
      const rows = a.rows.map((r) => ({ id: r.id, targetId: r.target_id, eventType: r.event_type, fieldName: r.field_name, oldValue: r.old_value, newValue: r.new_value, reversedBy: null, rejectionId: "held" }));
      expect(undoBlock(rows)).toBeNull();
      expect(undoBlock(groupWrites(a.history())[0]!.entries)).toBeNull();
    }
  });
});
