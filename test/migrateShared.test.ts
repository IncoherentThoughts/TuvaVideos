// The one-time migration (docs/sharing-spec.md §9.2, ticket #113): the preflight and the plan on a fixture
// library.db built through every migration, and the pure helpers.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/server/db";
import { legacyUuid } from "../src/server/localCopy/ids";
import { buildPlan, deletedVideoUuid, exposureList, hasRefusals, nearKey, posterPath, preflight, reconcile, videoFold, type Plan } from "../src/server/migrateShared/plan";
import { findPoster, readSnapshot } from "../src/server/migrateShared/snapshot";
import { editBelongsTo, EVENT_TYPES } from "../src/shared/archiveWire";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const NOW = "2026-10-17T00:00:00.000Z";

const ARCH_SONG = "a0000000-0000-4000-8000-000000000001";
const HIDDEN_SONG = "a0000000-0000-4000-8000-000000000002";
const ARCH_VER = "b0000000-0000-4000-8000-000000000001";
const ARCH_ARTIST = "c0000000-0000-4000-8000-000000000001";
const LOCAL_SONG = "d0000000-0000-4000-8000-000000000001";
const LOCAL_VER = "e0000000-0000-4000-8000-000000000001";
const JUNK_SONG = "d0000000-0000-4000-8000-0000000000ee";
const V1 = legacyUuid("video", 1);
const V2 = legacyUuid("video", 2);
const C1 = legacyUuid("chapter", 1);
const A_LOCAL = legacyUuid("artist", 10);
const A_ANDREI = legacyUuid("artist", 111);
const A_AIAH = legacyUuid("artist", 147);
const LIVE_ANDREI = "97b03858-c814-44c3-8422-1104ca48942b";

