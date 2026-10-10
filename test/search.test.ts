// Pure parts of ticket #23: folding, the #12 scorer, the typed-filter parser, library view state, HTML to lyric lines.
import { describe, expect, test } from "bun:test";
import { foldQuery, foldSegments, foldText, highlightHtml, matchRanges } from "../src/shared/fold";
import { effectiveGroups, filterChips, isFilterOnly, parseQuery, rowCap } from "../src/shared/filters";
import { scoreFolded, scoreSegments, songPenalty, lyricsSearchable } from "../src/shared/score";
import { defaultLibraryState, libraryQuery, parseLibrarySearch, viewVideos } from "../src/shared/libraryView";
import { htmlToLines, splitAlternates } from "../src/server/search";
import type { VideoDto } from "../src/shared/types";

describe("folding", () => {
  test("Latin specials", () => {
    expect(foldText("Uvaŋ-Shu")).toBe("uvang-shu");
    expect(foldText("Ölchey")).toBe("olchey");
    expect(foldText("Köshkendei")).toBe("koshkendei");
    expect(foldText("Ünü")).toBe("unu");
    expect(foldText("piñata")).toBe("pingata");
  });
  test("x, kh and хөөмей all meet", () => {
    expect(foldText("xoomei")).toBe("khoomei");
    expect(foldText("khoomei")).toBe("khoomei");
    expect(foldText("хөөмей")).toBe("khoomei");
  });
  test("Cyrillic folds to Latin so a Latin query hits Cyrillic", () => {
    expect(foldText("Сарыглар")).toBe("saryglar");
    expect(foldQuery("  Saryg  ")).toBe("saryg");
    expect(foldText("Тыва дың")).toBe("tyva ding".replace("ding", "dyng"));
    expect(foldText("Ңң")).toBe("ngng");
    expect(foldText("Ъь")).toBe("");
  });
  test("the segment separator cannot be forged by a title", () => {
    expect(foldText("A | B")).toBe("a / b");
    expect(foldSegments(["Алаш", "Alash"])).toBe("alash | alash");
  });
  test("match ranges map back onto the original text", () => {
    const text = "Хөөмей Khoomei";
    const r = matchRanges(text, "khoomei");
    expect(r).toEqual([[0, 6], [7, 14]]);
    expect(highlightHtml(text, "khoomei")).toBe("<mark>Хөөмей</mark> <mark>Khoomei</mark>");
    expect(highlightHtml("a<b>&c", "b")).toBe("a&lt;<mark>b</mark>&gt;&amp;c");
    expect(highlightHtml("nothing", "zzz")).toBe("nothing");
  });
});

describe("scorer (#12)", () => {
  test("exact 0 / prefix 1 / word-start 1.5 / contains 2", () => {
    expect(scoreFolded("alash", "alash")).toBe(0);
    expect(scoreFolded("alash ensemble", "alash")).toBe(1);
    expect(scoreFolded("the alash ensemble", "alash")).toBe(1.5);
    expect(scoreFolded("the-alash", "alash")).toBe(1.5);
    expect(scoreFolded("kalash", "alash")).toBe(2);
    expect(scoreFolded("tuva", "alash")).toBeNull();
    expect(scoreFolded("anything", "")).toBeNull();
  });
  test("+3 for an English title, +4 for an alternate, best segment wins", () => {
    const f = foldSegments(["Сарыглар", "Saryglar", "Sarygler", "Sarig"]);
    expect(scoreSegments(f, "saryglar", songPenalty)).toBe(0); // the name itself folds to saryglar
    expect(scoreSegments(foldSegments(["Хомей", "Throat singing"]), "throat", songPenalty)).toBe(1 + 3);
    expect(scoreSegments(foldSegments(["Хомей", "Throat singing", "Sygyt"]), "sygyt", songPenalty)).toBe(0 + 4);
    expect(scoreSegments(foldSegments(["Хомей", "Throat singing", "Sygyt"]), "zzz", songPenalty)).toBeNull();
  });
  test("lyrics are searched only from 3 characters", () => {
    expect(lyricsSearchable("ab")).toBe(false);
    expect(lyricsSearchable("abc")).toBe(true);
  });
});

describe("typed filters", () => {
  test("group filters, anywhere in the query", () => {
    const p = parseQuery("alash #videos tuva #Songs");
    expect(p.text).toBe("alash tuva");
    expect(p.groups).toEqual(["videos", "songs"]);
    expect(effectiveGroups(p)).toEqual(["songs", "videos"]); // fixed group order
    expect(rowCap(p)).toBe(40);
    expect(rowCap(parseQuery("alash"))).toBe(8);
  });
  test("#available #fav #type: #artist:", () => {
    const p = parseQuery("#available #fav #type:concert #type:Song #artist:Radik_Tyulush khoomei");
    expect(p).toMatchObject({ available: true, fav: true, types: ["concert", "song"], artists: ["Radik Tyulush"], text: "khoomei" });
    expect(effectiveGroups(p)).toEqual(["videos"]); // Video filters alone imply the Videos group
    expect(filterChips(p).map((c) => c.token)).toEqual(["#available", "#fav", "#type:concert", "#type:song", "#artist:Radik_Tyulush"]);
  });
  test("#lyrics, unknown #words stay in the text, bad type stays", () => {
    const p = parseQuery("#lyrics #nope #type:bogus ala");
    expect(p.lyricsOnly).toBe(true);
    expect(p.text).toBe("#nope #type:bogus ala");
    expect(effectiveGroups(p)).toEqual(["songs"]);
  });
  test("filter-only versus filters plus text", () => {
    expect(isFilterOnly(parseQuery("#available #fav"))).toBe(true);
    expect(isFilterOnly(parseQuery("#videos"))).toBe(true);
    expect(isFilterOnly(parseQuery("#available alash"))).toBe(false);
    expect(isFilterOnly(parseQuery("alash"))).toBe(false);
    expect(isFilterOnly(parseQuery(""))).toBe(false);
  });
});

