// Pure parts of ticket #25: the transliteration table, the ported lyrics helpers, the sanitizer profiles, Song names.
import { describe, expect, test } from "bun:test";
import { TRANSLIT, hasCyrillic, latinByTable, transliterate } from "../src/shared/translit";
import { numberLines, numberedLines, groupLinesIntoStanzas, markersInReadingOrder, parseHtmlToLines, validateLyricsField } from "../src/shared/lyrics/normalize";
import { augmentMarkers, defaultMarkerLabel, entriesById } from "../src/shared/lyrics/markers";
import { sanitize } from "../src/shared/lyrics/sanitize";
import { effectiveScript, parseFootnotes, presentScripts } from "../src/shared/lyrics/scripts";
import { isPointedVersionAt, openingVersionIndex } from "../src/shared/lyrics/trackVersion";
import { chapterAt, lyricsTarget } from "../src/shared/lyrics/target";
import { highlightSnippet } from "../src/shared/lyrics/highlight";
import { allSongNames, latinSpelling } from "../src/shared/songNames";

describe("transliteration table (data-model.md)", () => {
  test("every row, lower case and capital", () => {
    for (const [cyr, lat] of TRANSLIT) {
      expect(transliterate(cyr)).toBe(lat);
      const up = cyr.toUpperCase();
      const want = lat === "" ? "" : lat[0]!.toUpperCase() + lat.slice(1);
      expect(transliterate(up)).toBe(want); // alone: a digraph is Capitalised
    }
  });
  test("the table lists the 35 letters besides Й", () => {
    expect(TRANSLIT.length).toBe(35);
  });
  test("Й is J before a vowel, I otherwise", () => {
    for (const v of "аеёиоөуүыэюя") expect(transliterate(`й${v}`)).toBe(`j${transliterate(v)}`);
    expect(transliterate("Ойн")).toBe("Oin");
    expect(transliterate("Тыйлаш")).toBe("Tyilash"); // before л
    expect(transliterate("Йорк")).toBe("Iork".replace("Iork", "Jork")); // before о
    expect(transliterate("Тый")).toBe("Tyi"); // word end
    expect(transliterate("ЙА")).toBe("JA");
    expect(transliterate("Йа")).toBe("Ja");
  });
  test("digraphs are lower-cased inside a word and capitalised at its start", () => {
    expect(transliterate("Жаа")).toBe("Zhaa");
    expect(transliterate("Чылгычы")).toBe("Chylgychy");
    expect(transliterate("Ёлка")).toBe("Jolka");
    expect(transliterate("Юла")).toBe("Jula");
    expect(transliterate("Тыва Шаңгы")).toBe("Tyva Shaŋgy");
  });
  test("an all-capitals word keeps capitals", () => {
    expect(transliterate("ЖАА")).toBe("ZHAA");
    expect(transliterate("ШОУ")).toBe("SHOU");
    expect(transliterate("ТЫВА")).toBe("TYVA");
  });
  test("Ъ and Ь drop, Ң Ө Ү map, other characters pass through", () => {
    expect(transliterate("объект")).toBe("obekt");
    expect(transliterate("Өске чер, Үнү-1 (live)")).toBe("Öske cher, Ünü-1 (live)");
    expect(transliterate("Ң ң")).toBe("Ŋ ŋ");
    expect(transliterate("Radik Тюлюш")).toBe("Radik Tjuljush");
  });
  test("latinByTable: NULL for a title that is already Latin", () => {
    expect(hasCyrillic("Алаш")).toBe(true);
    expect(latinByTable("Alash - Khoomei")).toBeNull();
    expect(latinByTable("Алаш")).toBe("Alash");
  });
});

