// Ticket #26: the timestamp parser, block selection, Performance merge, the Song matcher, the re-run and tombstone
// rules, the time-field parser and nudge arithmetic, and the Chapter endpoints.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { applyRerunRules, mergePerformances, selectBlock, type Candidate } from "../src/server/chapters/blocks";
import { eligibleForFetch } from "../src/server/chapters/eligible";
import { suggestChapters } from "../src/server/chapters/suggest";
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/server/db";
import { runImport } from "../src/server/import";
import { importMirror } from "../src/server/mirror";
import { rebuildSearchIndex } from "../src/server/search";
import { foldForMatch, jaroWinkler, matchSong, prepareSongs } from "../src/shared/songMatch";
import { clampStart, formatStart, nudgeStart, parseTimeField, parseTimestampBlock } from "../src/shared/timestamps";

const FIXTURE = join(import.meta.dir, "fixtures", "backup");
const YT = join(import.meta.dir, "fixtures", "yt");
const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ---------------------------------------------------------------------------------------------------------------
describe("timestamp parser (research #5 section 5)", () => {
  const p = (text: string, dur: number | null = null) => parseTimestampBlock(text, dur).map((e) => [e.startS, e.title]);
  test("the research test table", () => {
    const ok = (line: string) => p(`0:00 Intro\n${line}\n99:00 Last`)[1];
    expect(ok("12:34 - Song Name")).toEqual([754, "Song Name"]);
    expect(ok("1:02:33 – Чашпы-Хем")).toEqual([3753, "Чашпы-Хем"]);
    expect(ok("Kongurei | 4:05")).toEqual([245, "Kongurei"]);
    expect(ok("Kongurei 4:05")).toEqual([245, "Kongurei"]);
    expect(ok("[00:12] Ezir-Kara")).toEqual([12, "Ezir-Kara"]);
    expect(ok("3. 10:00 Song")).toEqual([600, "Song"]);
    expect(p("0:00 - 4:12 Song A\n5:00 B\n6:00 C")[0]).toEqual([0, "Song A"]);
    expect(ok("7:50ish - Ko'sh Oi")).toEqual([470, "Ko'sh Oi"]);
    expect(p("00:00 01. Aidym tider\n1:00 02. Two\n2:00 03. Three")[0]).toEqual([0, "Aidym tider"]);
    expect(ok("00:00:19 - Prayer, Oske Cherde")).toEqual([19, "Prayer, Oske Cherde"]);
  });
  test("h:mm:ss entries sort after m:ss ones", () => {
    expect(p("0:00 A\n45:10 B\n1:02:33 C\n1:30:00 D")).toEqual([[0, "A"], [2710, "B"], [3753, "C"], [5400, "D"]]);
  });
  test("bullets and dashes in front of the timestamp are not part of the line", () => {
    expect(p("- 0:10 One\n• 2:00 Two\n* 5:00 Three\n– 9:00 Four")).toEqual([[10, "One"], [120, "Two"], [300, "Three"], [540, "Four"]]);
  });
  test("a bad time token is ignored and a header or prose line is skipped", () => {
    expect(p("Timestamps\n0:00 A\n05:61 bad\n1:00 B\nНачало 6 июля в 18:00 в зале\n2:00 C")).toEqual([[0, "A"], [60, "B"], [120, "C"]]);
  });
  test("non-ascending noise: the longest ascending run wins, trailing notes drop out", () => {
    const text = "0:00 A\n3:00 B\n6:00 C\n9:00 D\n2:00 stray\n28:17 - Rare occurrence of something";
    expect(p(text).map((x) => x[1])).toEqual(["A", "B", "C", "D"]); // the 2:00 line starts a run of 2: [2:00, 28:17]
    expect(parseTimestampBlock("0:00 A\n3:00 B\n6:00 C\n9:00 D\n2:00 stray\n3:30 x", null).map((e) => e.title)).toEqual(["A", "B", "C", "D"]);
  });
  test("entries past the duration are dropped before the run is cut", () => {
    expect(p("0:00 A\n1:00 B\n2:00 C\n99:00 D", 600)).toEqual([[0, "A"], [60, "B"], [120, "C"]]);
  });
  test("fewer than 3 entries is no block; yt-dlp's single '- music begins at 3:07' line is rejected", () => {
    expect(p("0:00 A\n1:00 B")).toEqual([]);
    expect(p("Great show\n- music begins at 3:07")).toEqual([]);
    expect(p("- music begins at 3:07\n5:00 a\n6:00 b")).toEqual([[187, "music begins at"], [300, "a"], [360, "b"]]);
  });
  test("two timestamps in one title split into two entries; a one-line list splits on the timestamps", () => {
    expect(p("0:00 Intro\n5:36 Mörgül + 8:20 Öske Cherde\n12:00 End").map((x) => x[1])).toEqual(["Intro", "Mörgül", "Öske Cherde", "End"]);
    expect(p("0:00 A 3:10 B 7:45 C")).toEqual([[0, "A"], [190, "B"], [465, "C"]]);
  });
  test("an untitled entry is kept with an empty title", () => {
    expect(p("0:10\n0:20\n0:30")).toEqual([[10, ""], [20, ""], [30, ""]]);
  });
});

