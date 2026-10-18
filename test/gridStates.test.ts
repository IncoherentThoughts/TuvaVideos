// Grid states (sharing-spec §7.1, §7.2, §7.6): presence per Video, the "On this machine" chip, the source link, and the
// TV Server's exclusion of Not on this machine Videos from its lists.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { excludeNotHere, notHereVideoIds, tvListOf } from "../src/server/tvRoutes";
import { filterVideos, defaultLibraryState } from "../src/shared/libraryView";
import { isNotHere, showOnThisMachineChip, sourceLink, videoPresence } from "../src/shared/presence";
import type { VideoDto } from "../src/shared/types";
import { V, insertCopy, insertVideo } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const copy = (missing: boolean) => ({ missing });

describe("videoPresence (§7.1)", () => {
  test("an Available Copy plays", () => {
    expect(videoPresence({ available: true, copies: [copy(false)] })).toBe("available");
  });
  test("a Copy on an unmounted Root is Unmounted, as today", () => {
    expect(videoPresence({ available: false, copies: [copy(false)] })).toBe("unmounted");
    expect(videoPresence({ available: false, copies: [copy(true), copy(false)] })).toBe("unmounted");
  });
  test("no Copy row, or every Copy Missing, is Not on this machine", () => {
    expect(videoPresence({ available: false, copies: [] })).toBe("notHere");
    expect(videoPresence({ available: false, copies: [copy(true), copy(true)] })).toBe("notHere");
    expect(isNotHere({ available: false, copies: [] })).toBe(true);
    expect(isNotHere({ available: false, copies: [copy(false)] })).toBe(false);
  });
});

describe('"On this machine" chip (§7.2)', () => {
  const vids = (...avail: boolean[]) => avail.map((available) => ({ available }));
  test("hidden when it would select nothing, shown when some Video plays here", () => {
    expect(showOnThisMachineChip(vids(false, false), false)).toBe(false);
    expect(showOnThisMachineChip([], false)).toBe(false);
    expect(showOnThisMachineChip(null, false)).toBe(false);
    expect(showOnThisMachineChip(vids(false, true), false)).toBe(true);
  });
  test("stays while it is on, so it can be turned off", () => {
    expect(showOnThisMachineChip(vids(false), true)).toBe(true);
  });
  test("default off; when on it selects the Videos with an Available Copy (the #available set)", () => {
    const st = defaultLibraryState();
    expect(st.availableOnly).toBe(false);
    const all = [
      { id: "a", available: true },
      { id: "b", available: false },
    ].map((v) => ({ ...v, type: "song", favoritedAt: null, artists: [] }) as unknown as VideoDto);
    expect(filterVideos(all, st).map((v) => v.id)).toEqual(["a", "b"]);
    expect(filterVideos(all, { ...st, availableOnly: true }).map((v) => v.id)).toEqual(["a"]);
  });
});

describe("sourceLink (§7.1)", () => {
  test("YouTube, then Instagram, then Rutube; null when none is known", () => {
    expect(sourceLink({ youtubeId: "abc", instagramId: "x", rutubeId: "r" })?.href).toBe("https://www.youtube.com/watch?v=abc");
    expect(sourceLink({ youtubeId: null, instagramId: "Cx1", rutubeId: "r" })?.href).toBe("https://www.instagram.com/p/Cx1/");
    const ru = sourceLink({ youtubeId: null, instagramId: null, rutubeId: "0123abcd" });
    expect(ru).toEqual({ site: "Rutube", label: "rutube.ru/video/0123abcd/", href: "https://rutube.ru/video/0123abcd/" });
    expect(sourceLink({ youtubeId: null, instagramId: null, rutubeId: null })).toBeNull();
  });
});

describe("TV Server lists exclude Not on this machine (§7.6)", () => {
  test("the list routes", () => {
    expect(tvListOf("GET", "/api/videos")).toBe("videos");
    expect(tvListOf("HEAD", "/api/favorites")).toBe("favorites");
    expect(tvListOf("GET", "/api/search")).toBe("search");
    expect(tvListOf("GET", "/api/songs/00000000-0000-0000-0000-000000000000")).toBe("song");
    expect(tvListOf("GET", `/api/videos/${V(1)}`)).toBeNull();
    expect(tvListOf("POST", "/api/videos")).toBeNull();
  });

  test("the query: no Copy or every Copy Missing is excluded; an Unmounted Copy keeps its Video", () => {
    const db = openDb(":memory:", MIGRATIONS);
    db.query("INSERT INTO root (id, path, kind) VALUES (1, '/nowhere', 'external')").run();
    insertVideo(db, { id: 1, youtube_id: "yt1", title: "no copy" });
    insertVideo(db, { id: 2, youtube_id: "yt2", title: "missing" });
    insertCopy(db, { video_id: 2, root_id: 1, rel_path: "a.mp4", missing_since: "2026-10-01T00:00:00Z" });
    insertVideo(db, { id: 3, youtube_id: "yt3", title: "unmounted (Root not mounted)" });
    insertCopy(db, { video_id: 3, root_id: 1, rel_path: "b.mp4" });
    insertVideo(db, { id: 4, youtube_id: "yt4", title: "one missing, one present" });
    insertCopy(db, { video_id: 4, root_id: 1, rel_path: "c.mp4", missing_since: "2026-10-01T00:00:00Z" });
    insertCopy(db, { video_id: 4, root_id: 1, rel_path: "d.mp4" });
    expect([...notHereVideoIds(db)].sort()).toEqual([V(1), V(2)].sort());
  });

  const gone = new Set(["g"]);
  test("videos, favorites and a Song's videos", () => {
    expect(excludeNotHere("videos", [{ id: "g" }, { id: "k" }], gone)).toEqual([{ id: "k" }]);
    expect(excludeNotHere("favorites", [{ kind: "video", video: { id: "g" } }, { kind: "chapter", video: { id: "k" } }], gone)).toEqual([{ kind: "chapter", video: { id: "k" } }]);
    expect(excludeNotHere("song", { id: "s", videos: [{ id: "g" }, { id: "k" }] }, gone)).toEqual({ id: "s", videos: [{ id: "k" }] });
  });
  test("search: Video and Chapter rows go, a Song's Video list is trimmed, totals follow", () => {
    const body = {
      needle: "x",
      ms: 1,
      groups: [
        { key: "videos", label: "Videos", total: 3, rows: [{ kind: "video", id: "g" }, { kind: "chapter", id: "c1", videoId: "g" }, { kind: "video", id: "k" }] },
        { key: "songs", label: "Songs", total: 1, rows: [{ kind: "song", id: "s", videos: [{ id: "g", startS: null }, { id: "k", startS: 3 }] }] },
      ],
    };
    expect(excludeNotHere("search", body, gone)).toEqual({
      needle: "x",
      ms: 1,
      groups: [
        { key: "videos", label: "Videos", total: 1, rows: [{ kind: "video", id: "k" }] },
        { key: "songs", label: "Songs", total: 1, rows: [{ kind: "song", id: "s", videos: [{ id: "k", startS: 3 }] }] },
      ],
    });
  });
  test("nothing to exclude, or an unknown shape, passes through", () => {
    const b = [{ id: "g" }];
    expect(excludeNotHere("videos", b, new Set())).toBe(b);
    expect(excludeNotHere("search", { error: "x" }, gone)).toEqual({ error: "x" });
  });
});