describe("lyrics helpers (ported from the archive)", () => {
  const html = '<p>One<sup data-fn="1" class="footnote-ref">1</sup><sup data-fn="2" class="footnote-ref">2</sup></p>\n<p class="ln-blank"><br></p><p></p><p>Two</p>\n<p>&nbsp;</p><p>Three<sup data-fn="1">1</sup></p>';
  test("one <p> is one line; blank paragraphs are blank", () => {
    const l = parseHtmlToLines(html);
    expect(l.map((x) => x.isBlank)).toEqual([false, true, true, false, true, false]);
    expect(parseHtmlToLines("")).toEqual([]);
    expect(parseHtmlToLines("no paragraphs")).toEqual([{ innerHTML: "no paragraphs", isBlank: false }]);
  });
  test("stanzas collapse blank runs; numbers continue across stanzas", () => {
    const st = groupLinesIntoStanzas(parseHtmlToLines(html));
    expect(st.map((s) => s.lines.map((x) => x.number))).toEqual([[1], [2], [3]]);
    const n = numberedLines(html);
    expect(n.map((x) => (x.blank ? "-" : x.n))).toEqual([1, "-", 2, "-", 3]);
    expect(numberLines(parseHtmlToLines('<p><br></p><p>a</p><p><br></p>')).map((x) => x.blank)).toEqual([false]); // edge blanks dropped
  });
  test("markers in reading order keep duplicates", () => {
    expect(markersInReadingOrder(html)).toEqual([1, 2, 1]);
    expect(markersInReadingOrder("")).toEqual([]);
  });
  test("integrity: orphan markers, unreferenced and empty entries", () => {
    const v = validateLyricsField(html, [{ id: 1, text: "a" }, { id: 3, text: "  " }]);
    expect(v).toEqual({ orphanMarkers: [2], orphanEntries: [3], emptyFootnotes: [3] });
  });
  test("augment: ids per occurrence, a11y attributes, adjacency flag, orphan flag; first duplicate entry wins", () => {
    const entries = [{ id: 1, text: "<b>first</b>" }, { id: 1, text: "dup" }];
    expect(entriesById(entries).get(1)!.text).toBe("<b>first</b>");
    const out = augmentMarkers(parseHtmlToLines(html), entries, { kind: "fn", idPrefix: "v-cyr", label: defaultMarkerLabel });
    const first = out[0]!.innerHTML;
    expect(first).toContain('id="fn-marker-v-cyr-1-1"');
    expect(first).toContain('role="doc-noteref"');
    expect(first).toContain('aria-describedby="fn-def-v-cyr-1"');
    expect(first).toContain('aria-label="Footnote 1: first"');
    expect(first).toMatch(/<sup[^>]*data-fn="2"[^>]*data-orphan="true"[^>]*data-adjacent="true"/);
    expect(first).not.toMatch(/data-fn="1"[^>]*data-adjacent/);
    expect(out[5]!.innerHTML).toContain('id="fn-marker-v-cyr-1-2"'); // second occurrence of id 1
  });
  test("scripts: present, clamp, version pointer", () => {
    expect(presentScripts({ cyrillic: "<p>a</p>", transliteration: "  ", translation: null })).toEqual(["cyrillic"]);
    expect(effectiveScript("translation", ["cyrillic", "translation"])).toBe("translation");
    expect(effectiveScript("transliteration", ["cyrillic", "translation"])).toBe("cyrillic");
    expect(effectiveScript("translation", [])).toBe("cyrillic");
    const vs = [{ id: "a" }, { id: "b" }];
    expect(openingVersionIndex(vs, "b")).toBe(1);
    expect(openingVersionIndex(vs, "gone")).toBe(0);
    expect(openingVersionIndex(vs, null)).toBe(0);
    expect(openingVersionIndex([], "x")).toBe(0);
    expect(isPointedVersionAt(vs, "b", 1)).toBe(true);
    expect(isPointedVersionAt(vs, null, 0)).toBe(false);
  });
  test("footnote columns parse from JSON text or arrays and drop junk", () => {
    expect(parseFootnotes('[{"id":1,"text":"a"},{"id":"x"},null,{"id":2}]')).toEqual([{ id: 1, text: "a" }, { id: 2, text: "" }]);
    expect(parseFootnotes("not json")).toEqual([]);
    expect(parseFootnotes([{ id: 3, text: "t" }])).toEqual([{ id: 3, text: "t" }]);
  });
  test("which Song the drawer shows: Chapter, then Video, then none", () => {
    expect(lyricsTarget({ songId: "c", versionId: "cv" }, { songId: "v", versionId: null })).toEqual({ songId: "c", versionId: "cv", fromChapter: true });
    expect(lyricsTarget({ songId: null, versionId: null }, { songId: "v", versionId: "x" })).toEqual({ songId: "v", versionId: "x", fromChapter: false });
    expect(lyricsTarget(null, { songId: null, versionId: null })).toBeNull();
    const ch = [{ startS: 0 }, { startS: 100 }, { startS: 50 }];
    expect(chapterAt(ch, 60)).toEqual({ startS: 50 });
    expect(chapterAt(ch, 100)).toEqual({ startS: 100 });
    expect(chapterAt([{ startS: 10 }], 5)).toBeNull();
  });
  test("highlightSnippet splits case-insensitively", () => {
    expect(highlightSnippet("Hello hello", "HEL")).toEqual([{ text: "Hel", match: true }, { text: "lo ", match: false }, { text: "hel", match: true }, { text: "lo", match: false }]);
    expect(highlightSnippet("abc", " ")).toEqual([{ text: "abc", match: false }]);
  });
});

