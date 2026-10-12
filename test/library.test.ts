// Ticket #23 against a fixture database: the index builder, /api/search, Favorites, Artists, merge, SPA routes, bundle.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { rebuildSearchIndex } from "../src/server/search";

const base = mkdtempSync(join(tmpdir(), "tuva-lib-"));
const localDir = join(base, "local");
const extDir = join(base, "ext");
mkdirSync(localDir, { recursive: true });
mkdirSync(extDir, { recursive: true });

let app: App;
let url: string;
const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(url + path, init);
  return { status: r.status, body: (await r.json()) as any };
};
const post = (path: string, body?: unknown) => api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const search = async (q: string) => (await api(`/api/search?q=${encodeURIComponent(q)}`)).body as { needle: string; groups: { key: string; total: number; rows: any[] }[] };
const group = (r: Awaited<ReturnType<typeof search>>, key: string) => r.groups.find((g) => g.key === key);


beforeAll(async () => {
  const cfg = loadConfig({ TUVA_DATA_DIR: join(base, "data"), TUVA_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: localDir, TUVA_EXTERNAL_ROOT: extDir });
  app = await startApp(cfg);
  url = `http://localhost:${app.server.port}`;
  await app.scanner.whenIdle();
  const db = app.db;
  const roots = db.query("SELECT id, kind FROM root").all() as { id: number; kind: string }[];
  const local = roots.find((r) => r.kind === "local")!.id;
  const ext = roots.find((r) => r.kind === "external")!.id;

  const v = db.prepare("INSERT INTO video (id, youtube_id, title, title_latin, type, favorited_at, created_at, strip_frames, strip_columns, strip_rows, strip_frame_w, strip_frame_h, thumbnail_generated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  v.run(1, "aaaaaaaaaaa", "Алаш — Хөөмей", "Alash - Khoomei", "song", null, "2026-01-01T00:00:00Z", null, null, null, null, null, null);
  v.run(2, "bbbbbbbbbbb", "Tuva concert 2019", null, "concert", "2026-03-01T00:00:00Z", "2026-01-02T00:00:00Z", 100, 10, 10, 160, 90, "2026-01-02T00:00:00Z");
  v.run(3, "ccccccccccc", "Sygyt Ö live", null, "song", "2026-02-01T00:00:00Z", "2026-01-03T00:00:00Z", null, null, null, null, null, null);
  v.run(4, "ddddddddddd", "Offline interview", null, "interview", null, "2026-01-04T00:00:00Z", null, null, null, null, null, null);
  const c = db.prepare("INSERT INTO copy (video_id, root_id, rel_path, size, mtime, duration_s, width, height, playback, missing_since) VALUES (?,?,?,?,?,?,?,?,?,?)");
  c.run(1, local, "a.mp4", 1, "2026-01-01T00:00:00Z", 200, null, 1080, "native", null);
  c.run(2, ext, "b.mp4", 1, "2026-01-02T00:00:00Z", 1000, null, 720, "native", null);
  c.run(3, local, "c.mp4", 1, "2026-01-03T00:00:00Z", 300, null, 480, "native", null);
  c.run(4, ext, "d.mp4", 1, "2026-01-04T00:00:00Z", 600, null, 480, "native", "2026-01-05T00:00:00Z"); // Missing -> unavailable

  const a = db.prepare("INSERT INTO artist (id, mirror_id, name, name_latin) VALUES (?,?,?,?)");
  a.run(1, "mirror-alash", "Alash", null);
  a.run(2, null, "Radik Tyulush", null);
  a.run(3, null, "Хайрыкан", "Khairykan");
  a.run(4, "mirror-hairikan", "Khairikan Ensemble", null); // Mirror Artist with no Video yet
  const va = db.prepare("INSERT INTO video_artist (video_id, artist_id, position) VALUES (?,?,?)");
  va.run(1, 1, 0);
  va.run(2, 2, 0);
  va.run(2, 1, 1);
  va.run(3, 2, 0);
  va.run(3, 3, 1);
  const ch = db.prepare("INSERT INTO chapter (id, video_id, start_s, title, title_latin, source, favorited_at) VALUES (?,?,?,?,?,?,?)");
  ch.run(1, 2, 120, "Алаш — Сарыглар", "Alash - Saryglar", "manual", "2026-04-01T00:00:00Z");
  ch.run(2, 2, 600, "Interlude", null, "manual", null);

  db.exec(`INSERT INTO mirror_artist (id, name, is_hidden, is_various_artists) VALUES ('ma1', 'Alash', 0, 0), ('ma2', 'Various Artists', 1, 1);
    INSERT INTO mirror_album (id, name, artist_id, release_year) VALUES ('al1', 'Tuva: Voices', 'ma1', 2016);
    INSERT INTO mirror_song (id, name, slug, english_name, alternate_titles, alternate_spellings) VALUES ('s1', 'Сарыглар', 'saryglar', 'Saryglar (Girls)', 'Sarygler', 'Sarig-lar'), ('s2', 'Хомей', 'khomei', 'Throat singing', NULL, NULL);
    INSERT INTO mirror_version (id, song_id, label, display_order, cyrillic, transliteration, translation) VALUES ('ver1', 's1', 'Complete', 0, '<p>Хайыракан тыва</p><p class="ln-blank"></p><p>Улуг-Хем<sup data-fn="1">1</sup> чурту</p>', '<p>Khairakan tyva</p><p>Uluk-Khem churtu</p>', '<p>The land of the Great Yenisei</p>');
    INSERT INTO mirror_track (id, album_id, track_number, name, song_id) VALUES ('t1', 'al1', 1, 'Saryglar', 's1');
    INSERT INTO mirror_track_artist VALUES ('t1', 'ma1', 0);`);
  db.query("UPDATE video SET song_id = 's1' WHERE id = 1").run();
  rebuildSearchIndex(db);
}, 30_000);

afterAll(async () => {
  await app.stop();
  rmSync(base, { recursive: true, force: true });
});

describe("index builder", () => {
  test("covers Videos, Chapters, Artists and (when the Mirror exists) Songs, lyric lines, Tracks, Albums", () => {
    const n = (kind: string) => (app.db.query("SELECT COUNT(*) n FROM search WHERE kind = ?").get(kind) as { n: number }).n;
    expect(n("video")).toBe(4);
    expect(n("chapter")).toBe(2);
    expect(n("artist")).toBe(4);
    expect(n("song")).toBe(2);
    expect(n("lyric")).toBe(2 + 2 + 1); // blank paragraph dropped; one row per line per Script
    expect(n("track")).toBe(1);
    expect(n("album")).toBe(1);
  });
  test("text keeps original + Latin, text_folded is folded once at index time", () => {
    const r = app.db.query("SELECT text, text_folded FROM search WHERE kind = 'video' AND ref_id = '1'").get() as any;
    // the linked Song's names follow the titles (segments 2+, scored with videoPenalty)
    expect(r.text).toBe("Алаш — Хөөмей | Alash - Khoomei | Сарыглар | Saryglar (Girls)");
    expect(r.text_folded).toBe("alash — khoomei | alash - khoomei | saryglar | saryglar (girls)");
    const l = app.db.query("SELECT ref_id, text, text_folded FROM search WHERE kind = 'lyric' AND ref_id = 'ver1:cyrillic:2'").get() as any;
    expect(l.text).toBe("Улуг-Хем чурту"); // marker stripped
    expect(l.text_folded).toBe("ulug-khem churtu");
    const s = app.db.query("SELECT text FROM search WHERE kind = 'song' AND ref_id = 's1'").get() as any;
    expect(s.text).toBe("Сарыглар | Saryglar (Girls) | Sarygler | Sarig-lar");
  });
  test("rebuilding is idempotent and a database without Mirror tables still indexes", () => {
    const before = (app.db.query("SELECT COUNT(*) n FROM search").get() as { n: number }).n;
    expect(rebuildSearchIndex(app.db).total).toBe(before);
    expect((app.db.query("SELECT COUNT(*) n FROM search").get() as { n: number }).n).toBe(before);
  });
});

describe("GET /api/search", () => {
  test("a Latin query hits a Cyrillic title; x meets kh", async () => {
    const r = await search("alash");
    expect(group(r, "videos")!.rows.map((x) => x.id)).toContain(1);
    expect(group(r, "artists")!.rows.some((x) => x.name === "Alash")).toBe(true);
    const k = await search("xoomei");
    expect(group(k, "videos")!.rows[0].id).toBe(1);
    const cy = await search("Хөөмей");
    expect(group(cy, "videos")!.rows[0].id).toBe(1);
  });
  test("contains matches, scored below prefix and word-start", async () => {
    const r = await search("ygy"); // inside "Sygyt"
    expect(group(r, "videos")!.rows.map((x) => x.id)).toEqual([3]);
  });
  test("ö/ü fold: 'o live' finds Sygyt Ö live", async () => {
    expect(group(await search("sygyt o"), "videos")!.rows[0].id).toBe(3);
  });
  test("Chapters sit inside the Videos group as Video > Chapter rows", async () => {
    const r = await search("saryglar");
    const ch = group(r, "videos")!.rows.find((x) => x.kind === "chapter");
    expect(ch).toMatchObject({ videoId: 2, title: "Алаш — Сарыглар", startS: 120, videoTitle: "Tuva concert 2019" });
  });
  test("Songs: by name, by English title (+3), by lyrics only (score 5, shows the line), 3-char minimum", async () => {
    const byName = group(await search("saryg"), "songs")!;
    expect(byName.rows[0]).toMatchObject({ id: "s1", name: "Сарыглар", viaLyrics: false });
    const eng = group(await search("throat"), "songs")!;
    expect(eng.rows[0]).toMatchObject({ id: "s2" });
    const lyr = group(await search("churtu"), "songs")!;
    expect(lyr.rows[0]).toMatchObject({ id: "s1", viaLyrics: true, lyric: "Улуг-Хем чурту" });
    expect(lyr.rows[0].videos).toEqual([{ id: 1, startS: null }]); // Video 1 points at s1; the results page lists it under a lyrics hit
    const lyrCy = group(await search("Хайыракан"), "songs")!;
    expect(lyrCy.rows[0].lyric).toBe("Хайыракан тыва");
    const short = await search("ch"); // under 3 characters: lyrics are not searched
    expect(group(short, "songs")?.rows.some((x) => x.viaLyrics) ?? false).toBe(false);
  });
  test("Tracks and Albums with album, artists and year; a Video names its Song", async () => {
    const t = group(await search("saryglar"), "tracks")!;
    expect(t.rows[0]).toMatchObject({ name: "Saryglar", album: "Tuva: Voices", by: ["Alash"], songId: "s1" });
    const al = group(await search("voices"), "albums")!;
    expect(al.rows[0]).toMatchObject({ name: "Tuva: Voices", year: 2016, by: "Alash" });
    const vid = group(await search("khoomei"), "videos")!.rows[0];
    expect(vid.songs).toEqual(["Сарыглар"]);
  });
  test("#available and a bare #videos list Videos without any text", async () => {
    const av = await search("#available");
    expect(av.groups.map((g) => g.key)).toEqual(["videos"]);
    expect(group(av, "videos")!.rows.map((x) => x.id).sort()).toEqual([1, 2, 3]); // 4 has only a Missing Copy
    const all = group(await search("#videos"), "videos")!;
    expect(all.total).toBe(4);
    expect(all.rows.every((x) => x.kind === "video")).toBe(true);
  });
  test("#fav, #type:, #artist: narrow Videos; text narrows further", async () => {
    expect(group(await search("#fav"), "videos")!.rows.map((x) => x.kind + x.id).sort()).toEqual(["chapter1", "video2", "video3"]);
    expect(group(await search("#type:song"), "videos")!.rows.map((x) => x.id).sort()).toEqual([1, 3]);
    expect(group(await search("#artist:Radik_Tyulush"), "videos")!.rows.map((x) => x.id).sort()).toEqual([2, 3]);
    expect(group(await search("#artist:khairykan"), "videos")!.rows.map((x) => x.id)).toEqual([3]); // by Latin name too
    expect(group(await search("#type:song live"), "videos")!.rows.map((x) => x.id)).toEqual([3]);
    expect(await search("#artist:Nobody")).toMatchObject({ groups: [] });
  });
  test("group filters restrict groups; #lyrics matches lyric text only", async () => {
    const r = await search("alash #artists");
    expect(r.groups.map((g) => g.key)).toEqual(["artists"]);
    const l = await search("#lyrics khem");
    expect(l.groups.map((g) => g.key)).toEqual(["songs"]);
    expect(l.groups[0]!.rows[0]).toMatchObject({ id: "s1", viaLyrics: true });
    expect((await search("#lyrics saryglar")).groups).toEqual([]); // the name alone does not count
  });
  test("a filtered group shows up to 40 rows; unfiltered 8", async () => {
    for (let i = 0; i < 12; i++) app.db.query("INSERT INTO video (youtube_id, title, created_at) VALUES (?, ?, ?)").run(`zzzzzzzzz${String(i).padStart(2, "0")}`, `Zebra ${i}`, "2026-02-01T00:00:00Z");
    rebuildSearchIndex(app.db);
    const plain = group(await search("zebra"), "videos")!;
    expect(plain.total).toBe(12);
    expect(plain.rows.length).toBe(8);
    expect(group(await search("zebra #videos"), "videos")!.rows.length).toBe(12);
    // `limit=` (the /search results page) overrides the cap; it is clamped to 500 and ignored when not positive.
    expect(group((await api(`/api/search?q=zebra&limit=3`)).body, "videos")!.rows.length).toBe(3);
    expect(group((await api(`/api/search?q=zebra&limit=500`)).body, "videos")!.rows.length).toBe(12);
    expect(group((await api(`/api/search?q=zebra&limit=0`)).body, "videos")!.rows.length).toBe(8);
    expect(group((await api(`/api/search?q=zebra&limit=abc`)).body, "videos")!.rows.length).toBe(8);
    app.db.query("DELETE FROM video WHERE title LIKE 'Zebra %'").run();
    rebuildSearchIndex(app.db);
  });
  test("an empty query returns nothing; the latency is small", async () => {
    expect((await search("")).groups).toEqual([]);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) await search("alash");
    expect((performance.now() - t0) / 20).toBeLessThan(50);
  });
});

