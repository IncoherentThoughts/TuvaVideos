// The Song matcher on Video titles (spec 2.3): the pure matcher on titles from the 2026-10-11 library dry run, and
// the server pass (suggest, replace, clear, a rejection sticks, Performances win, Local Songs re-run it).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { patchVideo } from "../src/server/edit";
import { createLocalSong, patchLocalSong } from "../src/server/localSongs";
import { applyPerformanceDefaults } from "../src/server/defaults";
import { suggestSongsFromTitles } from "../src/server/songSuggest";
import { foldForMatch, prepareSongs } from "../src/shared/songMatch";
import { matchSongInTitle, prepareArtistNames, songSegments, type TitleSong } from "../src/shared/titleSongMatch";
import { insertVideo, V } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");

const RAW = [
  { id: "ezir", name: "Ezir-Kara" },
  { id: "kozh", name: "Kozhamyktar" },
  { id: "alxem", name: "Alash-Xem", english_name: "Alash River", alternate_spellings: "Alash Khem" },
  { id: "enesai", name: "Ene-Sai" },
  { id: "karg", name: "Kargyraa" },
  { id: "xoom", name: "Xöömejimni" },
  { id: "igxoom", name: "Igilimni Xöömejimni" },
  { id: "ydyk", name: "Ydyk Yry" },
  { id: "bash", name: "Bashtak-la deesh meni kanchaar", alternate_titles: "Bashtak" },
  { id: "xoor", name: "Xoor chonga", english_name: "Of the people" },
  { id: "aashuu", name: "Aa-shuu, dekei-oo", alternate_titles: "Dekei-oo" },
  { id: "mezh", name: "Mezhegei" },
];
const english = new Map(RAW.map((r) => [r.id, r.english_name ? foldForMatch(r.english_name) : null]));
const SONGS: TitleSong[] = prepareSongs(RAW).map((s) => ({ ...s, english: english.get(s.id) }));
const ARTISTS = prepareArtistNames(["Alash Ensemble", "Igor Köshkendei", "Huun-Huur-Tu"]);
const hit = (title: string) => matchSongInTitle(title, SONGS, ARTISTS)?.songId ?? null;

describe("matchSongInTitle", () => {
  test("a Song named in its own segment, in either script", () => {
    expect(hit("Ezir-Kara – Igor Köshkendei with Ensemble Daia")).toBe("ezir");
    expect(hit("Кожамыктар - Ученики Конгар-оола Борисовича Ондар")).toBe("kozh");
    expect(hit("Huun Huur Tu - Mezhegei")).toBe("mezh");
    expect(hit("Алаш - 4. Mezhegei")).toBe("mezh");
  });
  test("a match at the start of a descriptive segment still counts", () => {
    expect(hit("Ydyk Yry The anthem of tyvan buddhists (＂Ыдык ыры＂). 02.02.2019")).toBe("ydyk");
  });
  test("commas do not split a name", () => {
    expect(hit("Andrew Sheron & Alash: Tuvagrass at Joe's Pub - Aa-shuu, dekei-oo")).toBe("aashuu");
    expect(songSegments("Aa-shuu, dekei-oo – Alash")).toContain("Aa-shuu, dekei-oo");
  });
  test("a band name plus noise is not the Song that shares a word with it", () => {
    expect(hit("Alash live at The Rotunda in Philadelphia")).toBeNull();
    expect(hit("Alash - The Evening Muse - 2_22_17 - Charlotte NC")).toBeNull();
  });
  test("bands named like a Song are never matched as the Song", () => {
    expect(hit("The joint performance of groups Olchey and Ene Sai in the Kremlin Palace")).toBeNull();
  });
  test("style names are demonstrations, not Songs", () => {
    expect(hit("Kargyraa on the Beartooth Pass")).toBeNull();
    expect(hit("Nachyn Choreve 'Kargyraa'")).toBeNull();
  });
  test("a one-word name needs its segment to itself", () => {
    expect(hit("Кежик Успун. Конкурс Хөөмейимни-хөгжүмүмнү")).toBeNull();
    expect(hit("Alash - Bashtak Joke, Live at the Quick")).toBeNull();
    expect(hit("Mezhegei")).toBe("mezh");
  });
  test("the longer of two equally good names wins", () => {
    expect(hit("Igilimni, xöömejimni – Igor Köshkendei with Ensemble Daia")).toBe("igxoom");
  });
  test("an English name must match exactly", () => {
    expect(hit("Bai Terek - Strength of the people")).toBeNull();
  });
});

