import { beforeEach, describe, expect, test } from "bun:test";
import {
  advance, current, cycleRepeat, isPlaylist, jumpTo, jumpToVideo, played, position, setShuffled, shuffle, startPlaylist, stepBack, upcoming,
  widenToVideo, type Entry, type Playlist,
} from "../src/shared/playlist";

/** A deterministic rng: returns the given fractions in turn, then 0. */
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++] ?? 0;
};
/** rng() = 0 makes Fisher–Yates rotate: [a, b, c, d] → [b, c, d, a]. */
const zero = () => 0;
/** rng() just under 1 leaves Fisher–Yates with the identity. */
const one = () => 0.999999;

const videos = (...ids: number[]): Entry[] => ids.map((videoId) => ({ videoId }));
const ids = (pl: Playlist, idx: number[]) => idx.map((i) => pl.entries[i]!.videoId);
const seqOf = (pl: Playlist) => pl.order.map((i) => pl.entries[i]!.videoId);

describe("startPlaylist", () => {
  test("shuffled by default, Repeat off, the chosen Entry first and nothing Played", () => {
    const pl = startPlaylist(videos(10, 11, 12, 13), { source: "library", startAt: 2, rng: one });
    expect(pl.shuffled).toBe(true);
    expect(pl.repeat).toBe("off");
    expect(pl.cursor).toBe(0);
    expect(current(pl)).toEqual({ videoId: 12 });
    expect(played(pl)).toEqual([]);
    expect(seqOf(pl)).toEqual([12, 10, 11, 13]);
    expect(position(pl)).toEqual({ n: 1, total: 4 });
  });

  test("the rest is a permutation driven by the rng", () => {
    const pl = startPlaylist(videos(10, 11, 12, 13), { source: "search", startAt: 0, rng: zero });
    expect(seqOf(pl)).toEqual([10, 12, 13, 11]);
  });

  test("a random first Entry when startAt is omitted", () => {
    const pl = startPlaylist(videos(10, 11, 12, 13), { source: "favorites", rng: seq(0.6, 0.99, 0.99, 0.99) });
    expect(current(pl)?.videoId).toBe(12);
  });

  test("sequential runs in source order from the first Entry on, wrapping", () => {
    const pl = startPlaylist(videos(10, 11, 12, 13), { source: "library-all", shuffled: false, startAt: 2 });
    expect(seqOf(pl)).toEqual([12, 13, 10, 11]);
  });

  test("Chapter Entries and repeated Videos are kept as given", () => {
    const entries: Entry[] = [{ videoId: 5 }, { videoId: 5, chapterId: 7 }, { videoId: 6, chapterId: 8 }];
    const pl = startPlaylist(entries, { source: "favorites", shuffled: false, startAt: 0 });
    expect(pl.entries).toEqual(entries);
    expect(pl.entries).not.toBe(entries);
  });

  test("an empty Playlist is empty, not broken", () => {
    const pl = startPlaylist([], { source: "library" });
    expect(current(pl)).toBeNull();
    expect(advance(pl)).toEqual({ pl, ended: true });
    expect(stepBack(pl)).toBe(pl);
    expect(position(pl)).toEqual({ n: 0, total: 0 });
  });

  test("startAt out of range is clamped", () => {
    expect(current(startPlaylist(videos(1, 2), { source: "library", startAt: 9 }))?.videoId).toBe(2);
    expect(current(startPlaylist(videos(1, 2), { source: "library", startAt: -1 }))?.videoId).toBe(1);
  });
});