describe("html to lyric lines and alternates", () => {
  test("one paragraph is one line; markers, tags, blanks and entities handled", () => {
    const html = '<p>Line one<sup data-fn="1" class="footnote-ref">1</sup></p><p class="ln-blank"></p><p>Tom &amp; <em>Jerry</em>&nbsp;x</p><p>  </p><p>a<br>b</p>';
    expect(htmlToLines(html)).toEqual(["Line one", "Tom & Jerry x", "a", "b"]);
    expect(htmlToLines(null)).toEqual([]);
  });
  test("alternates: comma separated or JSON", () => {
    expect(splitAlternates("a, b ,, c")).toEqual(["a", "b", "c"]);
    expect(splitAlternates('["x", "y"]')).toEqual(["x", "y"]);
    expect(splitAlternates(null)).toEqual([]);
  });
});

const vid = (id: number, o: Partial<VideoDto> = {}): VideoDto => ({
  id, youtubeId: null, title: `V${id}`, titleLatin: null, type: "other", favoritedAt: null, resumeS: null, lastPlayedAt: null,
  createdAt: "2026-01-01T00:00:00Z", addedAt: `2026-01-0${id}T00:00:00Z`, chapterCount: 0, artists: [], availability: null,
  durationS: id * 100, available: false, preferredCopyId: null, width: null, height: null, thumbnail: null, copies: [], ...o,
});

describe("library view state", () => {
  test("URL round trip keeps only non-defaults", () => {
    expect(libraryQuery(defaultLibraryState())).toBe("");
    const st = { ...defaultLibraryState(), types: ["song" as const, "concert" as const], availableOnly: true, fav: true, artist: "Radik Tyulush", sort: "title" as const, dir: "desc" as const };
    const q = libraryQuery(st);
    expect(q).toBe("?type=song,concert&available=1&fav=1&artist=Radik_Tyulush&sort=title&dir=desc");
    expect(parseLibrarySearch(q)).toEqual(st);
    expect(parseLibrarySearch("?sort=title").dir).toBe("asc"); // natural direction
    expect(parseLibrarySearch("?sort=bogus&type=nope").types).toEqual([]);
  });
  test("default sort is date added, newest first", () => {
    const out = viewVideos([vid(1), vid(3), vid(2)], defaultLibraryState());
    expect(out.map((v) => v.id)).toEqual([3, 2, 1]);
  });
  test("filters: type, availability, favorites, artist (folded names)", () => {
    const radik = { id: 1, name: "Radik Tyulyush", nameLatin: null, local: true };
    const vs = [
      vid(1, { type: "song", available: true, artists: [radik] }),
      vid(2, { type: "concert", available: true, favoritedAt: "2026-02-01" }),
      vid(3, { type: "song", available: false, favoritedAt: "2026-02-02", artists: [radik] }),
    ];
    const run = (p: Partial<ReturnType<typeof defaultLibraryState>>) => viewVideos(vs, { ...defaultLibraryState(), ...p }).map((v) => v.id);
    expect(run({ types: ["song"] })).toEqual([3, 1]);
    expect(run({ availableOnly: true })).toEqual([2, 1]);
    expect(run({ fav: true })).toEqual([3, 2]);
    expect(run({ artist: "radik tyulyush" })).toEqual([3, 1]);
    expect(run({ artist: "Nobody" })).toEqual([]);
    expect(run({ types: ["song"], availableOnly: true, fav: true })).toEqual([]);
  });
  test("sorts: title asc, duration desc, last played with nulls last", () => {
    const vs = [vid(1, { title: "b", lastPlayedAt: "2026-05-01" }), vid(2, { title: "A" }), vid(3, { title: "c", lastPlayedAt: "2026-06-01" })];
    const run = (sort: any) => viewVideos(vs, { ...defaultLibraryState(), sort, dir: sort === "title" ? "asc" : "desc" }).map((v) => v.id);
    expect(run("title")).toEqual([2, 1, 3]);
    expect(run("duration")).toEqual([3, 2, 1]);
    expect(run("played")).toEqual([3, 1, 2]);
    expect(viewVideos(vs, { ...defaultLibraryState(), sort: "played", dir: "asc" }).map((v) => v.id)).toEqual([1, 3, 2]);
  });
});