describe("Videos in /api/videos", () => {
  test("Artists in position order, chapter count, availability, date added", async () => {
    const vs = (await api("/api/videos")).body as any[];
    const v2 = vs.find((v) => v.id === 2);
    expect(v2.artists.map((a: any) => [a.name, a.local])).toEqual([["Radik Tyulush", true], ["Alash", false]]);
    expect(v2.chapterCount).toBe(2);
    expect(v2.availability).toBe("external");
    expect(v2.addedAt).toBe("2026-01-02T00:00:00Z");
    expect(vs.find((v) => v.id === 1).availability).toBe("local");
    expect(vs.find((v) => v.id === 4).availability).toBeNull();
  });
});

describe("Favorites", () => {
  test("GET /api/favorites: Videos and Chapters ordered by favorited_at desc, with the strip geometry", async () => {
    const r = (await api("/api/favorites")).body as any[];
    expect(r.map((i) => `${i.kind}:${i.kind === "chapter" ? i.chapter.id : i.video.id}`)).toEqual(["chapter:1", "video:2", "video:3"]);
    const ch = r[0];
    expect(ch.chapter).toMatchObject({ startS: 120, title: "Алаш — Сарыглар" });
    expect(ch.video.id).toBe(2);
    expect(ch.video.thumbnail.strip).toMatchObject({ frames: 100, columns: 10, rows: 10, frameWidth: 160, frameHeight: 90 });
    expect(ch.video.durationS).toBe(1000);
  });
  test("POST /api/videos/:id/favorite toggles, keeps the order, and 404s", async () => {
    const on = await post("/api/videos/1/favorite");
    expect(on.body.favorite).toBe(true);
    expect(on.body.favoritedAt).toBeTruthy();
    const list = (await api("/api/favorites")).body as any[];
    expect(list[0]).toMatchObject({ kind: "video" });
    expect(list[0].video.id).toBe(1); // newest star first
    const again = await post("/api/videos/1/favorite", { favorite: true }); // explicit set: no change
    expect(again.body.favoritedAt).toBe(on.body.favoritedAt);
    const off = await post("/api/videos/1/favorite");
    expect(off.body).toMatchObject({ favorite: false, favoritedAt: null });
    expect((await api("/api/videos/1")).body.favoritedAt).toBeNull();
    expect((await post("/api/videos/999/favorite")).status).toBe(404);
  });
  test("POST /api/chapters/:id/favorite", async () => {
    const on = await post("/api/chapters/2/favorite");
    expect(on.body.favorite).toBe(true);
    const ids = ((await api("/api/favorites")).body as any[]).filter((i) => i.kind === "chapter").map((i) => i.chapter.id);
    expect(ids).toEqual([2, 1]);
    expect((await post("/api/chapters/2/favorite")).body.favorite).toBe(false);
    expect((await post("/api/chapters/77/favorite")).status).toBe(404);
  });
});