describe("suggestSongsFromTitles", () => {
  const open = () => {
    const db = openDb(":memory:", MIGRATIONS);
    db.exec("INSERT INTO archive_song (id, name, slug) VALUES ('m1', 'Mezhegei', 'mezhegei'), ('m2', 'Karachal', 'karachal')");
    insertVideo(db, { id: 1, youtube_id: "aaaaaaaaaaa", title: "Huun Huur Tu - Mezhegei", created_at: "x" });
    insertVideo(db, { id: 2, youtube_id: "bbbbbbbbbbb", title: "Alash live in Kyzyl", created_at: "x" });
    insertVideo(db, { id: 3, youtube_id: "ccccccccccc", title: "Karachal", created_at: "x" });
    insertVideo(db, { id: 4, youtube_id: "ddddddddddd", title: "Radik Tyulyush Oskus Urug", created_at: "x" });
    return db;
  };
  const row = (db: ReturnType<typeof open>, id: number) =>
    db.query("SELECT song_id, song_suggested, suggestion_source, type, type_suggested FROM videos WHERE id = ?").get(V(id)) as any;

  test("suggests a Song (and the Type song) from the title, leaves the rest alone", () => {
    const db = open();
    const r = suggestSongsFromTitles(db);
    expect(r).toMatchObject({ videos: 4, suggested: 2, changed: 2, cleared: 0 });
    expect(row(db, 1)).toEqual({ song_id: "m1", song_suggested: 1, suggestion_source: "title", type: "song", type_suggested: 1 });
    expect(row(db, 2).song_id).toBeNull();
    expect(suggestSongsFromTitles(db)).toMatchObject({ suggested: 2, changed: 0 }); // a re-run changes nothing
  });

  test("a title edited away from the Song clears the suggestion and the Suggested Type with it", () => {
    const db = open();
    suggestSongsFromTitles(db);
    db.query("UPDATE videos SET title = 'Somewhere else' WHERE id = ?").run(V(3));
    expect(suggestSongsFromTitles(db).cleared).toBe(1);
    expect(row(db, 3)).toEqual({ song_id: null, song_suggested: 0, suggestion_source: null, type: "other", type_suggested: 0 });
  });

  test("clearing the Song by hand is a rejection: it never comes back", () => {
    const db = open();
    suggestSongsFromTitles(db);
    expect(patchVideo(db, V(1), { songId: null }).ok).toBe(true);
    suggestSongsFromTitles(db);
    expect(row(db, 1)).toMatchObject({ song_id: null, suggestion_source: "manual" });
  });

  test("a Song from the Performances wins over the title", () => {
    const db = open();
    db.exec("INSERT INTO archive_performance (id, song_id, youtube_id, display_order, is_highlighted) VALUES ('p1', 'm2', 'aaaaaaaaaaa', 1, 0)");
    applyPerformanceDefaults(db);
    suggestSongsFromTitles(db);
    expect(row(db, 1)).toMatchObject({ song_id: "m2", suggestion_source: "performance" });
  });

  test("adding or renaming a Local Song runs the pass again", () => {
    const db = open();
    const r = createLocalSong(db, { name: "Ösküs Urug" });
    const id = (r as any).value.id;
    expect(row(db, 4)).toMatchObject({ song_id: id, suggestion_source: "title" });
    patchLocalSong(db, id, { name: "Something Else Entirely" });
    expect(row(db, 4).song_id).toBeNull();
  });
});
