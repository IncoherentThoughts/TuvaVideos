// The archive's rows in the Local copy (sharing-spec §6.1, §6.2, ADR 0009; was the Mirror import of ticket #25) against
// a fixture shaped like the archive's tables: row mapping, hidden rows, the apply's skip guard and rollback, Performance
// defaults (YouTube and Rutube ids), Latin-title sources, search rows for alternates, and the editing endpoints.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { applyPerformanceDefaults } from "../src/server/defaults";
import { openDb } from "../src/server/db";
import { fillLatinTitles, latinFor, songNames } from "../src/server/latin";
import { parseOffset, parsePerformanceUrl, VARIOUS_ARTISTS_ID } from "../src/server/localCopy/archiveRows";
import { runArchiveFollowUps } from "../src/server/localCopy/followUps";
import { applyFlat, archiveChanges, FIXTURE, loadArchiveFixture } from "./helpers/archive";
import { insertChapter, insertLocalArtist, insertVideo, V } from "./helpers/seed";

const REAL = "/Users/evanwilliams/Desktop/Lyrics Website/Backups/supabase_backup_20261007_162813_no_media";
const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const n = (db: any, sql: string, ...p: any[]) => (db.query(sql).get(...p) as { n: number }).n;
const freshDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "tuva-arch-"));
  return { dir, db: openDb(join(dir, "library.db"), MIGRATIONS) };
};

describe("performance URLs", () => {
  test("YouTube id and offset from every URL form; Rutube ids; other hosts give nothing", () => {
    const none = { youtubeId: null, rutubeId: null, startS: null };
    expect(parsePerformanceUrl("https://www.youtube.com/watch?v=2athz_3fYfs&t=112")).toEqual({ youtubeId: "2athz_3fYfs", rutubeId: null, startS: 112 });
    expect(parsePerformanceUrl("https://youtu.be/6OntHy4GogQ?t=1035")).toEqual({ youtubeId: "6OntHy4GogQ", rutubeId: null, startS: 1035 });
    expect(parsePerformanceUrl("https://youtu.be/_G7elvGj8fU?&t=510")).toEqual({ youtubeId: "_G7elvGj8fU", rutubeId: null, startS: 510 });
    expect(parsePerformanceUrl("https://www.youtube.com/live/dddddddddd2?si=x")).toEqual({ youtubeId: "dddddddddd2", rutubeId: null, startS: null });
    expect(parsePerformanceUrl("https://www.youtube.com/watch?list=PL1&v=aaaaaaaaaaa&index=2")).toEqual({ youtubeId: "aaaaaaaaaaa", rutubeId: null, startS: null });
    expect(parsePerformanceUrl("https://www.youtube.com/watch?v=bfR4wjeayGohttps://www.youtube.com/watch?v=bfR4wjeayGo [new link]").youtubeId).toBe("bfR4wjeayGo");
    expect(parsePerformanceUrl("https://rutube.ru/video/52297c3e6db6942f45a89f3d1900e95c/?r=wd&t=336")).toEqual({ youtubeId: null, rutubeId: "52297c3e6db6942f45a89f3d1900e95c", startS: 336 });
    expect(parsePerformanceUrl("https://rutube.ru/video/F7B0CF634A9CCA9331E164EF3292463A/")).toEqual({ youtubeId: null, rutubeId: "f7b0cf634a9cca9331e164ef3292463a", startS: null });
    expect(parsePerformanceUrl("https://rutube.ru/play/embed/f7b0cf634a9cca9331e164ef3292463a")).toMatchObject({ rutubeId: "f7b0cf634a9cca9331e164ef3292463a" });
    expect(parsePerformanceUrl("https://rutube.ru/video/abc/?t=40")).toEqual(none); // not a 32-hex id
    expect(parsePerformanceUrl("https://vk.com/video123")).toEqual(none);
    expect(parsePerformanceUrl(null)).toEqual(none);
  });
  test("offsets: seconds, 112s, 1h2m3s", () => {
    expect([parseOffset("95"), parseOffset("112s"), parseOffset("1h2m3s"), parseOffset("2m"), parseOffset("x")]).toEqual([95, 112, 3723, 120, null]);
  });
});

