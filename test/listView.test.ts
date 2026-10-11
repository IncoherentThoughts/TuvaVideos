// The list screens' filter/sort state and its URL form (Artists, Songs, Favorites), plus the shared matching helpers.
import { describe, expect, test } from "bun:test";
import {
  artistsQuery, cmpNullsLast, defaultArtistsState, defaultFavoritesState, defaultSongsState, favoritesQuery, nameMatches,
  parseArtistsSearch, parseFavoritesSearch, parseSongsSearch, songsQuery,
} from "../src/shared/listView";

describe("list view state", () => {
  test("defaults round-trip to an empty query", () => {
    expect(artistsQuery(defaultArtistsState())).toBe("");
    expect(songsQuery(defaultSongsState())).toBe("");
    expect(favoritesQuery(defaultFavoritesState())).toBe("");
    expect(parseArtistsSearch("")).toEqual(defaultArtistsState());
    expect(parseSongsSearch("")).toEqual(defaultSongsState());
    expect(parseFavoritesSearch("")).toEqual(defaultFavoritesState());
  });
  test("Artists: name, kind, sort with its natural direction; a reversed direction is written", () => {
    const st = parseArtistsSearch("?q=alash&kind=local&sort=videos");
    expect(st).toEqual({ q: "alash", kind: "local", sort: "videos", dir: "desc" });
    expect(artistsQuery(st)).toBe("?q=alash&sort=videos&kind=local");
    expect(parseArtistsSearch("?sort=videos&dir=asc").dir).toBe("asc");
    expect(artistsQuery({ ...st, dir: "asc" })).toContain("dir=asc");
    expect(parseArtistsSearch("?kind=bogus&sort=bogus")).toEqual(defaultArtistsState());
  });
  test("Songs: lyrics flag and sorts", () => {
    expect(parseSongsSearch("?lyrics=1&sort=chapters")).toEqual({ q: "", lyricsOnly: true, sort: "chapters", dir: "desc" });
    expect(songsQuery({ q: "sary", lyricsOnly: true, sort: "name", dir: "desc" })).toBe("?q=sary&dir=desc&lyrics=1");
  });
  test("Favorites: show, types, availability, sort; unknown types dropped; commas unescaped", () => {
    const st = parseFavoritesSearch("?show=chapters&type=song,bogus,concert&available=1&sort=title");
    expect(st).toEqual({ q: "", show: "chapters", types: ["song", "concert"], availableOnly: true, sort: "title", dir: "asc" });
    expect(favoritesQuery(st)).toBe("?show=chapters&type=song,concert&available=1&sort=title");
  });
  test("nameMatches folds both sides; empty matches all", () => {
    expect(nameMatches("", null)).toBe(true);
    expect(nameMatches("saryg", "Сарыглар")).toBe(true);
    expect(nameMatches("хомей", null, "Khomei")).toBe(true);
    expect(nameMatches("zzz", "Alash", "Алаш")).toBe(false);
  });
  test("cmpNullsLast keeps missing values last in either direction", () => {
    expect([3, null, 1].sort((a, b) => cmpNullsLast(a, b, 1))).toEqual([1, 3, null]);
    expect([3, null, 1].sort((a, b) => cmpNullsLast(a, b, -1))).toEqual([3, 1, null]);
    expect(cmpNullsLast("a", "b", -1)).toBe(1);
  });
});