describe("shuffle", () => {
  test("is a permutation that leaves the input alone", () => {
    const xs = [1, 2, 3, 4, 5];
    const out = shuffle(xs, zero);
    expect(out).toEqual([2, 3, 4, 5, 1]);
    expect(xs).toEqual([1, 2, 3, 4, 5]);
    expect([...shuffle(xs, Math.random)].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("advance and stepBack", () => {
  const four = () => startPlaylist(videos(10, 11, 12, 13), { source: "library", shuffled: false, startAt: 0 });

  test("walks the Play order; what it passes is Played", () => {
    let pl = four();
    ({ pl } = advance(pl));
    expect(current(pl)?.videoId).toBe(11);
    expect(ids(pl, played(pl))).toEqual([10]);
    expect(ids(pl, upcoming(pl))).toEqual([12, 13]);
    expect(position(pl)).toEqual({ n: 2, total: 4 });
  });

  test("skips unavailable Entries, which count as Played", () => {
    let pl = four();
    const r = advance(pl, (id) => id !== 11 && id !== 12);
    expect(current(r.pl)?.videoId).toBe(13);
    expect(ids(r.pl, played(r.pl))).toEqual([10, 11, 12]);
    pl = stepBack(r.pl, (id) => id !== 11 && id !== 12);
    expect(current(pl)?.videoId).toBe(10);
  });

  test("Repeat off: ends at the last Entry and stays there; stepping back still works", () => {
    let pl = four();
    pl = jumpTo(pl, 3);
    const r = advance(pl);
    expect(r.ended).toBe(true);
    expect(r.pl).toBe(pl);
    expect(current(stepBack(pl))?.videoId).toBe(12);
  });

  test("Repeat off: ended when nothing after the cursor is playable", () => {
    const pl = four();
    expect(advance(pl, (id) => id === 10).ended).toBe(true);
  });

  test("Repeat list, sequential: wraps to the first playable Entry", () => {
    let pl = cycleRepeat(cycleRepeat(cycleRepeat(cycleRepeat(four())))); // off → list → one → off → list
    expect(pl.repeat).toBe("list");
    pl = jumpTo(pl, 3);
    const r = advance(pl, (id) => id !== 10);
    expect(r.ended).toBe(false);
    expect(current(r.pl)?.videoId).toBe(11);
    expect(seqOf(r.pl)).toEqual([10, 11, 12, 13]);
    expect(ids(r.pl, played(r.pl))).toEqual([10]);
  });

  test("Repeat list, shuffled: wrapping reshuffles the whole list", () => {
    let pl = startPlaylist(videos(10, 11, 12, 13), { source: "library", startAt: 0, rng: one });
    pl = cycleRepeat(pl);
    pl = jumpTo(pl, 3);
    const r = advance(pl, () => true, zero);
    expect(r.ended).toBe(false);
    expect(seqOf(r.pl)).toEqual([11, 12, 13, 10]);
    expect(r.pl.cursor).toBe(0);
    expect(played(r.pl)).toEqual([]);
  });

  test("Repeat list with nothing playable at all: ended, unchanged", () => {
    const pl = cycleRepeat(four());
    const r = advance(pl, () => false);
    expect(r).toEqual({ pl, ended: true });
  });

  test("Repeat one is not advance's job: it steps on like any other", () => {
    const pl = cycleRepeat(cycleRepeat(four()));
    expect(pl.repeat).toBe("one");
    expect(current(advance(pl).pl)?.videoId).toBe(11);
  });

  test("stepBack at the first Entry stays put, except Repeat list wraps to the end", () => {
    const pl = four();
    expect(stepBack(pl)).toBe(pl);
    const wrapped = stepBack(cycleRepeat(pl), (id) => id !== 13);
    expect(current(wrapped)?.videoId).toBe(12);
  });
});

describe("setShuffled", () => {
  const start = () => {
    let pl = startPlaylist(videos(10, 11, 12, 13, 14), { source: "library", shuffled: false, startAt: 0 });
    ({ pl } = advance(pl));
    return pl; // Played [10], current 11, upcoming [12, 13, 14]
  };

  test("on: reshuffles only the upcoming Entries", () => {
    const pl = setShuffled(start(), true, zero);
    expect(pl.shuffled).toBe(true);
    expect(seqOf(pl)).toEqual([10, 11, 13, 14, 12]);
    expect(pl.cursor).toBe(1);
  });

  test("on again: reshuffles upcoming again, Played keeps its order", () => {
    let pl = setShuffled(start(), true, zero);
    pl = setShuffled(pl, true, zero);
    expect(seqOf(pl)).toEqual([10, 11, 14, 12, 13]);
  });

  test("off: upcoming back in source order from the current Entry on, wrapping", () => {
    let pl = startPlaylist(videos(10, 11, 12, 13, 14), { source: "library", startAt: 3, rng: zero });
    expect(seqOf(pl)).toEqual([13, 11, 12, 14, 10]);
    ({ pl } = advance(pl)); // Played [13], current 11
    pl = setShuffled(pl, false);
    expect(pl.shuffled).toBe(false);
    expect(seqOf(pl)).toEqual([13, 11, 12, 14, 10]);
    expect(ids(pl, upcoming(pl))).toEqual([12, 14, 10]);
  });
});

describe("cycleRepeat", () => {
  test("off → list → one → off", () => {
    let pl = startPlaylist(videos(1), { source: "library" });
    expect(pl.repeat).toBe("off");
    pl = cycleRepeat(pl);
    expect(pl.repeat).toBe("list");
    pl = cycleRepeat(pl);
    expect(pl.repeat).toBe("one");
    pl = cycleRepeat(pl);
    expect(pl.repeat).toBe("off");
  });
});

describe("jumpTo and jumpToVideo", () => {
  const entries: Entry[] = [{ videoId: 10 }, { videoId: 11, chapterId: 1 }, { videoId: 12 }, { videoId: 11, chapterId: 2 }, { videoId: 13 }];
  const pl = startPlaylist(entries, { source: "favorites", shuffled: false, startAt: 0 });

  test("jumpTo an upcoming Entry makes the ones before it Played; to a Played one reopens the rest", () => {
    const fwd = jumpTo(pl, 3);
    expect(current(fwd)).toEqual({ videoId: 11, chapterId: 2 });
    expect(played(fwd)).toEqual([0, 1, 2]);
    const back = jumpTo(fwd, 1);
    expect(played(back)).toEqual([0]);
    expect(upcoming(back)).toEqual([2, 3, 4]);
    expect(jumpTo(pl, 99)).toBe(pl);
  });

  test("jumpToVideo picks the first upcoming occurrence", () => {
    const at2 = jumpTo(pl, 2);
    expect(current(jumpToVideo(at2, 11)!)).toEqual({ videoId: 11, chapterId: 2 });
  });

  test("…else the first in Play order, the current one included", () => {
    const at4 = jumpTo(pl, 4);
    expect(current(jumpToVideo(at4, 11)!)).toEqual({ videoId: 11, chapterId: 1 });
    expect(jumpToVideo(at4, 13)!.cursor).toBe(4);
  });

  test("null for a Video outside the Playlist", () => {
    expect(jumpToVideo(pl, 99)).toBeNull();
  });
});

describe("widenToVideo", () => {
  test("a Chapter Entry that ran past its end becomes a Video Entry; others untouched", () => {
    let pl = startPlaylist([{ videoId: 5, chapterId: 7 }, { videoId: 6, chapterId: 8 }], { source: "favorites", shuffled: false, startAt: 0 });
    const w = widenToVideo(pl);
    expect(current(w)).toEqual({ videoId: 5 });
    expect(w.entries[1]).toEqual({ videoId: 6, chapterId: 8 });
    expect(pl.entries[0]).toEqual({ videoId: 5, chapterId: 7 });
  });

  test("a Video Entry is left as is", () => {
    const pl = startPlaylist(videos(5), { source: "library" });
    expect(widenToVideo(pl)).toBe(pl);
  });
});

describe("isPlaylist", () => {
  const good = startPlaylist(videos(1, 2, 3), { source: "search", startAt: 0 });

  test("accepts what startPlaylist makes, through JSON", () => {
    expect(isPlaylist(JSON.parse(JSON.stringify(good)))).toBe(true);
    expect(isPlaylist(startPlaylist([], { source: "library" }))).toBe(true);
  });

  test("rejects the wrong shape", () => {
    expect(isPlaylist(null)).toBe(false);
    expect(isPlaylist({ ...good, source: "queue" })).toBe(false);
    expect(isPlaylist({ ...good, repeat: "loop" })).toBe(false);
    expect(isPlaylist({ ...good, order: [0, 0, 1] })).toBe(false);
    expect(isPlaylist({ ...good, order: [0, 1] })).toBe(false);
    expect(isPlaylist({ ...good, cursor: 3 })).toBe(false);
    expect(isPlaylist({ ...good, entries: [{ videoId: "1" }, { videoId: 2 }, { videoId: 3 }] })).toBe(false);
  });
});

describe("web store", () => {
  const fake = new Map<string, string>();
  const storage = {
    getItem: (k: string) => fake.get(k) ?? null,
    setItem: (k: string, v: string) => void fake.set(k, v),
    removeItem: (k: string) => void fake.delete(k),
  };
  let store: typeof import("../src/web/playlist");

  beforeEach(async () => {
    fake.clear();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = storage;
    // A fresh module each time: the store caches in memory.
    store = await import(`../src/web/playlist.ts?${Math.random()}`);
  });

  test("nothing stored → null", () => {
    expect(store.loadPlaylist()).toBeNull();
  });

  test("start writes tuva.playlist and notifies; load reads it back after a reload", async () => {
    let calls = 0;
    store.onPlaylistChange(() => calls++);
    const pl = store.startPlaylist(videos(1, 2, 3), { source: "library", startAt: 0 });
    expect(calls).toBe(1);
    expect(JSON.parse(fake.get("tuva.playlist")!)).toEqual(pl);
    const again: typeof store = await import(`../src/web/playlist.ts?${Math.random()}`);
    expect(again.loadPlaylist()).toEqual(pl);
  });

  test("update stores a transition's result; the same value is a no-op", () => {
    let calls = 0;
    const pl = store.startPlaylist(videos(1, 2, 3), { source: "library", startAt: 0 });
    store.onPlaylistChange(() => calls++);
    store.updatePlaylist(pl);
    expect(calls).toBe(0);
    const next = advance(pl).pl;
    store.updatePlaylist(next);
    expect(calls).toBe(1);
    expect(store.loadPlaylist()).toBe(next);
    expect(JSON.parse(fake.get("tuva.playlist")!).cursor).toBe(1);
  });

  test("end clears memory and storage, and only notifies when there was one", () => {
    let calls = 0;
    store.onPlaylistChange(() => calls++);
    store.endPlaylist();
    expect(calls).toBe(0);
    store.startPlaylist(videos(1), { source: "library" });
    store.endPlaylist();
    expect(calls).toBe(2);
    expect(store.loadPlaylist()).toBeNull();
    expect(fake.has("tuva.playlist")).toBe(false);
  });

  test("garbage in storage loads as null", () => {
    fake.set("tuva.playlist", "{nope");
    expect(store.loadPlaylist()).toBeNull();
    fake.set("tuva.playlist", JSON.stringify({ source: "library", entries: [], order: [1], cursor: 0, shuffled: true, repeat: "off" }));
    expect(store.loadPlaylist()).toBeNull();
  });
});