describe("archive rows from the fixture", () => {
  const { dir, db } = freshDb();
  const r = loadArchiveFixture(db);
  const all = (sql: string, ...p: any[]) => db.query(sql).all(...p) as any[];
  const one = (sql: string, ...p: any[]) => db.query(sql).get(...p) as any;
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test("counts per table; hidden Songs kept with is_hidden and everything that belongs to them", () => {
    expect(r.applied).toEqual({
      archive_song: 4, archive_version: 4, archive_artist: 3, archive_album: 2, archive_album_credit: 1, archive_track: 4, archive_track_artist: 2, archive_performance: 8,
    });
    expect(all("SELECT name, is_hidden FROM archive_song ORDER BY id")).toEqual([
      { name: "Aa-shuu, dekei-oo", is_hidden: 0 }, { name: "Chaŋgys baglaash", is_hidden: 0 }, { name: "Hidden song", is_hidden: 1 }, { name: "Bai-Taiga", is_hidden: 0 },
    ]);
    expect(one("SELECT COUNT(*) n FROM archive_version WHERE id = ?", S(104)).n).toBe(1);
    expect(one("SELECT COUNT(*) n FROM archive_performance WHERE id = ?", S(604)).n).toBe(1);
    expect(r.watermark).toBe("2026-01-01T00:00:00+00:00");
  });
  test("kept columns carry through, with updated_at for the skip guard", () => {
    const song = one("SELECT * FROM archive_song WHERE id = ?", S(1));
    expect(song.alternate_titles).toBe("Dekei-oo");
    expect(song.alternate_spellings).toContain("Аа-шуу декей-оо");
    expect(song.updated_at).toBe("2026-01-01T00:00:00+00:00");
  });
  test("Versions keep three Scripts of HTML and JSON footnotes", () => {
    const v = one("SELECT * FROM archive_version ORDER BY display_order, id LIMIT 1");
    expect(v.cyrillic).toContain('data-fn="1"');
    expect(JSON.parse(v.footnotes_cyrillic)).toHaveLength(3);
    expect(v.translation).toBeNull();
    expect(JSON.parse(v.footnotes_translation)).toEqual([]);
  });
  test("Various Artists is derived from the id, its bio is discarded, and it is no Video's Artist (artist_all)", () => {
    expect(one("SELECT is_various_artists, bio FROM archive_artist WHERE id = ?", VARIOUS_ARTISTS_ID)).toEqual({ is_various_artists: 1, bio: null });
    expect(one("SELECT COUNT(*) n FROM archive_artist WHERE is_various_artists = 1").n).toBe(1);
    expect(one("SELECT COUNT(*) n FROM artist_all WHERE id = ?", VARIOUS_ARTISTS_ID).n).toBe(0);
    expect(all("SELECT artist_id FROM archive_album ORDER BY id").map((a) => a.artist_id)).toEqual([S(201), VARIOUS_ARTISTS_ID]);
  });
  test("Tracks: names trimmed (U+2028 too), hidden-song Track linked, Track Version kept", () => {
    expect(one("SELECT name FROM archive_track WHERE id = ?", S(503)).name).toBe("Instrumental");
    expect(one("SELECT name, song_id, version_id FROM archive_track WHERE id = ?", S(501))).toEqual({ name: "Dekei-oo", song_id: S(1), version_id: S(102) });
    expect(one("SELECT song_id FROM archive_track WHERE id = ?", S(502)).song_id).toBe(S(3));
  });
  test("Track artists renumber to 0..n-1; album credits keep created order", () => {
    expect(all("SELECT artist_id, position FROM archive_track_artist ORDER BY position").map((r) => [r.artist_id, r.position])).toEqual([[S(201), 0], [S(202), 1]]);
    expect(all("SELECT album_id, artist_id, position FROM archive_album_credit")).toEqual([{ album_id: S(301), artist_id: S(202), position: 0 }]);
  });
  test("Performances carry the parsed YouTube id and start offset", () => {
    const p = (id: string) => one("SELECT youtube_id, rutube_id, start_s, url, is_highlighted FROM archive_performance WHERE id = ?", id);
    expect(p(S(601))).toMatchObject({ youtube_id: "aaaaaaaaaaa", start_s: null });
    expect(p(S(602))).toMatchObject({ youtube_id: "bbbbbbbbbbb", start_s: 95 });
    expect(p(S(603))).toMatchObject({ youtube_id: "bbbbbbbbbbb", start_s: 3723 });
    expect(p(S(605))).toMatchObject({ youtube_id: null, rutube_id: null, start_s: null });
    expect(p(S(606)).url).toBeNull();
    expect(p(S(607)).is_highlighted).toBe(1);
  });
  test("song_all / version_all list the archive's rows with kind archive", () => {
    expect(all("SELECT DISTINCT kind FROM song_all")).toEqual([{ kind: "archive" }]);
    expect(one("SELECT COUNT(*) n FROM version_all WHERE kind = 'archive'").n).toBe(4);
  });
});

