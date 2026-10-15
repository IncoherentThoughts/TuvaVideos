import { describe, expect, test } from "bun:test";
import { advance, startPlaylist } from "../src/shared/playlist";
import { panelRows, showPlayedFor, toggleShowPlayed } from "../src/shared/playlistPanel";

const entries = [1, 2, 3, 4].map((videoId) => ({ videoId }));
const seq = () => startPlaylist(entries, { source: "library", shuffled: false, startAt: 0 });

describe("panelRows", () => {
  test("hides Played by default: current first, then upcoming in Play order", () => {
    let pl = seq();
    pl = advance(pl).pl;
    expect(panelRows(pl, false)).toEqual([
      { kind: "current", entryIndex: 1 },
      { kind: "upcoming", entryIndex: 2 },
      { kind: "upcoming", entryIndex: 3 },
    ]);
  });
  test("show played lists Played above the current one in the order played", () => {
    let pl = seq();
    pl = advance(advance(pl).pl).pl;
    expect(panelRows(pl, true).map((r) => `${r.kind}:${r.entryIndex}`)).toEqual(["played:0", "played:1", "current:2", "upcoming:3"]);
  });
  test("an empty Playlist has no rows", () => {
    expect(panelRows(startPlaylist([], { source: "library" }), true)).toEqual([]);
  });
});

describe("show played", () => {
  test("resets whenever a new Playlist starts", () => {
    let s = { gen: 1, on: false };
    s = toggleShowPlayed(s, 1);
    expect(showPlayedFor(s, 1)).toBe(true);
    expect(showPlayedFor(s, 2)).toBe(false);
    s = toggleShowPlayed(s, 2); // turning it on under the new Playlist, not off
    expect(showPlayedFor(s, 2)).toBe(true);
    expect(showPlayedFor(toggleShowPlayed(s, 2), 2)).toBe(false);
  });
});
