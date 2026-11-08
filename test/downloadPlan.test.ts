// The download plan (docs/downloader-spec.md §3.4, §6, §7.2): downloadable Videos, each tile's counts and estimates,
// the seeded Random pick, destination facts. Videos are given as the grid's JSON; reference sizes come from a real DB.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan, freeBytesAt, inRoot, isDownloadable, parsePlanRequest, pickRandom, type PlanEnv, type PlanVideo } from "../src/server/downloadPlan";
import { openDb } from "../src/server/db";
import { insertVideo } from "./helpers/seed";

const dir = mkdtempSync(join(tmpdir(), "tuva-plan-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const db = openDb(join(dir, "p.db"), join(import.meta.dir, "..", "migrations"));
const GB = 1e9;

const A1 = { id: "a1", name: "Ayan", nameLatin: null };
const A2 = { id: "a2", name: "Bata", nameLatin: null };
let seq = 0;
function mk(o: Partial<PlanVideo> & { ref?: Record<string, number> } = {}): PlanVideo {
  const { ref, ...rest } = o;
  const n = ++seq;
  const id = insertVideo(db, { title: `v${n}`, youtube_id: `yt${String(n).padStart(9, "0")}`, ...(ref ?? {}) });
  return {
    id, title: `v${n}`, type: "song", youtubeId: `yt${n}`, instagramId: null, rutubeId: null, favoritedAt: null, available: false,
    copies: [], artists: [], durationS: null, thumbnail: null, createdAt: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`, ...rest,
  };
}
const env = (videos: PlanVideo[], extra: Partial<PlanEnv> = {}): PlanEnv => ({
  db, videos, mountedRoots: ["/r1"], allRoots: ["/r1", "/r2"], newSeed: () => 7, freeBytes: async () => 50 * GB, ...extra,
});

describe("downloadable", () => {
  test("a source id and Not on this machine; hash-only, Available and unmounted Copies are out", () => {
    expect(isDownloadable(mk())).toBe(true);
    expect(isDownloadable(mk({ youtubeId: null, instagramId: "x" }))).toBe(true);
    expect(isDownloadable(mk({ youtubeId: null, rutubeId: "x" }))).toBe(true);
    expect(isDownloadable(mk({ youtubeId: null }))).toBe(false);
    expect(isDownloadable(mk({ available: true, copies: [{ missing: false }] }))).toBe(false);
    expect(isDownloadable(mk({ copies: [{ missing: false }] }))).toBe(false); // unmounted drive
    expect(isDownloadable(mk({ copies: [{ missing: true }] }))).toBe(true); // every Copy Missing
  });
});

describe("pickRandom", () => {
  const vs = Array.from({ length: 30 }, (_, i) => ({ id: `id${String(i).padStart(2, "0")}` }));
  test("same seed, same pick, whatever the input order", () => {
    const a = pickRandom(vs, 5, 42).map((v) => v.id);
    expect(pickRandom([...vs].reverse(), 5, 42).map((v) => v.id)).toEqual(a);
    expect(new Set(a).size).toBe(5);
  });
  test("another seed reshuffles; N past the pool returns all", () => {
    expect(pickRandom(vs, 5, 1).map((v) => v.id)).not.toEqual(pickRandom(vs, 5, 2).map((v) => v.id));
    expect(pickRandom(vs, 99, 1)).toHaveLength(30);
  });
});

describe("buildPlan", () => {
  const fav = mk({ favoritedAt: "2026-02-01T00:00:00Z", type: "concert", artists: [A1], ref: { size_bytes: 2 * GB, duration_s: 100, height: 1080 } });
  const ig = mk({ youtubeId: null, instagramId: "ig1", type: "interview", artists: [A1, A2], durationS: 800 });
  const none = mk({ type: "song", artists: [A2] });
  const here = mk({ available: true, copies: [{ missing: false }], favoritedAt: "2026-02-01T00:00:00Z", ref: { size_bytes: 9 * GB } });
  const hashOnly = mk({ youtubeId: null, favoritedAt: "2026-02-01T00:00:00Z", ref: { size_bytes: 9 * GB } });
  const all = [fav, ig, none, here, hashOnly];

  test("Full archive: counts, sizes, 'without an estimate', time at the assumed rate", async () => {
    const p = await buildPlan(env(all), { option: "full", quality: "1080p" });
    expect(p.videos.map((v) => v.id).sort()).toEqual([fav.id, ig.id, none.id].sort());
    // fav: 2 GB from its size; ig: 800 s x 2.5 Mbit/s = 250 MB; none: no estimate
    expect(p.totals).toEqual({ count: 3, estBytes: 2 * GB + 250e6, withoutEstimate: 1, estSeconds: Math.round((2 * GB + 250e6) / 2e6), throughputAssumed: true });
    expect(p.options.full).toEqual({ count: 3, estBytes: 2 * GB + 250e6, withoutEstimate: 1, estSeconds: p.totals.estSeconds });
    expect(p.instagramCount).toBe(1);
    expect(p.videos.find((v) => v.id === ig.id)).toMatchObject({ source: "instagram", estBytes: 250e6, artists: ["Ayan", "Bata"] });
  });

  test("quality changes every estimate", async () => {
    const p = await buildPlan(env(all), { option: "full", quality: "720p" });
    expect(p.totals.estBytes).toBe(1 * GB + 125e6);
    expect((await buildPlan(env(all), { option: "full", quality: "best" })).totals.estBytes).toBe(3.2 * GB + 400e6);
  });

  test("Favorites, By Type, By Artist each get their tile, whichever option is chosen", async () => {
    const p = await buildPlan(env(all), { option: "favorites", quality: "1080p", type: "interview", artistId: "a2" });
    expect(p.videos.map((v) => v.id)).toEqual([fav.id]);
    expect(p.options.favorites.count).toBe(1);
    expect(p.options.type.count).toBe(1); // interview: ig
    expect(p.options.artist.count).toBe(2); // Bata: ig, none
    expect(p.options.random.count).toBe(3);
    expect(p.type).toBe("interview");
    expect(p.artists).toEqual([{ id: "a1", name: "Ayan", count: 2 }, { id: "a2", name: "Bata", count: 2 }]);
    expect(p.types).toEqual([{ type: "song", count: 1 }, { type: "concert", count: 1 }, { type: "interview", count: 1 }]);
  });

  test("Random takes N with the seed echoed, and a reroll with the same seed reproduces it", async () => {
    const a = await buildPlan(env(all), { option: "random", quality: "1080p", n: 2, seed: 99 });
    const b = await buildPlan(env(all), { option: "random", quality: "1080p", n: 2, seed: 99 });
    expect(a.videos).toHaveLength(2);
    expect(a.seed).toBe(99);
    expect(b.videos.map((v) => v.id)).toEqual(a.videos.map((v) => v.id));
    const d = await buildPlan(env(all), { option: "random", quality: "1080p" });
    expect(d.n).toBe(20);
    expect(d.seed).toBe(7);
    expect(d.videos).toHaveLength(3);
  });

  test("defaults for the selects fall to the biggest choice; empty library has none", async () => {
    const p = await buildPlan(env(all), { option: "full", quality: "1080p" });
    expect(p.artistId).toBe("a1");
    const e = await buildPlan(env([]), { option: "type", quality: "1080p" });
    expect(e.type).toBeNull();
    expect(e.videos).toEqual([]);
    expect(e.totals.count).toBe(0);
  });

  test("a Video's stored duration is used when the Reference has none, poster and throughput", async () => {
    const v = mk({ thumbnail: { poster: "/thumbs/x/poster.webp?v=1" }, durationS: 80 });
    db.query("INSERT OR REPLACE INTO download_setting (key, value) VALUES ('last_throughput_bps', '25000000')").run();
    try {
      const p = await buildPlan(env([v]), { option: "full", quality: "1080p" });
      expect(p.videos[0]).toMatchObject({ posterUrl: "/thumbs/x/poster.webp?v=1", estBytes: 25e6, durationS: 80 });
      expect(p.totals).toMatchObject({ estSeconds: 1, throughputAssumed: false });
      expect(p.throughputBps).toBe(25e6);
    } finally {
      db.query("DELETE FROM download_setting WHERE key = 'last_throughput_bps'").run();
    }
  });

  test("destination: default is the first mounted Root, in Root, free space; a folder outside every Root is not", async () => {
    const p = await buildPlan(env(all), { option: "full", quality: "1080p" });
    expect(p).toMatchObject({ destDir: "/r1", destInRoot: true, freeBytes: 50 * GB });
    const q = await buildPlan(env(all), { option: "full", quality: "1080p", destDir: "/elsewhere" });
    expect(q).toMatchObject({ destDir: "/elsewhere", destInRoot: false });
    const none = await buildPlan(env(all, { mountedRoots: [] }), { option: "full", quality: "1080p" });
    expect(none).toMatchObject({ destDir: null, freeBytes: null, destInRoot: false });
  });
});

test("inRoot", () => {
  expect(inRoot("/r1", ["/r1"])).toBe(true);
  expect(inRoot("/r1/sub/deep", ["/r1"])).toBe(true);
  expect(inRoot("/r1/../r2", ["/r1"])).toBe(false);
  expect(inRoot("/r10", ["/r1"])).toBe(false);
  expect(inRoot("/r1/", ["/r1"])).toBe(true);
});

test("freeBytesAt reads the volume of the nearest existing folder", async () => {
  const f = await freeBytesAt(join(dir, "not", "made", "yet"));
  expect(f).toBeGreaterThan(0);
});

describe("parsePlanRequest", () => {
  test("accepts a good body and keeps what was given", () => {
    expect(parsePlanRequest({ option: "random", quality: "best", n: 5, seed: 3, destDir: "/x" })).toEqual({ option: "random", quality: "best", n: 5, seed: 3, destDir: "/x" });
  });
  test("refuses the rest with a message", () => {
    for (const b of [{}, { option: "all", quality: "1080p" }, { option: "full" }, { option: "full", quality: "1080p", n: 0 }, { option: "full", quality: "1080p", n: 1.5 },
      { option: "full", quality: "1080p", seed: "1" }, { option: "type", quality: "1080p", type: "film" }, { option: "full", quality: "1080p", destDir: "rel" }, { option: "full", quality: "1080p", artistId: "" }])
      expect(typeof parsePlanRequest(b)).toBe("string");
  });
});