describe("applying archive rows again", () => {
  const { dir, db } = freshDb();
  loadArchiveFixture(db);
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test("a newer row replaces the held one, an older or equal one is skipped, local rows are untouched", () => {
    insertVideo(db, { id: 1, youtube_id: "aaaaaaaaaaa", title: "v1", song_id: S(2) });
    insertChapter(db, { id: 1, video_id: 1, start_s: 10, title: "c", song_id: S(2) });
    db.exec("INSERT INTO artist_latin (artist_id, name_latin, name_latin_source) VALUES ('" + S(201) + "', 'kept', 'manual')");
    const songs = archiveChanges().songs!;
    const s1 = songs.find((s) => s.id === S(1))!;
    const r = applyFlat(db, {
      songs: [
        { ...s1, name: "Renamed", updated_at: "2026-02-01T00:00:00+00:00" },
        { ...songs.find((s) => s.id === S(2))!, name: "Old name", updated_at: "2025-12-31T23:59:59.999999+00:00" },
        { ...songs.find((s) => s.id === S(4))!, name: "Same time" }, // equal updated_at: the held row is as new
      ],
      artists: [{ id: S(201), name: "Alash", is_hidden: false, updated_at: "2026-02-01 00:00:00.5+00" }],
    });
    expect(r.applied).toEqual({ archive_song: 1, archive_artist: 1 });
    expect(r.skipped).toEqual({ archive_song: 2 });
    expect(r.watermark).toBe("2026-02-01 00:00:00.5+00");
    expect(db.query("SELECT id, name FROM archive_song WHERE id IN (?, ?, ?) ORDER BY id").all(S(1), S(2), S(4))).toEqual([
      { id: S(1), name: "Renamed" }, { id: S(2), name: "Chaŋgys baglaash" }, { id: S(4), name: "Bai-Taiga" },
    ]);
    expect(db.query("SELECT name, name_latin, name_latin_source FROM artist_all WHERE id = ?").get(S(201))).toEqual({ name: "Alash", name_latin: "kept", name_latin_source: "manual" });
    expect(n(db, "SELECT COUNT(*) n FROM videos")).toBe(1);
    expect(n(db, "SELECT COUNT(*) n FROM video_chapters")).toBe(1);
    // the renamed Song is reindexed at once, with the Video that points at it
    expect((db.query("SELECT text FROM search WHERE kind = 'song' AND ref_id = ?").get(S(1)) as any).text).toStartWith("Renamed");
  });

  test("a failing batch rolls back entirely", () => {
    const before = n(db, "SELECT COUNT(*) n FROM archive_song");
    const songs = archiveChanges().songs!;
    expect(() =>
      applyFlat(db, {
        songs: [{ ...songs[0]!, id: S(77), slug: "new-song", updated_at: "2027-01-01T00:00:00Z" }],
        videos: [{ id: V(9), title: null } as any], // NOT NULL title: the whole batch fails
      }),
    ).toThrow();
    expect(n(db, "SELECT COUNT(*) n FROM archive_song")).toBe(before);
    expect(n(db, "SELECT COUNT(*) n FROM archive_song WHERE id = ?", S(77))).toBe(0);
  });
});