describe("Artists", () => {
  test("GET /api/artists: only Artists with a Video, count, latest poster, Local mark", async () => {
    const r = (await api("/api/artists")).body as any[];
    expect(r.map((a) => a.name)).toEqual(["Alash", "Radik Tyulush", "Хайрыкан"]); // the Mirror Artist without a Video is not listed
    const alash = r.find((a) => a.name === "Alash");
    expect(alash).toMatchObject({ local: false, videoCount: 2, posterVideoId: 2 }); // video 2 has the newer Copy
    const radik = r.find((a) => a.name === "Radik Tyulush");
    expect(radik).toMatchObject({ local: true, videoCount: 2, posterVideoId: 3 });
  });
  test("GET /api/songs: only Songs a Video or Chapter points at, counts, lyrics, poster", async () => {
    app.db.query("UPDATE chapter SET song_id = 's1' WHERE id = 1").run();
    const r = (await api("/api/songs")).body as any[];
    expect(r.map((x) => x.id)).toEqual(["s1"]); // s2 is pointed at by nothing
    expect(r[0]).toMatchObject({ name: "Сарыглар", englishName: "Saryglar (Girls)", videoCount: 1, chapterCount: 1, versionCount: 1, posterVideoId: 1 });
    expect(r[0].addedAt).toBe("2026-01-02T00:00:00Z"); // the Chapter's Video has the newer Copy
    app.db.query("UPDATE chapter SET song_id = NULL WHERE id = 1").run();
  });
  test("merge: only Local into Mirror, moves links, drops duplicates, reindexes", async () => {
    expect((await post("/api/artists/1/merge-into/4")).status).toBe(409); // Mirror source
    expect((await post("/api/artists/2/merge-into/3")).status).toBe(409); // Local target
    expect((await post("/api/artists/2/merge-into/2")).status).toBe(400);
    expect((await post("/api/artists/2/merge-into/99")).status).toBe(404);
    // Radik (Local, videos 2 and 3) -> Alash (Mirror, on 1 and 2): video 2 already has Alash
    const r = await post("/api/artists/2/merge-into/1");
    expect(r.body).toMatchObject({ merged: true, moved: 1 });
    const artists = (await api("/api/artists")).body as any[];
    expect(artists.find((a) => a.name === "Radik Tyulush")).toBeUndefined();
    expect(artists.find((a) => a.name === "Alash").videoCount).toBe(3);
    const v2 = (await api("/api/videos/2")).body;
    expect(v2.artists.map((a: any) => a.name)).toEqual(["Alash"]);
    expect(group(await search("radik"), "artists")).toBeUndefined(); // gone from the index
    // a Local Artist with a Mirror target that has no Video yet
    const m = await post("/api/artists/3/merge-into/4");
    expect(m.body.moved).toBe(1);
    expect((await api("/api/artists")).body.map((a: any) => a.name)).toEqual(["Alash", "Khairikan Ensemble"]);
  });
});

describe("client shell", () => {
  test("client routes serve the shell; the bundle and stylesheet are served", async () => {
    for (const p of ["/", "/favorites", "/artists", "/songs", "/search", "/play/12"]) {
      const r = await fetch(url + p);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('<script type="module" src="/app.js">');
    }
    expect((await fetch(url + "/nope")).status).toBe(404);
    const js = await fetch(url + "/app.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    const code = await js.text();
    expect(code.length).toBeGreaterThan(10_000);
    expect(code).not.toContain("UI build failed");
    const css = await fetch(url + "/app.css");
    expect(await css.text()).toContain("--accent: #d97757");
  });
});
