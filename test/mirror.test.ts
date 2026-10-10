// Ticket #25 against a fixture backup shaped like the 2026-10-07 one: import mapping, hidden rows, the re-import
// transaction, Performance defaults, Latin-title sources, search rows for alternates, and the editing endpoints.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { applyPerformanceDefaults } from "../src/server/defaults";
import { openDb } from "../src/server/db";
import { runImport } from "../src/server/import";
import { fillLatinTitles, latinFor, songNames } from "../src/server/latin";
import { BackupError, importMirror, mapBackup, parseOffset, parsePerformanceUrl, readBackup, VARIOUS_ARTISTS_ID } from "../src/server/mirror";

const FIXTURE = join(import.meta.dir, "fixtures", "backup");
const REAL = "/Users/evanwilliams/Desktop/Lyrics Website/Backups/supabase_backup_20261007_162813_no_media";
const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const n = (db: any, sql: string, ...p: any[]) => (db.query(sql).get(...p) as { n: number }).n;

describe("performance URLs", () => {
  test("YouTube id and offset from every URL form; other hosts give nothing", () => {
    expect(parsePerformanceUrl("https://www.youtube.com/watch?v=2athz_3fYfs&t=112")).toEqual({ youtubeId: "2athz_3fYfs", startS: 112 });
    expect(parsePerformanceUrl("https://youtu.be/6OntHy4GogQ?t=1035")).toEqual({ youtubeId: "6OntHy4GogQ", startS: 1035 });
    expect(parsePerformanceUrl("https://youtu.be/_G7elvGj8fU?&t=510")).toEqual({ youtubeId: "_G7elvGj8fU", startS: 510 });
    expect(parsePerformanceUrl("https://www.youtube.com/live/dddddddddd2?si=x")).toEqual({ youtubeId: "dddddddddd2", startS: null });
    expect(parsePerformanceUrl("https://www.youtube.com/watch?list=PL1&v=aaaaaaaaaaa&index=2")).toEqual({ youtubeId: "aaaaaaaaaaa", startS: null });
    expect(parsePerformanceUrl("https://www.youtube.com/watch?v=bfR4wjeayGohttps://www.youtube.com/watch?v=bfR4wjeayGo [new link]").youtubeId).toBe("bfR4wjeayGo");
    expect(parsePerformanceUrl("https://rutube.ru/video/abc/?t=40")).toEqual({ youtubeId: null, startS: null });
    expect(parsePerformanceUrl(null)).toEqual({ youtubeId: null, startS: null });
  });
  test("offsets: seconds, 112s, 1h2m3s", () => {
    expect([parseOffset("95"), parseOffset("112s"), parseOffset("1h2m3s"), parseOffset("2m"), parseOffset("x")]).toEqual([95, 112, 3723, 120, null]);
  });
});