describe("Performance defaults (spec 2.3, sharing-spec §4.3)", () => {
  const { dir, db } = freshDb();
  loadArchiveFixture(db);
  const ins = (id: number, youtube_id: string | null, title: string, extra: Record<string, unknown> = {}) =>
    insertVideo(db, { id, youtube_id, content_hash: youtube_id ? null : `h${id}`, title, type: "other", type_suggested: 0, ...extra });
  ins(1, "aaaaaaaaaaa", "one song");
  ins(2, "bbbbbbbbbbb", "two songs");
  ins(3, "dddddddddd2", "same song twice");
  ins(4, "zzzzzzzzzzz", "no performance");
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const v = (id: number) => db.query("SELECT type, type_suggested t, song_id, song_suggested s, suggestion_source src FROM videos WHERE id = ?").get(V(id));
  test("one Song -> song + Suggested Song; 2+ Songs -> concert; none -> unchanged; same Song twice is one Song", () => {
    const stats = applyPerformanceDefaults(db);
    expect(stats).toEqual({ song: 2, concert: 1 });
    expect(v(1)).toEqual({ type: "song", t: 1, song_id: S(1), s: 1, src: "performance" });
    expect(v(2)).toEqual({ type: "concert", t: 1, song_id: null, s: 0, src: "performance" });
    expect(v(3)).toEqual({ type: "song", t: 1, song_id: S(4), s: 1, src: "performance" });
    expect(v(4)).toEqual({ type: "other", t: 0, song_id: null, s: 0, src: null });
  });
  test("a Rutube id matches a rutube.ru Performance like a YouTube id", () => {
    const rt = "52297c3e6db6942f45a89f3d1900e95c";
    db.exec(`INSERT INTO archive_performance (id, song_id, url, display_order, is_highlighted, rutube_id, start_s) VALUES ('rt1', '${S(2)}', 'https://rutube.ru/video/${rt}/', 9, 0, '${rt}', NULL)`);
    ins(5, null, "from rutube", { rutube_id: rt });
    expect(applyPerformanceDefaults(db, { videoId: V(5) })).toEqual({ song: 1, concert: 0 });
    expect(v(5)).toEqual({ type: "song", t: 1, song_id: S(2), s: 1, src: "performance" });
  });
  test("edited values are never overwritten, Shared Videos are left alone, and it is idempotent", () => {
    ins(6, "cccccccccc1", "edited other", { suggestion_source: "manual" });
    ins(7, "aaaaaaaaaa2", "has a manual Song", { song_id: "my-song" });
    db.exec("UPDATE archive_performance SET youtube_id = 'aaaaaaaaaa2' WHERE id = '" + S(601) + "'");
    ins(8, "bbbbbbbbbb9", "Shared", { shared: 1 });
    db.exec("UPDATE archive_performance SET youtube_id = 'bbbbbbbbbb9' WHERE id = '" + S(605) + "'");
    expect(applyPerformanceDefaults(db)).toEqual({ song: 0, concert: 0 });
    expect(db.query("SELECT type, song_id FROM videos WHERE id = ?").get(V(7))).toEqual({ type: "other", song_id: "my-song" });
    expect(db.query("SELECT type FROM videos WHERE id = ?").get(V(6))).toEqual({ type: "other" });
    expect(v(8)).toMatchObject({ type: "other", song_id: null });
  });
});