describe("time field and nudge arithmetic", () => {
  test("m:ss, h:mm:ss and bare seconds", () => {
    expect(parseTimeField("1:05")).toBe(65);
    expect(parseTimeField(" 12:34 ")).toBe(754);
    expect(parseTimeField("1:02:03")).toBe(3723);
    expect(parseTimeField("95")).toBe(95);
    expect(parseTimeField("95.5")).toBe(95.5);
    expect(parseTimeField("0:07.25")).toBe(7.25);
  });
  test("refuses garbage, seconds >= 60, minutes >= 60 with hours", () => {
    for (const bad of ["", "abc", "1:75", "1:60", "1:61:00", "1:2:3:4", "-5", "1,5", "12:"]) expect(parseTimeField(bad)).toBeNull();
  });
  test("formatStart round-trips whole seconds and shows a sub-second tail", () => {
    expect(formatStart(65)).toBe("1:05");
    expect(formatStart(3723)).toBe("1:02:03");
    expect(formatStart(7.001)).toBe("0:07.001");
    expect(parseTimeField(formatStart(754))).toBe(754);
  });
  test("nudge is +/- 1 s, millisecond-rounded, clamped to [0, duration]", () => {
    expect(nudgeStart(10, 1)).toBe(11);
    expect(nudgeStart(10.0004, -1)).toBe(9);
    expect(nudgeStart(0.4, -1)).toBe(0);
    expect(nudgeStart(99.5, 1, 100)).toBe(100);
    expect(clampStart(12.3456, null)).toBe(12.346);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("block selection", () => {
  const c = (text: string, o: Record<string, unknown> = {}) => ({ id: String(Math.random()), text, ...o });
  const BLOCK3 = "0:00 A\n3:00 B\n6:00 C";
  const BLOCK4 = "0:00 A\n3:00 B\n6:00 C\n9:00 D";
  test("a description block wins and the comments are ignored", () => {
    const b = selectBlock({ description: BLOCK3, comments: [c(BLOCK4, { like_count: 999 })] }, null)!;
    expect(b.source).toBe("description");
    expect(b.entries).toHaveLength(3);
  });
  test("no description block: pinned or uploader first, then likes, then entry count", () => {
    const pinned = c(BLOCK3, { is_pinned: true, like_count: 1, id: "pinned" });
    const liked = c(BLOCK3, { like_count: 500, id: "liked" });
    const long = c(BLOCK4, { like_count: 500, id: "long" });
    const uploader = c(BLOCK3, { author_is_uploader: true, like_count: 0, id: "up" });
    expect(selectBlock({ description: "nothing here", comments: [liked, pinned] }, null)!.comment!.id).toBe("pinned");
    expect(selectBlock({ comments: [pinned, uploader] }, null)!.comment!.id).toBe("pinned"); // same class: more likes
    expect(selectBlock({ comments: [liked, long] }, null)!.comment!.id).toBe("long"); // same likes: more entries
    expect(selectBlock({ comments: [c(BLOCK3, { like_count: 2, id: "a" }), liked] }, null)!.comment!.id).toBe("liked");
    expect(selectBlock({ comments: [liked, uploader] }, null)!.comment!.id).toBe("up");
  });
  test("comments without a block, and no comments at all, give nothing", () => {
    expect(selectBlock({ description: "", comments: [c("great"), c("0:00 only one")] }, null)).toBeNull();
    expect(selectBlock({}, null)).toBeNull();
  });
  test("the Video's duration is applied to every candidate block", () => {
    expect(selectBlock({ comments: [c("0:00 A\n1:00 B\n2:00 C\n50:00 D\n51:00 E")] }, 600)!.entries).toHaveLength(3);
  });
});

describe("Performance merge (+-15 s)", () => {
  const text = (...t: [number, string][]) => ({ source: "comment" as const, entries: t.map(([startS, title]) => ({ startS, title })) });
  const perf = (songId: string, startS: number, songName = songId) => ({ songId, startS, songName });
  test("a Performance within 15 s merges into the text entry: text supplies time and title, the Performance the Song", () => {
    const out = mergePerformances(text([100, "Typed title"], [500, "Other"]), [perf("s1", 112, "Song One")]);
    expect(out).toEqual([
      { startS: 100, title: "Typed title", songId: "s1", source: "comment", songFrom: "performance" },
      { startS: 500, title: "Other", songId: null, source: "comment", songFrom: null },
    ]);
  });
  test("16 s away is not merged: it becomes its own Chapter titled with the Song's name", () => {
    const out = mergePerformances(text([100, "Typed"]), [perf("s1", 116, "Song One")]);
    expect(out.map((c) => [c.startS, c.title, c.source, c.songId])).toEqual([[100, "Typed", "comment", null], [116, "Song One", "performance", "s1"]]);
  });
  test("exactly 15 s merges; an untitled text entry takes the Song's name", () => {
    const out = mergePerformances(text([100, ""]), [perf("s1", 115, "Song One")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startS: 100, title: "Song One", songId: "s1", source: "comment" });
  });
  test("each text entry takes one Performance (the nearest); the other stands alone; a repeated Song at one offset counts once", () => {
    const out = mergePerformances(text([100, "A"]), [perf("s1", 108), perf("s2", 101), perf("s2", 101)]);
    expect(out.map((c) => [c.startS, c.songId, c.source])).toEqual([[100, "s2", "comment"], [108, "s1", "performance"]]);
  });
  test("no text block: Performances alone", () => {
    expect(mergePerformances(null, [perf("s1", 30), perf("s2", 10)]).map((c) => c.startS)).toEqual([10, 30]);
  });
});

describe("re-run rules (pure)", () => {
  const cand = (startS: number, source: Candidate["source"] = "comment"): Candidate => ({ startS, title: "t", songId: null, source, songFrom: null });
  test("within 10 s of a confirmed or manual Chapter is dropped, 11 s is kept", () => {
    const r = applyRerunRules([cand(100), cand(110), cand(111), cand(89), cand(88), cand(95)], [100], []);
    expect(r.keep.map((c) => c.startS)).toEqual([88, 89, 111]); // 11 s and 12 s away are kept
    expect(r.nearKept.map((c) => c.startS)).toEqual([95, 100, 110]);
  });
  test("a tombstone blocks the same source within 10 s only", () => {
    const r = applyRerunRules([cand(205), cand(205, "description"), cand(230)], [], [{ source: "comment", startS: 200 }]);
    expect(r.keep.map((c) => [c.startS, c.source])).toEqual([[205, "description"], [230, "comment"]]);
    expect(r.tombstoned).toHaveLength(1);
  });
  test("two candidates at one start collide: the first stays", () => {
    const r = applyRerunRules([cand(50), cand(50, "performance")], [], []);
    expect(r.keep).toHaveLength(1);
    expect(r.collided).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Song matcher", () => {
  const song = (id: string, name: string, extra: Record<string, string | null> = {}) => ({ id, name, english_name: null, alternate_titles: null, alternate_spellings: null, ...extra });
  const prep = (...s: ReturnType<typeof song>[]) => prepareSongs(s);

  test("folding: diacritics, ŋ, x/kh, Cyrillic, parentheticals and punctuation", () => {
    expect(foldForMatch("Chaŋgys Baglaash")).toBe("changgys baglaash");
    expect(foldForMatch("Чаңгыс баглааш")).toBe("changgys baglaash");
    expect(foldForMatch("Хоомей (Khoomei style)!")).toBe(foldForMatch("Khoomei"));
    expect(foldForMatch("Xöömej")).toBe("khoomej");
    expect(foldForMatch("Кызыл-Хем, 2:30")).toBe("kyzyl khem 2 30");
    expect(foldForMatch("Aa-shuu, dekei-oo")).toBe("aa shuu dekei oo");
    expect(foldForMatch("Ö's")).toBe("os");
  });
  test("Jaro-Winkler reference values", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.9611, 3);
    expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.8133, 3);
    expect(jaroWinkler("abc", "abc")).toBe(1);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
    expect(jaroWinkler("", "abc")).toBe(0);
  });
  test("a Cyrillic title matches a Latin Song name with ŋ and an alternate spelling", () => {
    const songs = prep(song("a", "Chaŋgys baglaash", { alternate_spellings: "Чаңгыс баглааш" }), song("b", "Totally different"));
    const m = matchSong("Чаңгыс баглааш", songs, songs);
    expect(m).toMatchObject({ songId: "a", tier: "linked", verdict: "hit" });
    expect(m.best!.score).toBe(1);
  });
  test("linked tier accepts at 0.80 where the Mirror-wide tier needs 0.90", () => {
    const target = prep(song("t", "Kargyraa dagyn"));
    const title = "Kar dagyn"; // not an exact name: scores between 0.80 and 0.90
    const sc = jaroWinkler(foldForMatch(title), foldForMatch("Kargyraa dagyn"));
    expect(sc).toBeGreaterThan(0.8);
    expect(sc).toBeLessThan(0.9);
    expect(matchSong(title, target, target).songId).toBe("t"); // linked
    expect(matchSong(title, [], target)).toMatchObject({ songId: null, verdict: "miss" }); // mirror-wide only
    // and a title above 0.90 is accepted Mirror-wide
    expect(matchSong("Kargyraa dagyn", [], target)).toMatchObject({ songId: "t", tier: "mirror" });
  });
  test("below the linked threshold falls through to the Mirror, which can still accept", () => {
    const linked = prep(song("l", "Zzzz"));
    const mirror = prep(song("l", "Zzzz"), song("m", "Ezir-Kara"));
    expect(matchSong("Ezir Kara", linked, mirror)).toMatchObject({ songId: "m", tier: "mirror" });
  });
  test("near-tie: the best leads the runner-up by < 0.05, nothing is attached and the tie is reported", () => {
    const songs = prep(song("a", "Bai-Taiga"), song("b", "Bai-Taigaa"));
    const m = matchSong("Bai Taiga", songs, songs);
    expect(m.verdict).toBe("near-tie");
    expect(m.songId).toBeNull();
    expect(m.nearTie).toBe(true);
    expect(m.best!.score - m.runnerUp!.score).toBeLessThan(0.05);
  });
  test("a Song with several close names is not a tie with itself", () => {
    const songs = prep(song("a", "Bai-Taiga", { alternate_titles: "Bai Taiga, Baj Taiga" }));
    expect(matchSong("Bai Taiga", songs, songs)).toMatchObject({ songId: "a", verdict: "hit" });
  });
  test("an empty or punctuation-only title attaches nothing", () => {
    const songs = prep(song("a", "Bai-Taiga"));
    expect(matchSong("(live) !!!", songs, songs).verdict).toBe("empty");
    expect(matchSong("", songs, songs).songId).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("eligible Videos (fetch)", () => {
  test("concerts first, then Videos over 20 min with an id, then explicit ids; id-less Videos never", () => {
    const rows = [
      { id: 1, youtubeId: "a", type: "song", durationS: 300 },
      { id: 2, youtubeId: "b", type: "other", durationS: 1300 },
      { id: 3, youtubeId: "c", type: "concert", durationS: 100 },
      { id: 4, youtubeId: null, type: "concert", durationS: 9000 },
      { id: 5, youtubeId: "e", type: "song", durationS: 7200 },
      { id: 6, youtubeId: "f", type: "other", durationS: 1200 },
    ];
    expect(eligibleForFetch(rows).map((r) => r.youtubeId)).toEqual(["c", "e", "b"]);
    expect(eligibleForFetch(rows, ["a", "zzz", "c"]).map((r) => r.youtubeId)).toEqual(["c", "e", "b", "a", "zzz"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("suggest step against a library (re-runs, tombstones)", () => {
  const base = mkdtempSync(join(tmpdir(), "tuva-sug-"));
  const cache = join(base, "yt");
  mkdirSync(cache, { recursive: true });
  const db = openDb(":memory:", MIGRATIONS);
  importMirror(db, FIXTURE);
  // Video 1: bbbbbbbbbbb has Performances of Song 1 @95 and Song 2 @3723; Video 2: no info, no Performance with t
  db.exec("INSERT INTO video (id, youtube_id, title, created_at) VALUES (1, 'bbbbbbbbbbb', 'Concert', 'x'), (2, 'aaaaaaaaaaa', 'Plain', 'x'), (3, 'nnnnnnnnnnn', 'NoBlock', 'x')");
  writeFileSync(join(cache, "bbbbbbbbbbb.info.json"), readFileSync(join(YT, "bbbbbbbbbbb.info.json")));
  writeFileSync(join(cache, "nnnnnnnnnnn.info.json"), JSON.stringify({ id: "nnnnnnnnnnn", description: "just words", comments: [{ text: "nice", like_count: 1 }] }));
  const rows = () => db.query("SELECT * FROM chapter WHERE video_id = 1 ORDER BY start_s").all() as any[];
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test("first run: description block, Performance merge, matcher; no Chapter invented at 0:00; every Chapter Suggested", () => {
    const r = suggestChapters(db, { cacheDir: cache });
    const v = r.videos.find((x) => x.videoId === 1)!;
    expect(v.textSource).toBe("description");
    expect(rows().map((c) => [c.start_s, c.title, c.song_id, c.suggested, c.source])).toEqual([
      [90, "Aa-shuu dekei-oo", S(1), 1, "description"], // merged with the Performance at 95 s
      [600, "Bai Taiga (live)", S(4), 1, "description"], // matcher, Mirror-wide
      [1800, "Something nobody has heard of", null, 1, "description"],
      [3720, "Changys baglaash", S(2), 1, "description"], // merged with the Performance at 3723 s
    ]);
    expect(v.match.map((m) => m.verdict)).toEqual(["hit", "miss"]);
    expect(v.hits).toBe(1);
    expect(v.misses).toBe(1);
    expect(r.videos.find((x) => x.videoId === 2)).toBeUndefined(); // nothing to suggest from
    expect(r.noBlockIds).toEqual(["nnnnnnnnnnn"]);
    expect(readFileSync(join(cache, "no-block-ids.txt"), "utf8")).toBe("nnnnnnnnnnn\n");
    // search rows for the new Chapter titles
    expect((db.query("SELECT COUNT(*) n FROM search WHERE kind = 'chapter'").get() as any).n).toBe(4);
  });

  test("dry run writes nothing", () => {
    db.exec("DELETE FROM chapter WHERE video_id = 1");
    const r = suggestChapters(db, { cacheDir: cache, dryRun: true });
    expect(r.totals.chapters).toBeGreaterThan(0);
    expect(rows()).toHaveLength(0);
    suggestChapters(db, { cacheDir: cache });
    expect(rows()).toHaveLength(4);
  });

  test("re-run: confirmed Chapter untouched, rejected one never returns, Suggested ones replaced wholesale", () => {
    const before = rows();
    const confirmed = before.find((c) => c.start_s === 600)!;
    const rejected = before.find((c) => c.start_s === 1800)!;
    const keepSuggested = before.find((c) => c.start_s === 90)!;
    db.query("UPDATE chapter SET suggested = 0 WHERE id = ?").run(confirmed.id);
    Object.assign(confirmed, { suggested: 0 });
    db.query("UPDATE chapter SET favorited_at = 'T' WHERE id = ?").run(keepSuggested.id);
    // reject = tombstone + delete (what the endpoint does)
    db.query("INSERT INTO chapter_rejection (video_id, source, start_s) VALUES (1, ?, ?)").run(rejected.source, rejected.start_s);
    db.query("DELETE FROM chapter WHERE id = ?").run(rejected.id);

    const r = suggestChapters(db, { cacheDir: cache });
    const after = rows();
    expect(after.map((c) => c.start_s)).toEqual([90, 600, 3720]);
    expect(after.find((c) => c.start_s === 600)).toEqual(confirmed); // byte-for-byte untouched, same id
    expect(after.find((c) => c.start_s === 90)!.id).not.toBe(keepSuggested.id); // replaced
    expect(after.find((c) => c.start_s === 90)!.favorited_at).toBe("T"); // a Favorite carries over
    const v = r.videos.find((x) => x.videoId === 1)!;
    expect(v.droppedTombstoned).toBe(1);
    expect(v.droppedNearKept).toBe(1);
    expect(v.replaced).toBe(2);
  });

  test("a tombstone matches the same source only, +-10 s; a manual Chapter near a suggestion drops it", () => {
    db.query("INSERT INTO chapter (video_id, start_s, title, suggested, source) VALUES (1, 3725, 'by hand', 0, 'manual')").run();
    suggestChapters(db, { cacheDir: cache });
    expect(rows().map((c) => c.start_s)).toEqual([90, 600, 3725]); // 3720 is within 10 s of the manual one
    db.query("DELETE FROM chapter WHERE video_id = 1 AND start_s = 3725").run();
    db.query("INSERT INTO chapter_rejection (video_id, source, start_s) VALUES (1, 'comment', 3721)").run(); // other source
    suggestChapters(db, { cacheDir: cache });
    expect(rows().map((c) => c.start_s)).toEqual([90, 600, 3720]);
    db.query("INSERT INTO chapter_rejection (video_id, source, start_s) VALUES (1, 'description', 3715)").run(); // same source, 5 s away
    suggestChapters(db, { cacheDir: cache });
    expect(rows().map((c) => c.start_s)).toEqual([90, 600]);
  });

  test("only[] restricts the run to those Videos (library id or YouTube id)", () => {
    const r = suggestChapters(db, { cacheDir: cache, only: ["nnnnnnnnnnn"], dryRun: true });
    expect(r.videos.map((v) => v.videoId)).toEqual([3]);
    expect(suggestChapters(db, { cacheDir: cache, only: ["1"], dryRun: true }).videos.map((v) => v.videoId)).toEqual([1]);
  });

  test("a Video with Performance offsets and no cached info gets Performance Chapters titled with the Song", () => {
    db.exec("DELETE FROM chapter");
    db.exec("DELETE FROM chapter_rejection");
    rmSync(join(cache, "bbbbbbbbbbb.info.json"));
    suggestChapters(db, { cacheDir: cache });
    expect(rows().map((c) => [c.start_s, c.title, c.song_id, c.source])).toEqual([[95, "Aa-shuu, dekei-oo", S(1), "performance"], [3723, "Chaŋgys baglaash", S(2), "performance"]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Chapter endpoints", () => {
  const base = mkdtempSync(join(tmpdir(), "tuva-chap-"));
  mkdirSync(join(base, "local"), { recursive: true });
  mkdirSync(join(base, "ext"), { recursive: true });
  let app: App;
  let url: string;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(url + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const list = async (v = 1) => (await call("GET", `/api/videos/${v}/chapters`)).body as any[];
  const cnt = async (v = 1) => (await call("GET", `/api/videos/${v}`)).body.chapterCount as number;
  const tombs = () => app.db.query("SELECT source, start_s FROM chapter_rejection WHERE video_id = 1 ORDER BY start_s").all() as any[];
  const suggested = (start: number, title: string, source = "comment") =>
    app.db.query("INSERT INTO chapter (video_id, start_s, title, suggested, source) VALUES (1, ?, ?, 1, ?)").run(start, title, source).lastInsertRowid as number;

  beforeAll(async () => {
    app = await startApp(loadConfig({ TUVA_DATA_DIR: join(base, "data"), TUVA_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: join(base, "local"), TUVA_EXTERNAL_ROOT: join(base, "ext") }));
    url = `http://localhost:${app.server.port}`;
    await app.scanner.requestAll(); // nothing is scanned at startup (spec 3.2)
    await app.scanner.whenIdle();
    app.db.exec("INSERT INTO video (id, youtube_id, title, created_at) VALUES (1, 'bbbbbbbbbbb', 'Concert', 'x'), (2, 'eeeeeeeeeee', 'Other', 'x')");
    await runImport(app.db, FIXTURE);
  }, 30_000);
  afterAll(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  test("empty list, 404 for no such Video", async () => {
    expect(await list()).toEqual([]);
    expect((await call("GET", "/api/videos/99/chapters")).status).toBe(404);
    expect(await cnt()).toBe(0);
  });

  test("POST adds a confirmed manual Chapter (an empty title is allowed); chapterCount follows", async () => {
    const r = await call("POST", "/api/videos/1/chapters", { startS: 30.0004 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ videoId: 1, startS: 30, title: "", suggested: false, source: "manual", songId: null, song: null });
    expect(await cnt()).toBe(1);
    expect((await call("POST", "/api/videos/1/chapters", { startS: -1 })).status).toBe(400);
    expect((await call("POST", "/api/videos/1/chapters", { title: "x" })).status).toBe(400);
    expect((await call("POST", "/api/videos/1/chapters", { startS: 5, songId: "nope" })).status).toBe(404);
  });

  test("UNIQUE (video_id, start_s): a taken start is refused with a message, on add and on edit", async () => {
    const dup = await call("POST", "/api/videos/1/chapters", { startS: 30 });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain("0:30");
    const other = (await call("POST", "/api/videos/1/chapters", { startS: 60, title: "Second" })).body;
    const clash = await call("PATCH", `/api/chapters/${other.id}`, { startS: 30 });
    expect(clash.status).toBe(409);
    expect((await list()).map((c) => c.startS)).toEqual([30, 60]);
    // moving onto its own start is not a clash
    expect((await call("PATCH", `/api/chapters/${other.id}`, { startS: 60 })).status).toBe(200);
  });

  test("PATCH title and start: sorted listing, Latin title filled, search row replaced", async () => {
    const [first] = await list();
    const r = await call("PATCH", `/api/chapters/${first.id}`, { title: "  Чаңгыс   баглааш ", startS: 75 });
    expect(r.body).toMatchObject({ title: "Чаңгыс баглааш", titleLatin: "Chaŋgys baglaash", startS: 75 });
    expect((await list()).map((c) => c.startS)).toEqual([60, 75]);
    const hit = await call("GET", `/api/search?q=${encodeURIComponent("#videos baglaash")}`);
    expect(JSON.stringify(hit.body)).toContain("Чаңгыс баглааш");
  });

  test("attach a Song and a Version; a different Song resets the Version; clearing works; bad Version refused", async () => {
    const [c] = await list();
    const a = await call("PATCH", `/api/chapters/${c.id}`, { songId: S(1) });
    expect(a.body).toMatchObject({ songId: S(1), versionId: null, song: { id: S(1), name: "Aa-shuu, dekei-oo" } });
    expect(a.body.song.versions.map((v: any) => v.label)).toEqual(["Complete", "Short"]);
    const b = await call("PATCH", `/api/chapters/${c.id}`, { versionId: S(102) });
    expect(b.body).toMatchObject({ songId: S(1), versionId: S(102) });
    expect((await call("PATCH", `/api/chapters/${c.id}`, { versionId: S(104) })).status).toBe(400);
    const d = await call("PATCH", `/api/chapters/${c.id}`, { songId: S(2) });
    expect(d.body).toMatchObject({ songId: S(2), versionId: null });
    expect((await call("PATCH", `/api/chapters/${c.id}`, { songId: null })).body).toMatchObject({ songId: null, song: null });
  });

  test("DELETE of a manual Chapter leaves no tombstone", async () => {
    const [c] = await list();
    const r = await call("DELETE", `/api/chapters/${c.id}`);
    expect(r.body).toMatchObject({ deleted: true, tombstoned: false });
    expect(tombs()).toEqual([]);
    expect(await list()).toHaveLength(1);
    expect((await call("DELETE", `/api/chapters/${c.id}`)).status).toBe(404);
  });

  test("reject writes the tombstone and deletes; DELETE of a Suggested Chapter is the same rejection", async () => {
    const a = suggested(100, "A");
    const b = suggested(200, "B", "description");
    const r = await call("POST", `/api/chapters/${a}/reject`);
    expect(r.body).toMatchObject({ rejected: true });
    expect(tombs()).toEqual([{ source: "comment", start_s: 100 }]);
    const d = await call("DELETE", `/api/chapters/${b}`);
    expect(d.body).toMatchObject({ deleted: true, tombstoned: true });
    expect(tombs()).toEqual([{ source: "comment", start_s: 100 }, { source: "description", start_s: 200 }]);
    expect((await list()).map((c) => c.startS)).toEqual([75]);
    // a confirmed Chapter cannot be "rejected"
    const manual = (await list())[0];
    expect((await call("POST", `/api/chapters/${manual.id}/reject`)).status).toBe(409);
    expect(await cnt()).toBe(1);
  });

  test("confirm clears the flag and keeps the source; attaching a Song keeps a Suggested Chapter Suggested; editing the title confirms", async () => {
    const a = suggested(300, "Typed", "comment");
    const withSong = await call("PATCH", `/api/chapters/${a}`, { songId: S(4) });
    expect(withSong.body).toMatchObject({ suggested: true, songId: S(4), source: "comment" });
    const c = await call("POST", `/api/chapters/${a}/confirm`);
    expect(c.body).toMatchObject({ suggested: false, source: "comment", songId: S(4) });
    const b = suggested(400, "Edit me");
    expect((await call("PATCH", `/api/chapters/${b}`, { title: "Edited" })).body.suggested).toBe(false);
    const c2 = suggested(500, "Move me");
    expect((await call("PATCH", `/api/chapters/${c2}`, { startS: 520 })).body).toMatchObject({ suggested: false, startS: 520 });
    expect(tombs().pop()).toEqual({ source: "comment", start_s: 500 }); // the old spot is remembered
    expect((await call("POST", "/api/chapters/9999/confirm")).status).toBe(404);
  });

  test("confirm-all confirms every Suggested Chapter of the Video and only that Video", async () => {
    app.db.exec("DELETE FROM chapter");
    suggested(10, "x");
    suggested(20, "y", "performance");
    app.db.query("INSERT INTO chapter (video_id, start_s, title, suggested, source) VALUES (2, 10, 'other video', 1, 'comment')").run();
    const r = await call("POST", "/api/videos/1/chapters/confirm-all");
    expect(r.body.confirmed).toBe(2);
    expect(r.body.chapters.every((c: any) => !c.suggested)).toBe(true);
    expect((await list(2))[0].suggested).toBe(true);
    expect((await call("POST", "/api/videos/1/chapters/confirm-all")).body.confirmed).toBe(0);
    expect((await call("POST", "/api/videos/99/chapters/confirm-all")).status).toBe(404);
  });

  test("a Favorite Chapter carries its Song in /api/favorites", async () => {
    const [c] = await list();
    await call("PATCH", `/api/chapters/${c.id}`, { songId: S(2) });
    await call("POST", `/api/chapters/${c.id}/favorite`, { favorite: true });
    const fav = (await call("GET", "/api/favorites")).body.find((i: any) => i.kind === "chapter");
    expect(fav.chapter).toMatchObject({ id: c.id, songId: S(2), source: expect.any(String) });
  });

  test("a deleted Chapter leaves no search row, and a rebuild indexes the titled Chapters", async () => {
    const r = await call("POST", "/api/videos/2/chapters", { startS: 12, title: "Findable-title" });
    const find = async () => JSON.stringify((await call("GET", `/api/search?q=${encodeURIComponent("#videos findable")}`)).body);
    expect(await find()).toContain("Findable-title");
    await call("DELETE", `/api/chapters/${r.body.id}`);
    expect(await find()).not.toContain("Findable-title");
    rebuildSearchIndex(app.db);
    const n = (app.db.query("SELECT COUNT(*) n FROM chapter WHERE title <> ''").get() as any).n;
    expect((app.db.query("SELECT COUNT(*) n FROM search WHERE kind = 'chapter'").get() as any).n).toBe(n);
  });
});

describe("Player key for adding a Chapter", () => {
  test("c adds a Chapter at the playhead, only while the Player is focused, never repeated", async () => {
    const { dispatchKey, keyAction } = await import("../src/shared/keymap");
    expect(keyAction({ key: "c" })).toEqual({ type: "chapterAdd" });
    expect(keyAction({ key: "c", metaKey: true })).toBeNull();
    expect(dispatchKey({ key: "c" }, { containerFocused: false })).toEqual({ action: null, handled: false });
    expect(dispatchKey({ key: "c", repeat: true }, { containerFocused: true })).toEqual({ action: null, handled: true });
  });
});