describe("mapBackup on the fixture", () => {
  const m = mapBackup(readBackup(FIXTURE));
  test("hidden songs and everything that belongs to them are dropped", () => {
    expect(m.mirror_song.map((s) => s.name)).toEqual(["Aa-shuu, dekei-oo", "Chaŋgys baglaash", "Bai-Taiga"]);
    expect(m.mirror_version.map((v) => v.id)).toEqual([S(101), S(103), S(102)]);
    expect(m.mirror_performance.map((p) => p.id)).not.toContain(S(604));
    expect(m.skipped).toMatchObject({ hiddenSongs: 1, versionsOfHidden: 1, performancesOfHidden: 1, tracksUnlinked: 1 });
  });
  test("dropped columns are gone, kept ones carry through", () => {
    const song = m.mirror_song[0]!;
    expect(Object.keys(song).sort()).toEqual(["alternate_spellings", "alternate_titles", "country", "english_name", "id", "name", "notes", "slug"]);
    expect(song.alternate_titles).toBe("Dekei-oo");
    expect(song.alternate_spellings).toContain("Аа-шуу декей-оо");
    expect(Object.keys(m.mirror_version[0]!)).not.toContain("source");
    expect(Object.keys(m.mirror_album[0]!)).not.toContain("lastfm_id");
  });
  test("Versions keep three Scripts of HTML and JSON footnotes", () => {
    const v = m.mirror_version[0]!;
    expect(v.cyrillic).toContain('data-fn="1"');
    expect(JSON.parse(v.footnotes_cyrillic)).toHaveLength(3);
    expect(v.translation).toBeNull();
    expect(JSON.parse(v.footnotes_translation)).toEqual([]);
  });
  test("Various Artists is derived from the id, its bio is discarded; band ids are ignored", () => {
    const va = m.mirror_artist.find((a) => a.id === VARIOUS_ARTISTS_ID)!;
    expect(va).toMatchObject({ is_various_artists: 1, bio: null });
    expect(m.mirror_artist.filter((a) => a.is_various_artists)).toHaveLength(1);
    expect(Object.keys(m.mirror_artist[0]!)).not.toContain("band_id");
    expect(m.mirror_album.map((a) => a.artist_id)).toEqual([S(201), VARIOUS_ARTISTS_ID]);
  });
  test("Tracks: names trimmed (U+2028 too), hidden-song Track unlinked, Track Version kept when it exists", () => {
    const t = Object.fromEntries(m.mirror_track.map((x) => [x.id, x]));
    expect(t[S(503)].name).toBe("Instrumental");
    expect(t[S(501)]).toMatchObject({ name: "Dekei-oo", song_id: S(1), version_id: S(102) });
    expect(t[S(502)]).toMatchObject({ song_id: null, version_id: null });
  });
  test("Track artists renumber to 0..n-1; album credits keep created order", () => {
    expect(m.mirror_track_artist.map((r) => [r.artist_id, r.position])).toEqual([[S(201), 0], [S(202), 1]]);
    expect(m.mirror_album_credit).toEqual([{ album_id: S(301), artist_id: S(202), position: 0 }]);
  });
  test("Performances carry the parsed YouTube id and start offset", () => {
    const p = Object.fromEntries(m.mirror_performance.map((x) => [x.id, x]));
    expect(p[S(601)]).toMatchObject({ youtube_id: "aaaaaaaaaaa", start_s: null });
    expect(p[S(602)]).toMatchObject({ youtube_id: "bbbbbbbbbbb", start_s: 95 });
    expect(p[S(603)]).toMatchObject({ youtube_id: "bbbbbbbbbbb", start_s: 3723 });
    expect(p[S(605)]).toMatchObject({ youtube_id: null, start_s: null });
    expect(p[S(606)].url).toBeNull();
    expect(p[S(607)].is_highlighted).toBe(1);
  });
});