describe("Latin titles (spec 2.5)", () => {
  const s1 = songNames({ name: "Chaŋgys baglaash", english_name: "Lonely hitching post", alternate_spellings: "Чаңгыс баглааш, Changys baglaash" });
  test("archive: the title is the Song's Cyrillic spelling (loosely) -> the archive's Latin name", () => {
    expect(latinFor("Чаңгыс баглааш", s1)).toEqual({ latin: "Chaŋgys baglaash", source: "archive" });
    expect(latinFor("ЧАҢГЫС  баглааш!", s1)).toEqual({ latin: "Chaŋgys baglaash", source: "archive" });
  });
  test("table: no Song, or a title that is not one of the Song's spellings", () => {
    expect(latinFor("Чаңгыс баглааш", null)).toEqual({ latin: "Chaŋgys baglaash", source: "table" });
    expect(latinFor("Радик Тюлюш - Чаңгыс баглааш", s1).source).toBe("table");
  });
  test("a title already in Latin stays NULL", () => {
    expect(latinFor("Alash - Khoomei", s1)).toEqual({ latin: null, source: null });
  });
  test("the Latin name may be a Cyrillic-only Song: first Latin alternate spelling wins", () => {
    const s = songNames({ name: "Чаңгыс", alternate_spellings: "Чаньгыс, Changys" });
    expect(latinFor("Чаңгыс", s)).toEqual({ latin: "Changys", source: "archive" });
    expect(latinFor("Чаңгыс", songNames({ name: "Чаңгыс" })).source).toBe("table");
  });

  const { dir, db } = freshDb();
  loadArchiveFixture(db);
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test("the fill writes sources, skips manual and Shared Videos, and clears a title that became Latin", () => {
    insertVideo(db, { id: 1, youtube_id: "aaaaaaaaaaa", title: "Чаңгыс баглааш", song_id: S(2) });
    insertVideo(db, { id: 2, youtube_id: "bbbbbbbbbbb", title: "Чаңгыс баглааш" });
    insertVideo(db, { id: 3, youtube_id: "ccccccccccc", title: "Тыва концерт", title_latin: "my own", title_latin_source: "manual" });
    insertVideo(db, { id: 4, youtube_id: "ddddddddddd", title: "English now", title_latin: "stale", title_latin_source: "table" });
    insertVideo(db, { id: 5, youtube_id: "eeeeeeeeeee", title: "Тыва", shared: 1 }); // Shared: its Latin title is the Shared data's
    insertLocalArtist(db, { name: "Радик Тюлюш" });
    insertChapter(db, { video_id: 1, start_s: 5, title: "Бай-Тайга", song_id: S(4) });
    const stats = fillLatinTitles(db);
    const v = (id: number) => db.query("SELECT title_latin l, title_latin_source s FROM videos WHERE id = ?").get(V(id));
    expect(v(1)).toEqual({ l: "Chaŋgys baglaash", s: "archive" });
    expect(v(2)).toEqual({ l: "Chaŋgys baglaash", s: "table" });
    expect(v(3)).toEqual({ l: "my own", s: "manual" });
    expect(v(4)).toEqual({ l: null, s: null });
    expect(v(5)).toEqual({ l: null, s: null });
    expect(db.query("SELECT name_latin l, name_latin_source s FROM artist_all WHERE name = 'Радик Тюлюш'").get()).toEqual({ l: "Radik Tjuljush", s: "table" });
    expect(db.query("SELECT title_latin l, title_latin_source s FROM video_chapters").get()).toEqual({ l: "Bai-Taiga", s: "archive" });
    // the archive's Cyrillic Artist got its Latin name when the apply brought it; only the new Local Artist is left
    expect(stats).toMatchObject({ videos: 3, chapters: 1, artists: 1, archive: 2, table: 2, cleared: 1 });
    expect(fillLatinTitles(db)).toMatchObject({ videos: 0, chapters: 0, artists: 0 }); // idempotent
  });
});

