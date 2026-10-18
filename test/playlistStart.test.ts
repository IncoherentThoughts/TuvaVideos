import { describe, expect, test } from "bun:test";
import { startPlaylist, current } from "../src/shared/playlist";
import {
  SEARCH_ENTRY_CAP, favoriteEntries, favoriteStartS, libraryFiltered, libraryStart, searchEntries, type FavoriteRow,
} from "../src/shared/playlistStart";
import { defaultLibraryState } from "../src/shared/libraryView";

describe("library", () => {
  test("unfiltered is library-all, filtered is library; entries keep the grid order", () => {
    expect(libraryFiltered(defaultLibraryState())).toBe(false);
    expect(libraryFiltered({ ...defaultLibraryState(), sort: "title", dir: "asc" })).toBe(false);
    for (const patch of [{ types: ["song" as const] }, { availableOnly: true }, { fav: true }, { artist: "X" }, { song: "s1" }])
      expect(libraryFiltered({ ...defaultLibraryState(), ...patch })).toBe(true);
    expect(libraryStart(["3", "1", "2"], false)).toEqual({ entries: [{ videoId: "3" }, { videoId: "1" }, { videoId: "2" }], source: "library-all" });
    expect(libraryStart(["3"], true).source).toBe("library");
  });
});

describe("search", () => {
  test("caps at 500 and keeps order", () => {
    const ids = Array.from({ length: 700 }, (_, i) => String(i + 1));
    const e = searchEntries(ids);
    expect(SEARCH_ENTRY_CAP).toBe(500);
    expect(e).toHaveLength(500);
    expect(e[0]).toEqual({ videoId: "1" });
    expect(e[499]).toEqual({ videoId: "500" });
    expect(searchEntries([])).toEqual([]);
  });
});

describe("favorites", () => {
  const rows: FavoriteRow[] = [
    { kind: "video", videoId: "7" },
    { kind: "chapter", videoId: "7", chapterId: "70", startS: 125 },
    { kind: "chapter", videoId: "8", chapterId: "80", startS: 0 },
  ];
  test("a Video and its Chapter both starred give two Entries", () => {
    expect(favoriteEntries(rows)).toEqual([{ videoId: "7" }, { videoId: "7", chapterId: "70" }, { videoId: "8", chapterId: "80" }]);
  });
  test("a Chapter Entry opens at its Chapter start, a Video Entry at null", () => {
    expect(favoriteStartS(rows, { videoId: "7" })).toBeNull();
    expect(favoriteStartS(rows, { videoId: "7", chapterId: "70" })).toBe(125);
    expect(favoriteStartS(rows, { videoId: "8", chapterId: "80" })).toBe(0);
    expect(favoriteStartS(rows, { videoId: "9", chapterId: "99" })).toBeNull();
  });
});

describe("random start", () => {
  test("startPlaylist with startAt omitted picks the rng's Entry, shuffled with Repeat off", () => {
    const entries = favoriteEntries([{ kind: "video", videoId: "1" }, { kind: "video", videoId: "2" }, { kind: "video", videoId: "3" }]);
    expect(current(startPlaylist(entries, { source: "favorites", rng: () => 0 }))).toEqual({ videoId: "1" });
    const last = startPlaylist(entries, { source: "favorites", rng: () => 0.999999 });
    expect(current(last)).toEqual({ videoId: "3" });
    expect(last.shuffled).toBe(true);
    expect(last.repeat).toBe("off");
  });
});
