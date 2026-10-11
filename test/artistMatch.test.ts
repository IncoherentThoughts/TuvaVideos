// The Artist matcher (spec 2.3): titles to Suggested Artists.
import { describe, expect, test } from "bun:test";
import { foldArtist, matchArtists, titleSegments } from "../src/shared/artistMatch";

const A = [
  { id: 1, names: ["Alash Ensemble"] },
  { id: 2, names: ["Huun-Huur-Tu"] },
  { id: 3, names: ["Kongar-ool Ondar"] },
  { id: 4, names: ["KHOOMEI BEAT"] },
  { id: 5, names: ["Tuva Ensemble"] },
  { id: 6, names: ["Vladimir Oidupaa"] },
  { id: 7, names: ["Ayan-Ool Sam"] },
  { id: 8, names: ["Radik Tyulyush", "Радик Тюлюш"] },
  { id: 9, names: ["Shu-De"] },
  { id: 10, names: ["группа Аян"] },
];
const ids = (t: string) => matchArtists(t, A).map((m) => m.id);

describe("foldArtist", () => {
  test("Cyrillic, kh/h, group words", () => {
    expect(foldArtist("хуун-хуур-ту")).toBe("huun huur tu");
    expect(foldArtist("Huun-Huur-Tu")).toBe("huun huur tu");
    expect(foldArtist("фольклорный ансамбль «Алаш»")).toBe("folklornyi alash");
    expect(foldArtist("The Alash Ensemble")).toBe("alash");
  });
  test("segments: separators and brackets", () => {
    expect(titleSegments("Huun-Huur-Tu & Anewal - Kongurgai (Live on KEXP)")).toEqual(["Huun-Huur-Tu", "Anewal", "Kongurgai", "Live on KEXP", "Huun-Huur-Tu & Anewal - Kongurgai (Live on KEXP)"]);
  });
});

describe("matchArtists", () => {
  test("exact and Cyrillic titles", () => {
    expect(ids("Alash - Bashtak Joke, Live at the Quick")).toEqual([1]);
    expect(ids("хуун-хуур-ту, концерт в Казани")).toEqual([2]);
    expect(ids("Тувинское горловое пение. Радик Тюлюш.")).toEqual([8]);
    expect(ids("Ross Daly & Huun Huur Tu - White Dragon - 2008")).toEqual([2]);
  });
  test("partial names need two aligned words; a first name alone is nothing", () => {
    expect(ids("Kongar-Ol Student Reunion")).toEqual([3]);
    expect(ids("Ayan-ool Ezengileer")).toEqual([7]);
    expect(ids("Huun-Huur-Tu & Fuse - Vladimir Martynov")).toEqual([2]);
  });
  test("generic words and junk windows do not match", () => {
    expect(ids("Tuvan Throat Singers")).toEqual([]);
    expect(ids("Хоомей и игил под кустом")).toEqual([]);
    expect(ids("Bady Dorzhu Ondar - Bayan solo")).toEqual([]);
    expect(ids("Aa-shuu Dekei-oo – Igor Köshkendei")).toEqual([]);
  });
  test("several Artists, each once, best first", () => {
    const m = matchArtists("Alash Ensemble - Bady Dorzhu Ondar & Kongar-ool Ondar, Ithaca 2014", A);
    expect(m.map((x) => x.id)).toEqual([1, 3]);
    expect(m[0]!.score).toBe(1);
  });
  test("the uploader counts as a segment", () => {
    expect(matchArtists("Live in Kyzyl 2019", A, ["Radik Tyulyush"]).map((m) => m.id)).toEqual([8]);
  });
});