describe("real 2026-10-07 backup", () => {
  test.skipIf(!existsSync(REAL))("applies with the counts the research found", () => {
    const { dir, db } = freshDb();
    const r = applyFlat(db, archiveChanges(REAL));
    expect(r.applied.archive_song).toBe(145); // 146 minus the zz_ test song
    expect(n(db, "SELECT COUNT(*) n FROM archive_song WHERE is_hidden = 1")).toBe(87);
    expect(r.applied.archive_version).toBe(159);
    expect(r.applied.archive_artist).toBe(109);
    expect(r.applied.archive_album).toBe(96);
    expect(r.applied.archive_album_credit).toBe(15);
    expect(r.applied.archive_track).toBe(1176);
    expect(r.applied.archive_track_artist).toBe(143);
    expect(n(db, "SELECT COUNT(*) n FROM archive_performance WHERE youtube_id IS NOT NULL")).toBeGreaterThan(400);
    expect(n(db, "SELECT COUNT(*) n FROM archive_performance WHERE rutube_id IS NOT NULL")).toBe(34);
    expect(n(db, "SELECT COUNT(*) n FROM archive_song WHERE slug LIKE 'zz%'")).toBe(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Endpoints and index rows against a running app
// ---------------------------------------------------------------------------------------------------------------

const base = mkdtempSync(join(tmpdir(), "tuva-edit-"));
mkdirSync(join(base, "local"), { recursive: true });
mkdirSync(join(base, "ext"), { recursive: true });
let app: App;
let url: string;
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(url + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

describe("editing endpoints", () => {
  beforeAll(async () => {
    app = await startApp(loadConfig({ TUVA_DATA_DIR: join(base, "data"), TUVA_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: join(base, "local"), TUVA_EXTERNAL_ROOT: join(base, "ext") }));
    url = `http://localhost:${app.server.port}`;
    await app.scanner.requestAll(); // nothing is scanned at startup (spec 3.2)
    await app.scanner.whenIdle();
    const db = app.db;
    insertVideo(db, { id: 1, youtube_id: "aaaaaaaaaaa", title: "Чаңгыс баглааш", created_at: "x" });
    insertVideo(db, { id: 2, youtube_id: "bbbbbbbbbbb", title: "Concert", created_at: "x" });
    insertVideo(db, { id: 3, youtube_id: "eeeeeeeeeee", title: "Plain", created_at: "x" });
    loadArchiveFixture(db);
    await runArchiveFollowUps(db);
  }, 30_000);
  afterAll(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  test("the follow-ups defaulted Videos 1 and 2 and the API says so", async () => {
    const v1 = (await call("GET", `/api/videos/${V(1)}`)).body;
    expect(v1).toMatchObject({ id: V(1), type: "song", typeSuggested: true, songId: S(1), songSuggested: true, suggestionSource: "performance", song: { id: S(1), name: "Aa-shuu, dekei-oo", proposed: false }, shared: false, rutubeId: null });
    expect(v1.song.versions.map((v: any) => v.label)).toEqual(["Complete", "Short"]);
    expect(v1.titleLatin).toBe("Chaŋgys baglaash"); // table form: no archive tie to Song 1
    expect(v1.titleLatinSource).toBe("table");
    const v2 = (await call("GET", `/api/videos/${V(2)}`)).body;
    expect(v2).toMatchObject({ type: "concert", typeSuggested: true, songId: null });
    expect((await call("GET", `/api/videos/${V(3)}`)).body).toMatchObject({ type: "other", typeSuggested: false });
  });

  test("search finds a Song by an alternate title and by a Cyrillic alternate spelling, scored below the name", async () => {
    const s = async (q: string) => (await call("GET", `/api/search?q=${encodeURIComponent(q)}`)).body.groups.find((g: any) => g.key === "songs")?.rows ?? [];
    expect((await s("#songs dekei")).map((r: any) => r.id)).toContain(S(1));
    expect((await s("Аа-шуу")).map((r: any) => r.id)).toContain(S(1));
    expect((await s("#songs lonely")).map((r: any) => r.id)).toEqual([S(2)]);
    const lyric = await s("челер оюм");
    expect(lyric[0]).toMatchObject({ id: S(1), viaLyrics: true });
  });

  test("GET /api/songs/:id: Versions with sanitized HTML, footnotes, alternates and the Videos that perform it", async () => {
    const r = await call("GET", `/api/songs/${S(1)}`);
    expect(r.status).toBe(200);
    expect(r.body.alternateTitles).toEqual(["Dekei-oo"]);
    expect(r.body.alternateSpellings).toContain("Аа-шуу декей-оо");
    expect(r.body.names.map((x: any) => x.kind)[0]).toBe("name");
    expect(r.body.versions.map((v: any) => v.label)).toEqual(["Complete", "Short"]);
    const cyr = r.body.versions[0].scripts.cyrillic;
    expect(cyr.html).toContain('data-fn="1"');
    expect(cyr.footnotes[0].text).toBe("Alt: <b>үнген</b>"); // <script> removed
    expect(r.body.versions[1].scripts.transliteration.html).toBe("");
    expect(r.body.videos.map((v: any) => v.id).sort()).toEqual([V(1), V(2)]);
    expect(r.body.videos.find((v: any) => v.id === V(2)).startS).toBe(95);
    expect((await call("GET", "/api/songs/00000000-0000-4000-8000-0000000000ff")).status).toBe(404);
  });

  test("PATCH title: trimmed, Latin title regenerated, index updated; empty refused", async () => {
    expect((await call("PATCH", `/api/videos/${V(3)}`, { title: "   " })).status).toBe(400);
    const r = await call("PATCH", `/api/videos/${V(3)}`, { title: "  Алаш   концерт " });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ title: "Алаш концерт", titleLatin: "Alash kontsert", titleLatinSource: "table" });
    const hit = (await call("GET", "/api/search?q=kontsert")).body.groups.find((g: any) => g.key === "videos").rows.map((x: any) => x.id);
    expect(hit).toContain(V(3));
  });

  test("PATCH type confirms: flags off, source manual; bad type refused; unknown video 404", async () => {
    const r = await call("PATCH", `/api/videos/${V(2)}`, { type: "concert" }); // confirm = same value
    expect(r.body).toMatchObject({ type: "concert", typeSuggested: false, suggestionSource: "manual" });
    expect((await call("PATCH", `/api/videos/${V(2)}`, { type: "podcast" })).status).toBe(400);
    expect((await call("PATCH", `/api/videos/${V(999)}`, { type: "song" })).status).toBe(404);
    expect((await call("PATCH", "/api/videos/999", { type: "song" })).status).toBe(404); // an integer id is no route now
    expect((await call("PATCH", `/api/videos/${V(2)}`, { type: "interview" })).body.type).toBe("interview");
  });

  test("PATCH song: confirm, change resets Version, Version must belong to the Song, clear", async () => {
    let r = await call("PATCH", `/api/videos/${V(1)}`, { songId: S(1) }); // confirm
    expect(r.body).toMatchObject({ songId: S(1), songSuggested: false, suggestionSource: "manual", versionId: null });
    r = await call("PATCH", `/api/videos/${V(1)}`, { versionId: S(102) });
    expect(r.body.versionId).toBe(S(102));
    expect((await call("PATCH", `/api/videos/${V(1)}`, { versionId: S(103) })).status).toBe(400); // another Song's Version
    expect((await call("PATCH", `/api/videos/${V(1)}`, { songId: "nope" })).status).toBe(404);
    r = await call("PATCH", `/api/videos/${V(1)}`, { songId: S(2) });
    expect(r.body).toMatchObject({ songId: S(2), versionId: null });
    expect(r.body.titleLatinSource).toBe("archive"); // title is now Song 2's Cyrillic spelling
    expect(r.body.titleLatin).toBe("Chaŋgys baglaash");
    r = await call("PATCH", `/api/videos/${V(1)}`, { songId: null });
    expect(r.body).toMatchObject({ songId: null, song: null, songSuggested: false });
    expect((await call("PATCH", `/api/videos/${V(1)}`, { versionId: S(101) })).status).toBe(400); // no Song
  });

  test("a Proposed Song is pointed at through proposed_song_id and reads back as one Song with proposed: true", async () => {
    applyFlat(app.db, { video_proposed_songs: [{ id: S(900), name: "zz-test Proposed", english_name: null, alternate_titles: null, notes: null, created_by: null, created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T00:00:00Z" }] });
    const r = await call("PATCH", `/api/videos/${V(3)}`, { songId: S(900) });
    expect(r.body).toMatchObject({ songId: S(900), song: { id: S(900), name: "zz-test Proposed", proposed: true, local: false } });
    expect(app.db.query("SELECT song_id, proposed_song_id FROM videos WHERE id = ?").get(V(3))).toEqual({ song_id: null, proposed_song_id: S(900) });
    await call("PATCH", `/api/videos/${V(3)}`, { songId: null });
  });

  test("a rescan keeps edits (no Root is mounted with files, so scan runs but cannot touch them)", async () => {
    await call("POST", "/api/rescan");
    await app.scanner.whenIdle();
    expect((await call("GET", `/api/videos/${V(3)}`)).body.title).toBe("Алаш концерт");
    expect((await call("GET", `/api/videos/${V(2)}`)).body).toMatchObject({ type: "interview", suggestionSource: "manual" });
  });

  test("manual Latin titles survive a title edit and the fill", async () => {
    let r = await call("PATCH", `/api/videos/${V(3)}`, { titleLatin: "Alash my way" });
    expect(r.body).toMatchObject({ titleLatin: "Alash my way", titleLatinSource: "manual" });
    r = await call("PATCH", `/api/videos/${V(3)}`, { title: "Алаш 2" });
    expect(r.body.titleLatin).toBe("Alash my way");
    r = await call("PATCH", `/api/videos/${V(3)}`, { titleLatin: "" });
    expect(r.body).toMatchObject({ titleLatin: "Alash 2", titleLatinSource: "table" });
  });

  test("POST /api/artists creates a Local Artist once; PUT artists replaces the ordered list", async () => {
    const c = await call("POST", "/api/artists", { name: "  Новый   артист " });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: "Новый артист", local: true, created: true });
    const again = await call("POST", "/api/artists", { name: "новый артист" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: c.body.id, created: false });
    expect((await call("POST", "/api/artists", { name: " " })).status).toBe(400);
    expect(app.db.query("SELECT kind, name_latin, name_latin_source FROM artist_all WHERE id = ?").get(c.body.id)).toEqual({ kind: "local", name_latin: "Novyi artist", name_latin_source: "table" });

    const archiveId = S(201);
    let r = await call("PUT", `/api/videos/${V(2)}/artists`, { artistIds: [c.body.id, archiveId, c.body.id] });
    expect(r.body.artists.map((a: any) => [a.id, a.local])).toEqual([[c.body.id, true], [archiveId, false]]);
    r = await call("PUT", `/api/videos/${V(2)}/artists`, { artistIds: [archiveId] });
    expect(r.body.artists).toHaveLength(1);
    expect((await call("PUT", `/api/videos/${V(2)}/artists`, { artistIds: [S(987654)] })).status).toBe(404);
    expect((await call("PUT", `/api/videos/${V(2)}/artists`, { artistIds: "x" })).status).toBe(400);
    expect((await call("PUT", `/api/videos/${V(2)}/artists`, { artistIds: [] })).body.artists).toEqual([]);
    // the new Local Artist is searchable at once
    const found = (await call("GET", "/api/search?q=" + encodeURIComponent("#artists novyi"))).body.groups.find((g: any) => g.key === "artists");
    expect(found.rows.some((x: any) => x.id === c.body.id && x.local)).toBe(true);
  });

  test("a Track row carries its Song and Version for the search box", async () => {
    const r = (await call("GET", "/api/search?q=" + encodeURIComponent("#tracks dekei"))).body.groups.find((g: any) => g.key === "tracks");
    expect(r.rows[0]).toMatchObject({ songId: S(1), versionId: S(102) });
  });
});