/** A clean library: every row resolvable, so the preflight passes. */
function fixture(): Db {
  const db = openDb(":memory:", MIGRATIONS);
  const run = (sql: string, ...p: (string | number | null)[]) => db.query(sql).run(...p);
  run(`INSERT INTO archive_song (id, name, slug, alternate_titles, is_hidden) VALUES (?, 'Alash', 'alash', 'Alash Khem, Алаш', 0)`, ARCH_SONG);
  run(`INSERT INTO archive_song (id, name, slug, is_hidden) VALUES (?, 'Eki Attar', 'eki-attar', 1)`, HIDDEN_SONG);
  run(`INSERT INTO archive_version (id, song_id, label, display_order) VALUES (?, ?, 'Complete', 0)`, ARCH_VER, ARCH_SONG);
  run(`INSERT INTO archive_artist (id, name, is_hidden, is_various_artists) VALUES (?, 'Huun-Huur-Tu', 0, 0)`, ARCH_ARTIST);
  run(`INSERT INTO local_song (id, name, alternate_spellings, created_at) VALUES (?, 'Kökei Noyan', 'Kokei Noyan', ?)`, LOCAL_SONG, NOW);
  run(`INSERT INTO local_song (id, name, created_at) VALUES (?, 'eir', ?)`, JUNK_SONG, NOW);
  run(`INSERT INTO local_version (id, song_id, label, display_order, cyrillic, footnotes_cyrillic, created_at, updated_at)
       VALUES (?, ?, 'Complete', 0, '<p>Кökei</p>', '[{"id":1,"text":"n"}]', ?, ?)`, LOCAL_VER, LOCAL_SONG, NOW, NOW);
  for (const [id, name] of [[A_LOCAL, "Nachyn Choreve"], [A_ANDREI, "Andrei Mongush"], [A_AIAH, "aiah"]]) {
    run(`INSERT INTO local_artist (id, name, created_at) VALUES (?, ?, ?)`, id!, name!, NOW);
  }
  run(`INSERT INTO videos (id, youtube_id, title, title_latin, title_latin_source, type, type_suggested, song_id, version_id, song_suggested,
       suggestion_source, instagram_id, created_at, updated_at) VALUES (?, 'aaaaaaaaaaa', 'Alash live', 'Alash live', 'table', 'song', 1, ?, ?, 1, 'title', 'Cx1', '2025-01-01T00:00:00.000Z', ?)`,
    V1, ARCH_SONG, ARCH_VER, NOW);
  run(`INSERT INTO videos (id, content_hash, title, type, song_id, version_id, rutube_id, created_at, updated_at)
       VALUES (?, 'hash2', 'Kökei', 'song', ?, ?, '0123456789abcdef0123456789abcdef', '2025-02-01T00:00:00.000Z', ?)`, V2, LOCAL_SONG, LOCAL_VER, NOW);
  run(`INSERT INTO video_chapters (id, video_id, start_s, title, song_id, suggested, source, created_at, updated_at)
       VALUES (?, ?, 12.5, 'Eki Attar', ?, 1, 'comment', ?, ?)`, C1, V1, HIDDEN_SONG, NOW, NOW);
  const link = (video: string, artist: string, pos: number, suggested: number) =>
    run(`INSERT INTO video_artists (id, video_id, artist_id, position, suggested, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(), video, artist, pos, suggested, NOW, NOW);
  link(V1, ARCH_ARTIST, 0, 0);
  link(V1, A_ANDREI, 1, 1);
  link(V2, A_LOCAL, 0, 0);
  run(`INSERT INTO video_chapter_rejections (id, video_id, source, start_s, created_at, updated_at) VALUES (?, ?, 'description', 30, ?, ?)`, crypto.randomUUID(), V1, NOW, NOW);
  run(`INSERT INTO video_artist_rejections (id, video_id, artist_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, crypto.randomUUID(), V2, A_ANDREI, NOW, NOW);
  run(`INSERT INTO deleted_video (id, youtube_id, title, deleted_at) VALUES (3, 'bbbbbbbbbbb', 'Gone', '2026-10-01T00:00:00.000Z')`);
  run(`INSERT INTO deleted_video (id, youtube_id, title, deleted_at) VALUES (4, 'aaaaaaaaaaa', 'Re-added', '2026-10-02T00:00:00.000Z')`);
  return db;
}

describe("names", () => {
  test("videoFold matches the archive's video_fold", () => {
    expect(videoFold("  Ёлка,  «Хоомей»!  ")).toBe("елка хоомей");
    expect(videoFold("—")).toBeNull();
  });
  test("nearKey catches the #87 pairs", () => {
    expect(nearKey("Nachyn Chodu")).toBe(nearKey("Nachyn Choodu"));
    expect(nearKey("Kara Duruyaa")).toBe(nearKey("Kara durujaa"));
    expect(nearKey("shodek]")).toBe("shodek");
    expect(nearKey("Nachyn Choreve")).not.toBe(nearKey("Nachyn Choodu"));
  });
});

describe("preflight", () => {
  test("a clean fixture passes", () => {
    const r = preflight(readSnapshot(fixture()));
    expect(r).toEqual({ nearDuplicates: [], workingNoteLabels: [], unreferencedSongs: [], pointerMismatches: [] });
    expect(hasRefusals(r)).toBe(false);
  });

  test("refuses on the #87 near-duplicates, working-note labels, unreferenced Local Songs and bad pointers", () => {
    const db = fixture();
    const run = (sql: string, ...p: (string | number)[]) => db.query(sql).run(...p);
    run(`INSERT INTO local_song (id, name, created_at) VALUES ('d1', 'Karan Duruyaa', ?)`, NOW);
    run(`UPDATE videos SET song_id = 'd1', version_id = NULL WHERE id = ?`, V2);
    run(`INSERT INTO local_song (id, name, created_at) VALUES ('d2', 'Show Me The Way', ?)`, NOW);
    run(`INSERT INTO local_version (id, song_id, label, display_order, created_at, updated_at) VALUES ('v9', ?, 'Liner notes', 1, ?, ?)`, LOCAL_SONG, NOW, NOW);
    for (const [id, n, name] of [["x1", 129, "Nachyn Chodu"], ["x2", 130, "Nachyn Choodu"], ["x3", 122, "gend"], ["x4", 146, "shodek]"]] as const) {
      run(`INSERT INTO local_artist (id, name, created_at) VALUES (?, ?, ?)`, legacyUuid("artist", n), name, NOW);
      void id;
    }
    run(`INSERT INTO video_artists (id, video_id, artist_id, position, suggested, created_at, updated_at) VALUES ('l1', ?, ?, 5, 0, ?, ?)`, V1, legacyUuid("artist", 129), NOW, NOW);
    run(`INSERT INTO video_artists (id, video_id, artist_id, position, suggested, created_at, updated_at) VALUES ('l2', ?, ?, 6, 0, ?, ?)`, V1, legacyUuid("artist", 130), NOW, NOW);
    run(`UPDATE video_chapters SET version_id = ? WHERE id = ?`, ARCH_VER, C1);

    const r = preflight(readSnapshot(db));
    expect(r.nearDuplicates.map((d) => d.name).sort()).toEqual(["Karan Duruyaa", "Nachyn Chodu", "Nachyn Choodu", "gend", "shodek]"]);
    expect(r.workingNoteLabels).toEqual([{ id: "v9", song: "Kökei Noyan", label: "Liner notes" }]);
    // Kökei Noyan lost its only Video to Karan Duruyaa; eir (junk, dropped) is never listed.
    expect(r.unreferencedSongs.map((s) => s.name).sort()).toEqual(["Kökei Noyan", "Show Me The Way"]);
    expect(r.pointerMismatches).toEqual([{ id: C1, table: "video_chapters", why: `Version ${ARCH_VER} belongs to Song ${ARCH_SONG}, not ${HIDDEN_SONG}` }]);

    const accepted = preflight(readSnapshot(db), { accept: ["Karan Duruyaa", "shodek]"] });
    expect(accepted.nearDuplicates.map((d) => d.name).sort()).toEqual(["Nachyn Chodu", "Nachyn Choodu", "gend"]);
  });

  test("a Local name the archive's dedupe would refuse is a refusal", () => {
    const db = fixture();
    db.query(`UPDATE local_song SET name = 'ALASH' WHERE id = ?`).run(LOCAL_SONG);
    const r = preflight(readSnapshot(db));
    expect(r.nearDuplicates).toHaveLength(1);
    expect(r.nearDuplicates[0]!.why).toContain("dedupe would refuse");
  });
});

describe("buildPlan", () => {
  const plan = (): Plan => buildPlan(readSnapshot(fixture()), { mappedArtistId: LIVE_ANDREI });

  test("orders Proposed Songs -> Versions -> Artists, then Videos, then deletions", () => {
    const kinds = plan().steps.map((s) => s.kind);
    expect(kinds).toEqual(["proposed_song", "proposed_version", "proposed_artist", "video", "video", "deleted_video"]);
  });

  test("Local pointers move to the Proposed column under the same id; archive pointers stay", () => {
    const p = plan();
    const song = p.steps.find((s) => s.kind === "proposed_song")!;
    expect(song).toMatchObject({ id: LOCAL_SONG, payload: { name: "Kökei Noyan", alternate_titles: "Kokei Noyan", notes: null } });
    const ver = p.steps.find((s) => s.kind === "proposed_version")!;
    expect(ver).toMatchObject({ id: LOCAL_VER, payload: { proposed_song_id: LOCAL_SONG, label: "Complete", lyrics_cyrillic: "<p>Кökei</p>", footnotes_cyrillic: [{ id: 1, text: "n" }], footnotes_translation: [] } });
    const [v1, v2] = p.steps.filter((s) => s.kind === "video") as Extract<Plan["steps"][number], { kind: "video" }>[];
    expect(v1!.payload).toMatchObject({
      song_id: ARCH_SONG, proposed_song_id: null, version_id: ARCH_VER, proposed_version_id: null,
      type: "song", type_suggested: true, song_suggested: true, suggestion_source: "title",
      title_latin: "Alash live", title_latin_source: "table", instagram_id: "Cx1", youtube_id: "aaaaaaaaaaa",
      chapters: [{ id: C1, start_s: 12.5, title: "Eki Attar", song_id: HIDDEN_SONG, suggested: true, source: "comment" }],
      // Andrei Mongush lands on the live archive row, Suggested kept.
      artists: [{ artist_id: ARCH_ARTIST, suggested: false }, { artist_id: LIVE_ANDREI, suggested: true }],
    });
    expect(v2!.payload).toMatchObject({ song_id: null, proposed_song_id: LOCAL_SONG, version_id: null, proposed_version_id: LOCAL_VER, rutube_id: "0123456789abcdef0123456789abcdef", content_hash: "hash2", artists: [{ proposed_artist_id: A_LOCAL, suggested: false }] });
  });

  test("Andrei Mongush and aiah are not Proposed; an unmapped Andrei stays Proposed", () => {
    const p = plan();
    expect(p.steps.filter((s) => s.kind === "proposed_artist").map((s) => s.id)).toEqual([A_LOCAL]);
    expect(p.dropped.artists.map((a) => a.name).sort()).toEqual(["Andrei Mongush", "aiah"]);
    expect(p.dropped.songs.map((s) => s.name)).toEqual(["eir"]);
    const unmapped = buildPlan(readSnapshot(fixture()), { mappedArtistId: null });
    expect(unmapped.steps.filter((s) => s.kind === "proposed_artist").map((s) => s.id).sort()).toEqual([A_LOCAL, A_ANDREI].sort());
  });

  test("deletions become insert + soft delete; a re-added identity is dropped", () => {
    const p = plan();
    const d = p.steps.find((s) => s.kind === "deleted_video")!;
    expect(d).toMatchObject({ id: deletedVideoUuid(3), payload: { title: "Gone", youtube_id: "bbbbbbbbbbb", type: "other" } });
    expect(d.kind === "deleted_video" && d.deleteEdits[0]!.event_type).toBe("video.deleted");
    expect(p.dropped.deletedVideos).toEqual([{ id: 4, title: "Re-added", why: "its identity is a live Video again (re-added after the delete)" }]);
    expect(deletedVideoUuid(3)).toBe("64656c00-0000-8000-8000-000000000003");
  });

  test("rejections keep their ids and follow the Artist mapping; created_at is restored", () => {
    const p = plan();
    expect(p.chapterRejections).toHaveLength(1);
    expect(p.artistRejections).toMatchObject([{ video_id: V2, artist_id: LIVE_ANDREI, proposed_artist_id: null }]);
    expect(p.createdAt.find((r) => r.id === V1)?.created_at).toBe("2025-01-01T00:00:00.000Z");
  });

  test("every write carries one migrated Edit of its function's family", () => {
    const p = plan();
    for (const s of p.steps) {
      expect(s.edits).toHaveLength(1);
      expect(EVENT_TYPES).toContain(s.edits[0]!.event_type);
      const fn = s.kind === "video" || s.kind === "deleted_video" ? "write_videos" : (`write_${s.kind}s` as "write_proposed_songs");
      expect(editBelongsTo(fn, s.edits[0]!)).toBe(true);
    }
    expect(p.steps.filter((s) => s.kind === "video").every((s) => s.edits[0]!.event_type === "video.migrated")).toBe(true);
    expect(p.counts.history_rows).toBe(p.steps.length + p.counts.deletions!);
  });

  test("the exposure list is the hidden Songs Videos and Chapters point at", () => {
    expect(exposureList(readSnapshot(fixture()))).toEqual([{ songId: HIDDEN_SONG, name: "Eki Attar", videos: 0, chapters: 1 }]);
  });

  test("posters: path from the hash, over 1 MiB dropped", () => {
    const snap = readSnapshot(fixture());
    const sha = "ab".repeat(32);
    const p = buildPlan(snap, { mappedArtistId: LIVE_ANDREI, posters: new Map([[V1, { file: "/x", sha256: sha, bytes: 10 }], [V2, { file: "/y", sha256: sha, bytes: 2_000_000 }]]) });
    const v1 = p.steps.find((s) => s.id === V1)!;
    expect(v1.kind === "video" && v1.payload.poster_path).toBe(`${V1}/abababababababab.webp`);
    expect(posterPath(V1, sha)).toMatch(/^[0-9a-f-]{36}\/[0-9a-f]{16}\.webp$/);
    expect(p.dropped.posters.map((x) => x.id)).toEqual([V2]);
    expect(p.counts.posters).toBe(1);
  });

  test("findPoster reads the uuid name or an older identity name", () => {
    const dir = mkdtempSync(join(tmpdir(), "tuva-poster-"));
    writeFileSync(join(dir, "aaaaaaaaaaa.poster.webp"), "RIFF");
    const p = findPoster(dir, { id: V1, youtube_id: "aaaaaaaaaaa", content_hash: null });
    expect(p).toMatchObject({ bytes: 4, file: join(dir, "aaaaaaaaaaa.poster.webp") });
    expect(p!.sha256).toHaveLength(64);
    expect(findPoster(dir, { id: V2, youtube_id: null, content_hash: "hash2" })).toBeNull();
  });
});

describe("reconcile (resume)", () => {
  test("what the target holds is done; a deletion inserted but not deleted is half done; strangers are foreign", () => {
    const p = buildPlan(readSnapshot(fixture()), { mappedArtistId: LIVE_ANDREI });
    const r = reconcile(p, {
      videos: [{ id: V1, deleted_at: null }, { id: deletedVideoUuid(3), deleted_at: null }, { id: "f0000000-0000-4000-8000-000000000000", deleted_at: null }],
      video_proposed_songs: [LOCAL_SONG],
      video_proposed_versions: [],
      video_proposed_artists: [],
    });
    expect([...r.done].sort()).toEqual([`proposed_song:${LOCAL_SONG}`, `video:${V1}`].sort());
    expect([...r.half]).toEqual([`deleted_video:${deletedVideoUuid(3)}`]);
    expect(r.foreign).toEqual(["video f0000000-0000-4000-8000-000000000000"]);
  });
});
