import { describe, expect, test } from "bun:test";
import { BINDINGS } from "../src/shared/keyguide";
import { keyAction, dispatchKey, isRepeatable } from "../src/shared/keymap";
import { current, cycleRepeat, startPlaylist, type Entry, type Playlist } from "../src/shared/playlist";
import {
  entryRange, libraryPlaylist, nextEntry, openAt, playlistFor, prevEntry, reachedEnd, repeatIcon, resumeAllowed, seekWidens, toggleShuffle,
} from "../src/shared/playlistPlayer";

const videos = (...ids: number[]): Entry[] => ids.map((videoId) => ({ videoId }));
const seqPl = (entries: Entry[], startAt = 0): Playlist => startPlaylist(entries, { source: "library", shuffled: false, startAt });
const ids = (pl: Playlist) => pl.order.map((i) => pl.entries[i]!.videoId);

describe("Playlist keys (spec 4.8)", () => {
  test("n N x e q map to Playlist actions", () => {
    expect(keyAction({ key: "n" })).toEqual({ type: "playlist", op: "next" });
    expect(keyAction({ key: "N", shiftKey: true })).toEqual({ type: "playlist", op: "prev" });
    expect(keyAction({ key: "x" })).toEqual({ type: "playlist", op: "shuffle" });
    expect(keyAction({ key: "e" })).toEqual({ type: "playlist", op: "repeat" });
    expect(keyAction({ key: "q" })).toEqual({ type: "playlist", op: "panel" });
  });
  test("chords are not ours and a held key does not repeat", () => {
    expect(keyAction({ key: "n", metaKey: true })).toBeNull();
    expect(keyAction({ key: "x", ctrlKey: true })).toBeNull();
    expect(isRepeatable({ type: "playlist", op: "next" })).toBe(false);
    expect(dispatchKey({ key: "n", repeat: true }, { containerFocused: true })).toEqual({ action: null, handled: true });
    expect(dispatchKey({ key: "n" }, { containerFocused: false }).handled).toBe(false);
  });
  test("< > stay Video steps; the Player routes them to Entries when a Playlist is active", () => {
    expect(keyAction({ key: "<", shiftKey: true })).toEqual({ type: "video", dir: -1 });
    expect(keyAction({ key: ">", shiftKey: true })).toEqual({ type: "video", dir: 1 });
  });
});

describe("the State panel key guide matches keyAction", () => {
  const NAMED: Record<string, string> = { space: " ", "←": "ArrowLeft", "→": "ArrowRight", "↑": "ArrowUp", "↓": "ArrowDown", "⌫": "Backspace", PgUp: "PageUp", PgDn: "PageDown" };
  const guided = new Set(BINDINGS.flatMap(([ks]) => ks.map((k) => (k.startsWith("⇧") ? NAMED[k.slice(1)]! : (NAMED[k] ?? k)))));
  // keys the page (keys.ts, Esc) handles rather than keyAction
  const PAGE_KEYS = ["Esc", "v", "r", "/"];

  test("every key keyAction binds is listed in the guide", () => {
    const candidates = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789,.[]{}!@<>/ "] .concat(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace", "PageUp", "PageDown", "Enter", "Tab", "Escape"]);
    const bound = candidates.filter((k) => keyAction({ key: k }) !== null);
    expect(bound.length).toBeGreaterThan(30);
    for (const k of bound) expect(guided.has(k)).toBe(true);
  });
  test("every key the guide lists is bound (or a page key)", () => {
    for (const k of guided) if (!PAGE_KEYS.includes(k)) expect(keyAction({ key: k, shiftKey: k.length === 1 && k !== k.toLowerCase() })).not.toBeNull();
    for (const k of ["n", "N", "x", "e", "q"]) expect(guided.has(k)).toBe(true);
  });
});

describe("entryRange", () => {
  const chapters = [{ id: 1, startS: 10 }, { id: 2, startS: 60 }, { id: 3, startS: 120 }];
  test("a Video Entry plays the whole Video", () => {
    expect(entryRange({ videoId: 1 }, chapters, 200)).toEqual({ start: 0, end: null });
    expect(entryRange(null, chapters, 200)).toEqual({ start: 0, end: null });
  });
  test("a Chapter Entry runs to the next Chapter's start, or the Video's end", () => {
    expect(entryRange({ videoId: 1, chapterId: 2 }, chapters, 200)).toEqual({ start: 60, end: 120 });
    expect(entryRange({ videoId: 1, chapterId: 1 }, [...chapters].reverse(), 200)).toEqual({ start: 10, end: 60 });
    expect(entryRange({ videoId: 1, chapterId: 3 }, chapters, 200)).toEqual({ start: 120, end: 200 });
    expect(entryRange({ videoId: 1, chapterId: 3 }, chapters, null)).toEqual({ start: 120, end: null });
  });
  test("a deleted Chapter plays as the Video", () => {
    expect(entryRange({ videoId: 1, chapterId: 99 }, chapters, 200)).toEqual({ start: 0, end: null });
  });
  test("end detection and widening", () => {
    const r = { start: 60, end: 120 };
    expect(reachedEnd(r, 119.9)).toBe(false);
    expect(reachedEnd(r, 120)).toBe(true);
    expect(seekWidens(r, 150)).toBe(true);
    expect(seekWidens(r, 90)).toBe(false);
    expect(seekWidens({ start: 0, end: null }, 9999)).toBe(false);
  });
});