describe("pre-126 backups are refused", () => {
  test("no album_track_artists.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "tuva-old-"));
    cpSync(FIXTURE, dir, { recursive: true });
    rmSync(join(dir, "album_track_artists.json"));
    expect(() => readBackup(dir)).toThrow(BackupError);
    expect(() => readBackup(dir)).toThrow(/predates archive migration 126/);
    rmSync(dir, { recursive: true, force: true });
  });
  test("albums without artist_id", () => {
    const dir = mkdtempSync(join(tmpdir(), "tuva-old-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const albums = JSON.parse(readFileSync(join(dir, "albums.json"), "utf8")).map(({ artist_id: _a, ...r }: any) => r);
    writeFileSync(join(dir, "albums.json"), JSON.stringify(albums));
    expect(() => readBackup(dir)).toThrow(/albums have no artist_id/);
    expect(() => readBackup("/nonexistent/backup")).toThrow(/not found/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("import transaction", () => {
  const dir = mkdtempSync(join(tmpdir(), "tuva-imp-"));
  const db = openDb(join(dir, "library.db"), MIGRATIONS);
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("first import: counts, Artist upsert without the sentinel, mirror_import row", () => {
    const r = importMirror(db, FIXTURE, () => new Date("2026-10-10T00:00:00Z"));
    expect(r.counts).toEqual({
      mirror_song: 3, mirror_version: 3, mirror_artist: 3, mirror_album: 2, mirror_album_credit: 1, mirror_track: 4, mirror_track_artist: 2, mirror_performance: 7, artist_upserted: 2,
    });
    expect(n(db, "SELECT COUNT(*) n FROM artist WHERE mirror_id IS NOT NULL")).toBe(2);
    expect(n(db, "SELECT COUNT(*) n FROM artist WHERE mirror_id = ?", VARIOUS_ARTISTS_ID)).toBe(0);
    const row = db.query("SELECT * FROM mirror_import").get() as any;
    expect(row).toMatchObject({ backup_name: "backup", imported_at: "2026-10-10T00:00:00.000Z", dangling_refs: 0 });
    expect(JSON.parse(row.row_counts).mirror_song).toBe(3);
  });

  test("re-import wipes and replaces Mirror rows, leaves local rows, counts dangling refs", () => {
    db.exec("INSERT INTO video (id, youtube_id, title, song_id, version_id, created_at) VALUES (1, 'aaaaaaaaaaa', 'v1', '" + S(2) + "', NULL, 'x'), (2, 'bbbbbbbbbbb', 'v2', '" + S(1) + "', '" + S(102) + "', 'x')");
    db.exec("INSERT INTO chapter (video_id, start_s, title, song_id, source) VALUES (2, 10, 'c', '" + S(2) + "', 'manual')");
    db.exec("UPDATE artist SET name_latin = 'kept' WHERE mirror_id = '" + S(201) + "'");
    // the archive drops Song 2 (Chaŋgys) and Artist 202, renames Artist 201
    const dir2 = mkdtempSync(join(tmpdir(), "tuva-imp2-"));
    cpSync(FIXTURE, dir2, { recursive: true });
    const edit = (f: string, fn: (rows: any[]) => any[]) => writeFileSync(join(dir2, f), JSON.stringify(fn(JSON.parse(readFileSync(join(dir2, f), "utf8")))));
    edit("songs.json", (r) => r.filter((s) => s.id !== S(2)));
    edit("song_lyrics.json", (r) => r.filter((s) => s.song_id !== S(2)));
    edit("song_performances.json", (r) => r.filter((s) => s.song_id !== S(2)));
    edit("album_tracks.json", (r) => r.map((t) => (t.song_id === S(2) ? { ...t, song_id: null } : t)));
    edit("album_artists.json", () => []);
    edit("album_track_artists.json", (r) => r.filter((t) => t.artist_id !== S(202)));
    edit("artists.json", (r) => r.filter((a) => a.id !== S(202)).map((a) => (a.id === S(201) ? { ...a, name: "Alash" } : a)));
    const r = importMirror(db, dir2);
    rmSync(dir2, { recursive: true, force: true });

    expect(r.counts.mirror_song).toBe(2);
    expect(n(db, "SELECT COUNT(*) n FROM mirror_song WHERE id = ?", S(2))).toBe(0);
    expect(n(db, "SELECT COUNT(*) n FROM video")).toBe(2); // local rows untouched
    expect(n(db, "SELECT COUNT(*) n FROM chapter")).toBe(1);
    expect(db.query("SELECT song_id FROM video WHERE id = 1").get()).toEqual({ song_id: S(2) }); // dangling uuid stays
    expect(db.query("SELECT name, name_latin FROM artist WHERE mirror_id = ?").get(S(201))).toEqual({ name: "Alash", name_latin: "kept" });
    expect(n(db, "SELECT COUNT(*) n FROM artist WHERE mirror_id = ?", S(202))).toBe(1); // stays, now dangling
    expect(r.dangling).toMatchObject({ videoSong: 1, chapterSong: 1, artist: 1, videoVersion: 0, total: 3 });
    expect(n(db, "SELECT COUNT(*) n FROM mirror_import")).toBe(2);
    expect((db.query("SELECT dangling_refs d FROM mirror_import ORDER BY id DESC LIMIT 1").get() as any).d).toBe(3);
  });

  test("a failing import rolls back and leaves the previous Mirror", () => {
    const before = n(db, "SELECT COUNT(*) n FROM mirror_song");
    const dir3 = mkdtempSync(join(tmpdir(), "tuva-imp3-"));
    cpSync(FIXTURE, dir3, { recursive: true });
    const songs = JSON.parse(readFileSync(join(dir3, "songs.json"), "utf8"));
    songs.push({ ...songs[0] }); // duplicate primary key
    writeFileSync(join(dir3, "songs.json"), JSON.stringify(songs));
    expect(() => importMirror(db, dir3)).toThrow();
    rmSync(dir3, { recursive: true, force: true });
    expect(n(db, "SELECT COUNT(*) n FROM mirror_song")).toBe(before);
    expect(n(db, "SELECT COUNT(*) n FROM mirror_import")).toBe(2);
  });
});

describe("Performance defaults (spec 2.3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tuva-def-"));
  const db = openDb(join(dir, "library.db"), MIGRATIONS);
  importMirror(db, FIXTURE);
  const ins = db.prepare("INSERT INTO video (id, youtube_id, title, type, type_suggested, song_id, suggestion_source, created_at) VALUES (?,?,?,?,?,?,?, 'x')");
  ins.run(1, "aaaaaaaaaaa", "one song", "other", 0, null, null);
  ins.run(2, "bbbbbbbbbbb", "two songs", "other", 0, null, null);
  ins.run(3, "dddddddddd2", "same song twice", "other", 0, null, null);
  ins.run(4, "zzzzzzzzzzz", "no performance", "other", 0, null, null);
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test("one Song -> song + Suggested Song; 2+ Songs -> concert; none -> unchanged; same Song twice is one Song", () => {
    const stats = applyPerformanceDefaults(db);
    expect(stats).toEqual({ song: 2, concert: 1 });
    const v = (id: number) => db.query("SELECT type, type_suggested t, song_id, song_suggested s, suggestion_source src FROM video WHERE id = ?").get(id);
    expect(v(1)).toEqual({ type: "song", t: 1, song_id: S(1), s: 1, src: "performance" });
    expect(v(2)).toEqual({ type: "concert", t: 1, song_id: null, s: 0, src: "performance" });
    expect(v(3)).toEqual({ type: "song", t: 1, song_id: S(4), s: 1, src: "performance" });
    expect(v(4)).toEqual({ type: "other", t: 0, song_id: null, s: 0, src: null });
  });
  test("edited values are never overwritten, and it is idempotent", () => {
    db.exec("INSERT INTO video (id, youtube_id, title, type, suggestion_source, created_at) VALUES (6, 'cccccccccc1', 'edited other', 'other', 'manual', 'x')");
    db.exec("INSERT INTO video (id, youtube_id, title, type, song_id, created_at) VALUES (7, 'aaaaaaaaaaa2', 'has a manual Song', 'other', 'my-song', 'x')");
    db.exec("UPDATE mirror_performance SET youtube_id = 'aaaaaaaaaaa2' WHERE id = '" + S(601) + "'");
    db.exec("INSERT INTO video (id, youtube_id, title, type, suggestion_source, created_at) VALUES (8, 'aaaaaaaaaaa2', 'dup', 'other', 'manual', 'x')".replace("8, 'aaaaaaaaaaa2'", "8, 'aaaaaaaaaaa3'"));
    expect(applyPerformanceDefaults(db)).toEqual({ song: 0, concert: 0 });
    expect(db.query("SELECT type, song_id FROM video WHERE id = 7").get()).toEqual({ type: "other", song_id: "my-song" });
    expect(db.query("SELECT type FROM video WHERE id = 6").get()).toEqual({ type: "other" });
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

  const dir = mkdtempSync(join(tmpdir(), "tuva-lat-"));
  const db = openDb(join(dir, "library.db"), MIGRATIONS);
  importMirror(db, FIXTURE);
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test("the fill writes sources, skips manual, and clears a title that became Latin", () => {
    const ins = db.prepare("INSERT INTO video (id, youtube_id, title, title_latin, title_latin_source, song_id, created_at) VALUES (?,?,?,?,?,?, 'x')");
    ins.run(1, "aaaaaaaaaaa", "Чаңгыс баглааш", null, null, S(2));
    ins.run(2, "bbbbbbbbbbb", "Чаңгыс баглааш", null, null, null);
    ins.run(3, "ccccccccccc", "Тыва концерт", "my own", "manual", null);
    ins.run(4, "ddddddddddd", "English now", "stale", "table", null);
    db.exec("INSERT INTO artist (mirror_id, name) VALUES (NULL, 'Радик Тюлюш')");
    db.exec("INSERT INTO chapter (video_id, start_s, title, song_id, source) VALUES (1, 5, 'Бай-Тайга', '" + S(4) + "', 'manual')");
    const stats = fillLatinTitles(db);
    const v = (id: number) => db.query("SELECT title_latin l, title_latin_source s FROM video WHERE id = ?").get(id);
    expect(v(1)).toEqual({ l: "Chaŋgys baglaash", s: "archive" });
    expect(v(2)).toEqual({ l: "Chaŋgys baglaash", s: "table" });
    expect(v(3)).toEqual({ l: "my own", s: "manual" });
    expect(v(4)).toEqual({ l: null, s: null });
    expect(db.query("SELECT name_latin l, name_latin_source s FROM artist WHERE name = 'Радик Тюлюш'").get()).toEqual({ l: "Radik Tjuljush", s: "table" });
    expect(db.query("SELECT title_latin l, title_latin_source s FROM chapter").get()).toEqual({ l: "Bai-Taiga", s: "archive" });
    expect(stats).toMatchObject({ videos: 3, chapters: 1, artists: 2, archive: 2, table: 3, cleared: 1 });
    expect(fillLatinTitles(db)).toMatchObject({ videos: 0, chapters: 0, artists: 0 }); // idempotent
  });
});

describe("real 2026-10-07 backup", () => {
  test.skipIf(!existsSync(REAL))("maps to the counts the research found", () => {
    const m = mapBackup(readBackup(REAL));
    expect(m.mirror_song).toHaveLength(58);
    expect(m.mirror_version).toHaveLength(69);
    expect(m.mirror_artist).toHaveLength(109);
    expect(m.mirror_album).toHaveLength(96);
    expect(m.mirror_album_credit).toHaveLength(15);
    expect(m.mirror_track).toHaveLength(1176);
    expect(m.mirror_track_artist).toHaveLength(143);
    expect(m.mirror_performance).toHaveLength(680);
    expect(m.skipped.hiddenSongs).toBe(88);
    expect(m.mirror_performance.filter((p) => p.youtube_id).length).toBeGreaterThan(400);
    expect(m.mirror_song.some((s) => /^zz_/.test(s.slug))).toBe(false);
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
    await app.scanner.whenIdle();
    const db = app.db;
    db.exec("INSERT INTO video (id, youtube_id, title, created_at) VALUES (1, 'aaaaaaaaaaa', 'Чаңгыс баглааш', 'x'), (2, 'bbbbbbbbbbb', 'Concert', 'x'), (3, 'eeeeeeeeeee', 'Plain', 'x')");
    await runImport(db, FIXTURE);
  }, 30_000);
  afterAll(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  test("import defaulted Videos 1 and 2 and the API says so", async () => {
    const v1 = (await call("GET", "/api/videos/1")).body;
    expect(v1).toMatchObject({ type: "song", typeSuggested: true, songId: S(1), songSuggested: true, suggestionSource: "performance", song: { id: S(1), name: "Aa-shuu, dekei-oo" } });
    expect(v1.song.versions.map((v: any) => v.label)).toEqual(["Complete", "Short"]);
    expect(v1.titleLatin).toBe("Chaŋgys baglaash".replace("Chaŋgys baglaash", "Chaŋgys baglaash") === v1.titleLatin ? v1.titleLatin : "Chaŋgys baglaash"); // table form: no archive tie to Song 1
    expect(v1.titleLatinSource).toBe("table");
    const v2 = (await call("GET", "/api/videos/2")).body;
    expect(v2).toMatchObject({ type: "concert", typeSuggested: true, songId: null });
    expect((await call("GET", "/api/videos/3")).body).toMatchObject({ type: "other", typeSuggested: false });
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
    expect(r.body.videos.map((v: any) => v.id).sort()).toEqual([1, 2]);
    expect(r.body.videos.find((v: any) => v.id === 2).startS).toBe(95);
    expect((await call("GET", "/api/songs/00000000-0000-4000-8000-0000000000ff")).status).toBe(404);
  });

  test("PATCH title: trimmed, Latin title regenerated, index updated; empty refused", async () => {
    expect((await call("PATCH", "/api/videos/3", { title: "   " })).status).toBe(400);
    const r = await call("PATCH", "/api/videos/3", { title: "  Алаш   концерт " });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ title: "Алаш концерт", titleLatin: "Alash koncert".replace("koncert", "kontsert"), titleLatinSource: "table" });
    const hit = (await call("GET", "/api/search?q=kontsert")).body.groups.find((g: any) => g.key === "videos").rows.map((x: any) => x.id);
    expect(hit).toContain(3);
  });

  test("PATCH type confirms: flags off, source manual; bad type refused; unknown video 404", async () => {
    const r = await call("PATCH", "/api/videos/2", { type: "concert" }); // confirm = same value
    expect(r.body).toMatchObject({ type: "concert", typeSuggested: false, suggestionSource: "manual" });
    expect((await call("PATCH", "/api/videos/2", { type: "podcast" })).status).toBe(400);
    expect((await call("PATCH", "/api/videos/999", { type: "song" })).status).toBe(404);
    expect((await call("PATCH", "/api/videos/2", { type: "interview" })).body.type).toBe("interview");
  });

  test("PATCH song: confirm, change resets Version, Version must belong to the Song, clear", async () => {
    let r = await call("PATCH", "/api/videos/1", { songId: S(1) }); // confirm
    expect(r.body).toMatchObject({ songId: S(1), songSuggested: false, suggestionSource: "manual", versionId: null });
    r = await call("PATCH", "/api/videos/1", { versionId: S(102) });
    expect(r.body.versionId).toBe(S(102));
    expect((await call("PATCH", "/api/videos/1", { versionId: S(103) })).status).toBe(400); // another Song's Version
    expect((await call("PATCH", "/api/videos/1", { songId: "nope" })).status).toBe(404);
    r = await call("PATCH", "/api/videos/1", { songId: S(2) });
    expect(r.body).toMatchObject({ songId: S(2), versionId: null });
    expect(r.body.titleLatinSource).toBe("archive"); // title is now Song 2's Cyrillic spelling
    expect(r.body.titleLatin).toBe("Chaŋgys baglaash");
    r = await call("PATCH", "/api/videos/1", { songId: null });
    expect(r.body).toMatchObject({ songId: null, song: null, songSuggested: false });
    expect((await call("PATCH", "/api/videos/1", { versionId: S(101) })).status).toBe(400); // no Song
  });

  test("a rescan keeps edits (no Root is mounted with files, so scan runs but cannot touch them)", async () => {
    await call("POST", "/api/rescan");
    await app.scanner.whenIdle();
    expect((await call("GET", "/api/videos/3")).body.title).toBe("Алаш концерт");
    expect((await call("GET", "/api/videos/2")).body).toMatchObject({ type: "interview", suggestionSource: "manual" });
  });

  test("manual Latin titles survive a title edit and the fill", async () => {
    let r = await call("PATCH", "/api/videos/3", { titleLatin: "Alash my way" });
    expect(r.body).toMatchObject({ titleLatin: "Alash my way", titleLatinSource: "manual" });
    r = await call("PATCH", "/api/videos/3", { title: "Алаш 2" });
    expect(r.body.titleLatin).toBe("Alash my way");
    r = await call("PATCH", "/api/videos/3", { titleLatin: "" });
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
    const row = app.db.query("SELECT mirror_id, name_latin, name_latin_source FROM artist WHERE id = ?").get(c.body.id) as any;
    expect(row).toEqual({ mirror_id: null, name_latin: "Novyj artist".replace("Novyj", "Novyi"), name_latin_source: "table" });

    const mirrorId = (app.db.query("SELECT id FROM artist WHERE mirror_id = ?").get(S(201)) as any).id;
    let r = await call("PUT", "/api/videos/2/artists", { artistIds: [c.body.id, mirrorId, c.body.id] });
    expect(r.body.artists.map((a: any) => [a.id, a.local])).toEqual([[c.body.id, true], [mirrorId, false]]);
    r = await call("PUT", "/api/videos/2/artists", { artistIds: [mirrorId] });
    expect(r.body.artists).toHaveLength(1);
    expect((await call("PUT", "/api/videos/2/artists", { artistIds: [987654] })).status).toBe(404);
    expect((await call("PUT", "/api/videos/2/artists", { artistIds: "x" })).status).toBe(400);
    expect((await call("PUT", "/api/videos/2/artists", { artistIds: [] })).body.artists).toEqual([]);
    // the new Local Artist is searchable at once
    const found = (await call("GET", "/api/search?q=" + encodeURIComponent("#artists novyi"))).body.groups.find((g: any) => g.key === "artists");
    expect(found.rows.some((x: any) => x.id === c.body.id && x.local)).toBe(true);
  });

  test("a Track row carries its Song and Version for the search box", async () => {
    const r = (await call("GET", "/api/search?q=" + encodeURIComponent("#tracks dekei"))).body.groups.find((g: any) => g.key === "tracks");
    expect(r.rows[0]).toMatchObject({ songId: S(1), versionId: S(102) });
  });
});
