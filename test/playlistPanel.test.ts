import { describe, expect, test } from "bun:test";
import { advance, startPlaylist } from "../src/shared/playlist";
import { panelRows, showPlayedFor, toggleShowPlayed } from "../src/shared/playlistPanel";

const entries = [1, 2, 3, 4].map((n) => ({ videoId: String(n) }));
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

import { cycleRepeat, jumpTo } from "../src/shared/playlist";
import { endedShows, markEnded, panelWindow } from "../src/shared/playlistPanel";

const big = (n: number) => startPlaylist(Array.from({ length: n }, (_, i) => ({ videoId: String(i + 1) })), { source: "library-all", shuffled: false, startAt: 0 });

describe("panelWindow", () => {
  test("renders a window of upcoming rows below the current one, and says how many are hidden", () => {
    const w = panelWindow(big(2000), false, 25, 25);
    expect(w.rows.length).toBe(26);
    expect(w.rows[0]).toEqual({ kind: "current", entryIndex: 0 });
    expect(w.hiddenUpcoming).toBe(2000 - 26);
    expect(w.hiddenPlayed).toBe(0);
  });
  test("show played windows from the bottom: the last Played rows next to the current one, never all 2000", () => {
    const pl = jumpTo(big(2000), 1500);
    const w = panelWindow(pl, true, 25, 25);
    expect(w.rows.map((r) => r.kind).join()).toBe([...Array(25).fill("played"), "current", ...Array(25).fill("upcoming")].join());
    expect(w.rows[24]).toEqual({ kind: "played", entryIndex: 1499 }); // nearest the current row
    expect(w.rows[0]!.entryIndex).toBe(1475);
    expect(w.hiddenPlayed).toBe(1475);
    expect(w.hiddenUpcoming).toBe(2000 - 1501 - 25);
  });
  test("the current row is always in, and with the window grown to cover it all it equals panelRows", () => {
    const pl = jumpTo(big(100), 40);
    expect(panelWindow(pl, true, 0, 0).rows).toEqual([{ kind: "current", entryIndex: 40 }]);
    expect(panelWindow(pl, true, 999, 999).rows).toEqual(panelRows(pl, true));
  });
  test("whole-library Playlist of 2000: building the rows is cheap", () => {
    const pl = jumpTo(big(2000), 1000);
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) panelWindow(pl, true, 25, 25);
    const windowed = (performance.now() - t0) / 100;
    const t1 = performance.now();
    const all = panelRows(pl, true);
    const full = performance.now() - t1;
    console.log(`panelWindow 51 rows: ${windowed.toFixed(3)} ms; panelRows ${all.length} rows: ${full.toFixed(3)} ms`);
    expect(all.length).toBe(2000);
    expect(windowed).toBeLessThan(5);
    expect(full).toBeLessThan(50);
  });
});

describe("Playlist ended", () => {
  const last = () => jumpTo(big(3), 2);
  test("shows on the last Entry with Repeat off once the Player marked it", () => {
    const pl = last();
    expect(endedShows(null, pl, 1)).toBe(false);
    expect(endedShows(markEnded(pl, 1), pl, 1)).toBe(true);
  });
  test("clears when the cursor moves, Repeat changes, or a new Playlist starts", () => {
    const pl = last();
    const m = markEnded(pl, 1);
    expect(endedShows(m, jumpTo(pl, 0), 1)).toBe(false);
    expect(endedShows(m, cycleRepeat(pl), 1)).toBe(false);
    expect(endedShows(m, pl, 2)).toBe(false);
  });
  test("never shows away from the end of the list", () => {
    const pl = jumpTo(big(3), 1);
    expect(endedShows(markEnded(pl, 1), pl, 1)).toBe(false);
  });
});