describe("Resume is suppressed inside a Playlist", () => {
  test("an Entry opens at the start, not the Resume position", () => {
    expect(openAt({ t: null, resumeS: 300, durationS: 1000 }, false)).toBe(300);
    expect(openAt({ t: null, resumeS: 300, durationS: 1000 }, true)).toBe(0);
  });
  test("a Chapter Entry opens at its Chapter start (the ?t=)", () => {
    expect(openAt({ t: 60, resumeS: 300, durationS: 1000 }, true)).toBe(60);
  });
  test("no Resume writes while a Playlist is active", () => {
    expect(resumeAllowed(true)).toBe(false);
    expect(resumeAllowed(false)).toBe(true);
  });
});

describe("nextEntry / prevEntry", () => {
  test("Repeat one restarts at the end but `n` still advances", () => {
    const pl = { ...seqPl(videos(1, 2, 3)), repeat: "one" as const };
    expect(nextEntry(pl, "end").kind).toBe("restart");
    const k = nextEntry(pl, "key");
    expect(k.kind).toBe("move");
    expect(current(k.pl)?.videoId).toBe(2);
  });
  test("end advances and skips unavailable Videos", () => {
    const m = nextEntry(seqPl(videos(1, 2, 3)), "end", (id) => id !== 2);
    expect(m.kind).toBe("move");
    expect(current(m.pl)?.videoId).toBe(3);
  });
  test("Repeat off at the end: the end reports ended, `n` does nothing, `N` goes back", () => {
    const at = nextEntry(seqPl(videos(1, 2)), "key").pl; // now on Video 2, nothing after
    expect(current(at)?.videoId).toBe(2);
    expect(nextEntry(at, "end").kind).toBe("ended");
    expect(nextEntry(at, "key").kind).toBe("none");
    expect(nextEntry(at, "key").pl).toBe(at);
    expect(current(prevEntry(at)!)?.videoId).toBe(1);
    expect(prevEntry(seqPl(videos(1, 2)))).toBeNull();
  });
  test("Repeat list wraps; a one-Entry list restarts in place", () => {
    const wrap = nextEntry({ ...seqPl(videos(1, 2), 1), repeat: "list" }, "end");
    expect(wrap.kind).toBe("move");
    const solo = nextEntry({ ...seqPl(videos(7)), repeat: "list" }, "end");
    expect(solo.kind).toBe("restart");
  });
  test("a Chapter Entry advances to the next Entry", () => {
    const pl = seqPl([{ videoId: 1, chapterId: 5 }, { videoId: 1, chapterId: 6 }]);
    expect(current(nextEntry(pl, "end").pl)).toEqual({ videoId: 1, chapterId: 6 });
  });
});

describe("icons and shortcuts", () => {
  test("repeat shows one and is disabled with no Playlist; else it follows the mode", () => {
    expect(repeatIcon(null)).toEqual({ mode: "one", disabled: true });
    const pl = seqPl(videos(1, 2));
    expect(repeatIcon(pl)).toEqual({ mode: "off", disabled: false });
    expect(repeatIcon(cycleRepeat(pl))).toEqual({ mode: "list", disabled: false });
  });
  test("x with none active starts a whole-library Playlist at the current Video, shuffled", () => {
    const pl = libraryPlaylist([5, 6, 7, 8], 7)!;
    expect(pl.source).toBe("library-all");
    expect(pl.shuffled).toBe(true);
    expect(current(pl)?.videoId).toBe(7);
    expect(ids(pl).sort()).toEqual([5, 6, 7, 8]);
    expect(libraryPlaylist([5, 6], 99)).toBeNull();
  });
  test("x with one active toggles the Play order", () => {
    const pl = seqPl(videos(1, 2, 3));
    expect(toggleShuffle(pl).shuffled).toBe(true);
    expect(toggleShuffle(toggleShuffle(pl)).shuffled).toBe(false);
  });
  test("a Playlist only applies to the Video its current Entry is for", () => {
    const pl = seqPl(videos(1, 2));
    expect(playlistFor(pl, 1)).toBe(pl);
    expect(playlistFor(pl, 2)).toBeNull();
    expect(playlistFor(null, 1)).toBeNull();
  });
});

describe("OSD wording", () => {
  test("one phrasing per action", async () => {
    const m = await import("../src/shared/playlistPlayer");
    const { startPlaylist } = await import("../src/shared/playlist");
    const pl = startPlaylist([{ videoId: 1 }, { videoId: 2 }], { source: "library", shuffled: false, startAt: 0 });
    expect(m.shuffleLabel(pl)).toBe("Shuffle off");
    expect(m.shuffleLabel({ ...pl, shuffled: true })).toBe("Shuffle on");
    expect(m.shuffleStartLabel(2157)).toBe("Shuffle on · Playlist of 2157");
    for (const r of ["off", "list", "one"] as const) expect(m.repeatLabel({ ...pl, repeat: r })).toBe(`Repeat: ${r}`);
    expect(m.nextLabel("A")).toBe("Next: A");
    expect(m.prevLabel("A")).toBe("Previous: A");
    expect(m.ENDED_LABEL).toBe("Playlist ended");
  });
});

describe("README key table", () => {
  test("lists every key of the State panel guide", async () => {
    const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
    const table = readme.slice(readme.indexOf("## Player keys"), readme.indexOf("## One-off commands"));
    for (const [keys] of BINDINGS) for (const k of keys) expect(table).toContain(`\`${k}\``);
  });
});