describe("sanitizer profiles", () => {
  test("LINE keeps text formatting, markers and data/aria attributes; drops scripts, handlers, images, links", () => {
    const dirty = '<p class="x" onclick="evil()"><b>b</b><img src=x onerror=y><a href="javascript:z">link</a><script>alert(1)</script><sup data-fn="1" aria-label="n" style="color:red">1</sup></p>';
    expect(sanitize(dirty, "LINE")).toBe('<p class="x"><b>b</b>link<sup data-fn="1" aria-label="n">1</sup></p>');
  });
  test("FOOTNOTE allows inline formatting only and no attributes", () => {
    expect(sanitize('Alt: <b class="k">x</b> <span>y</span><p>z</p><br/>', "FOOTNOTE")).toBe("Alt: <b>x</b> yz<br>");
  });
  test("re-balances tags, escapes a bare <, strips comments and doctype", () => {
    expect(sanitize("<p><b>open", "LINE")).toBe("<p><b>open</b></p>");
    expect(sanitize("a</i>b", "LINE")).toBe("ab");
    expect(sanitize("1 < 2 <!-- c --><!doctype html>", "LINE")).toBe("1 &lt; 2 ");
    expect(sanitize('<p title="a>b">x</p>', "LINE")).toBe("<p>x</p>"); // quoted > does not end the tag; title not allowed
  });
});

describe("Song names", () => {
  const s = { name: "Aa-shuu, dekei-oo", english_name: null, alternate_titles: "Dekei-oo", alternate_spellings: "Аа-шуу декей-оо, А-шуу декей-оо,  Ah shu dekei oo" };
  test("all names, tagged, in order; the Song's own name is never split on its comma", () => {
    expect(allSongNames(s)).toEqual([
      { text: "Aa-shuu, dekei-oo", kind: "name" },
      { text: "Dekei-oo", kind: "alternate_title" },
      { text: "Аа-шуу декей-оо", kind: "alternate_spelling" },
      { text: "А-шуу декей-оо", kind: "alternate_spelling" },
      { text: "Ah shu dekei oo", kind: "alternate_spelling" },
    ]);
  });
  test("the archive Latin spelling: the Latin name, else the first Latin alternate", () => {
    expect(latinSpelling(s)).toBe("Aa-shuu, dekei-oo");
    expect(latinSpelling({ name: "Чаңгыс", alternate_spellings: "Чаньгыс, Changys, Chaŋgys" })).toBe("Changys");
    expect(latinSpelling({ name: "Чаңгыс" })).toBeNull();
  });
});
