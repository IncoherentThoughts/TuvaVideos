// scripts/seed-shared.ts (ticket #132, sharing-spec §9.1): clip names the scan parses back, the plan built from a
// fixture of archive rows (call shapes of §4.1), the manifest round-trip and the argument guards. No network, no ffmpeg.
import { describe, expect, test } from "bun:test";
import { editBelongsTo, OPS, STAMP_REQUIRED, type WriteFunction, type WriteResult } from "../src/shared/archiveWire";
import { parseFilename } from "../src/server/filename";
import { assertTestEmail, assertTestRoot, parseArgs } from "../scripts/seed-shared";
import {
  buildSeedPlan, clipFileName, emptyManifest, fakeRutubeId, fakeYoutubeId, ffmpegArgs, parseManifest, PENDING_HASH, pickArchiveRows,
  planIsComplete, posterPath, PURGE_ORDER, recordResult, seedClips, serializeManifest, type ArchiveSnapshot, type RpcStep,
} from "../scripts/seed/plan";
import fixture from "./fixtures/seed-archive.json";

const archive = fixture as ArchiveSnapshot;
const counter = () => {
  let n = 0;
  return () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`;
};
const allHashes = () => Object.fromEntries(seedClips().map((c, i) => [c.file, i.toString(16).padStart(64, "a")]));

describe("clip names", () => {
  test("fake ids fit the scan's patterns", () => {
    expect(fakeYoutubeId(1)).toBe("zzTest00001");
    expect(fakeYoutubeId(1)).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(fakeRutubeId(1)).toMatch(/^[0-9a-f]{32}$/);
    expect(fakeRutubeId(1)).not.toBe(fakeRutubeId(2));
    expect(() => fakeYoutubeId(100000)).toThrow();
  });

  test("every seed clip parses back to its title and id", () => {
    const clips = seedClips();
    expect(new Set(clips.map((c) => c.file)).size).toBe(clips.length);
    for (const c of clips) {
      const p = parseFilename(c.file);
      expect(p.skip).toBeNull();
      expect(p.ext).toBe(c.ext);
      expect(p.title).toBe(c.title);
      expect(p.youtubeId).toBe(c.youtubeId);
      expect(p.instagramId).toBe(c.instagramId);
      expect(p.rutubeId).toBe(c.rutubeId);
      expect(c.durationS).toBeGreaterThanOrEqual(3);
      expect(c.durationS).toBeLessThanOrEqual(8);
    }
  });

  test("the mix the spec asks for: all three containers, Instagram, Rutube, id-less, Cyrillic titles", () => {
    const clips = seedClips();
    expect(new Set(clips.map((c) => c.ext))).toEqual(new Set(["mp4", "mkv", "webm"]));
    expect(clips.filter((c) => c.instagramId).length).toBeGreaterThanOrEqual(2);
    expect(clips.filter((c) => c.rutubeId).length).toBeGreaterThanOrEqual(2);
    expect(clips.filter((c) => !c.youtubeId && !c.instagramId && !c.rutubeId).length).toBeGreaterThanOrEqual(2);
    expect(clips.filter((c) => /[А-я]/.test(c.title) && c.titleLatin).length).toBeGreaterThanOrEqual(2);
  });

  test("clipFileName shapes and refusals", () => {
    expect(clipFileName({ title: "A", ext: "mp4", youtubeId: "zzTest00009", instagramId: null, rutubeId: null })).toBe("A [zzTest00009].mp4");
    expect(clipFileName({ title: "A", ext: "webm", youtubeId: null, instagramId: null, rutubeId: null })).toBe("A.webm");
    expect(() => clipFileName({ title: "A", ext: "mp4", youtubeId: "zzTest00009", instagramId: "x", rutubeId: null })).toThrow();
    expect(() => clipFileName({ title: "a/b", ext: "mp4", youtubeId: null, instagramId: null, rutubeId: null })).toThrow();
  });

  test("ffmpeg args: bars + tone, the clip's duration, a codec per container", () => {
    const [mp4, , , , , , , , webm] = seedClips();
    const a = ffmpegArgs(mp4!, "/x/out.mp4");
    expect(a.join(" ")).toContain("smptebars=size=320x180:rate=25:duration=6");
    expect(a.join(" ")).toContain("sine=frequency=");
    expect(a).toContain("libx264");
    expect(a.at(-1)).toBe("/x/out.mp4");
    expect(ffmpegArgs(webm!, "/x/o.webm")).toContain("libvpx-vp9");
  });
});

describe("plan", () => {
  test("picks archive Songs that have a Version and skips zz-test rows, deterministically", () => {
    const p = pickArchiveRows(archive);
    expect(p.songs.map((s) => s.name)).toEqual(["Fixture Song A", "Fixture Song B", "Fixture Song C"]);
    expect(p.songs[1]!.version_id).toBe("00000000-0000-4000-8000-000000000202");
    expect(p.artists.map((a) => a.name)).toEqual(["Fixture Artist A", "Fixture Artist B"]);
    expect(() => pickArchiveRows({ ...archive, versions: [] })).toThrow(/3 archive Songs/);
    expect(() => pickArchiveRows({ ...archive, artists: [] })).toThrow(/2 archive Artists/);
  });

  test("every call is a valid op with at least one Edit of its family, and stamps where required", () => {
    const plan = buildSeedPlan(archive, allHashes(), counter());
    const rpcs = plan.steps.filter((s): s is RpcStep => s.kind === "rpc");
    for (const s of rpcs) {
      expect(OPS[s.fn] as readonly string[]).toContain(s.op);
      expect(s.edits.length).toBeGreaterThan(0);
      for (const e of s.edits) expect(editBelongsTo(s.fn, e)).toBe(true);
      const needs = (STAMP_REQUIRED[s.fn as WriteFunction] as readonly string[] | undefined)?.includes(s.op);
      if (needs) expect(s.stampOf).not.toBeNull();
      expect(s.target).not.toBeNull();
    }
    expect(planIsComplete(plan)).toBe(true);
  });

  test("covers the spec's list: Proposed rows, Videos per clip, Suggested, rejections, posters, one soft delete", () => {
    const plan = buildSeedPlan(archive, allHashes(), counter());
    const rpcs = plan.steps.filter((s): s is RpcStep => s.kind === "rpc");
    const of = (fn: string, op: string) => rpcs.filter((s) => s.fn === fn && s.op === op);
    for (const fn of ["write_proposed_songs", "write_proposed_versions", "write_proposed_artists"]) {
      const made = of(fn, "create");
      expect(made.length).toBeGreaterThanOrEqual(1);
      for (const s of made) expect(String(s.payload.name ?? s.payload.label)).toStartWith("zz-test");
    }
    const inserts = of("write_videos", "insert");
    expect(inserts.length).toBe(plan.clips.length);
    expect(of("write_video_chapters", "reject").length).toBe(1);
    expect(of("write_video_chapters", "confirm").length).toBe(1);
    expect(of("write_video_artists", "reject").length).toBe(1);
    expect(of("write_videos", "delete").length).toBe(1);
    expect(plan.steps.filter((s) => s.kind === "poster").length).toBe(plan.clips.length);
    // the delete is last, after every poster
    expect(plan.steps.at(-1)).toMatchObject({ kind: "rpc", fn: "write_videos", op: "delete" });

    const payloads = inserts.map((s) => s.payload as Record<string, any>);
    const picks = pickArchiveRows(archive);
    const archiveSongs = new Set(picks.songs.map((s) => s.id));
    expect(payloads.some((p) => archiveSongs.has(p.song_id) && p.version_id)).toBe(true);
    expect(payloads.some((p) => p.proposed_song_id && p.proposed_version_id)).toBe(true);
    expect(payloads.some((p) => p.song_suggested && p.suggestion_source === "title")).toBe(true);
    expect(payloads.some((p) => p.type_suggested)).toBe(true);
    expect(payloads.some((p) => p.title_latin && p.title_latin_source)).toBe(true);
    const chapters = payloads.flatMap((p) => p.chapters ?? []);
    expect(chapters.some((c) => c.suggested && c.source === "comment")).toBe(true);
    const artists = payloads.flatMap((p) => p.artists ?? []);
    expect(artists.some((x) => x.proposed_artist_id)).toBe(true);
    expect(artists.some((x) => x.artist_id && x.suggested)).toBe(true);
    // a pointer pair never carries both sides; a version never without its song side
    for (const p of [...payloads, ...chapters]) {
      expect(p.song_id && p.proposed_song_id).toBeFalsy();
      expect(p.version_id && p.proposed_version_id).toBeFalsy();
      if (p.version_id) expect(p.song_id).toBeTruthy();
    }
    // every id-less Video carries the clip's content hash; YouTube ones their id
    for (const p of payloads) expect(p.youtube_id || p.content_hash).toBeTruthy();
    // the rejected Artist link targets a link that the insert creates
    const rej = of("write_video_artists", "reject")[0]!;
    const link = (rej.target as { link: { video_id: string; artist_id: string } }).link;
    const ins = inserts.find((s) => s.target === link.video_id)!;
    expect((ins.payload.artists as { artist_id?: string; suggested: boolean }[]).some((x) => x.artist_id === link.artist_id && x.suggested)).toBe(true);
  });

  test("without clips on disk the id-less Videos are pending and the plan is not executable", () => {
    const plan = buildSeedPlan(archive, {}, counter());
    expect(planIsComplete(plan)).toBe(false);
    const ins = plan.steps.filter((s): s is RpcStep => s.kind === "rpc" && s.op === "insert");
    expect(ins.filter((s) => s.payload.content_hash === PENDING_HASH).length).toBe(plan.clips.filter((c) => !c.youtubeId).length);
  });

  test("minted ids are unique", () => {
    const plan = buildSeedPlan(archive, allHashes(), () => crypto.randomUUID());
    const ids = plan.steps.flatMap((s) => (s.kind === "rpc" && typeof s.target === "string" ? [s.target] : []));
    const created = plan.steps.filter((s): s is RpcStep => s.kind === "rpc" && (s.op === "create" || s.op === "insert")).map((s) => s.target);
    expect(new Set(created).size).toBe(created.length);
    expect(ids.length).toBeGreaterThan(0);
  });
});

describe("manifest", () => {
  const V = "11111111-1111-4111-8111-111111111111";
  const result = (): WriteResult => ({
    tables: {
      videos: [{ id: V } as never],
      video_chapters: [{ id: "22222222-2222-4222-8222-222222222222" } as never],
      video_edit_history: [{ id: "33333333-3333-4333-8333-333333333333" } as never],
      songs: [{ id: "44444444-4444-4444-8444-444444444444" }],
      video_exposed_songs: [{ id: "55555555-5555-4555-8555-555555555555" } as never],
    },
    tombstones: [{ id: "66666666-6666-4666-8666-666666666666" } as never],
  });

  test("records Shared row ids once, never archive rows or exposure", () => {
    const m = emptyManifest({ archive_url: "https://x.supabase.co", editor_id: null, root: "/r", now: "2026-10-17T00:00:00Z" });
    recordResult(m, result());
    recordResult(m, result());
    expect(m.rows.videos).toEqual([V]);
    expect(m.rows.video_chapters.length).toBe(1);
    expect(m.rows.video_edit_history.length).toBe(1);
    expect(m.rows.shared_tombstone.length).toBe(1);
    expect(JSON.stringify(m)).not.toContain("44444444");
    expect(JSON.stringify(m)).not.toContain("55555555");
  });

  test("round-trips and rejects malformed input", () => {
    const m = emptyManifest({ archive_url: "https://x.supabase.co", editor_id: "e", root: "/r", now: "2026-10-17T00:00:00Z" });
    recordResult(m, result());
    m.posters.push(posterPath(V, "ab".repeat(32)));
    m.clips.push("/r/zz-test-seed/a.mp4");
    expect(parseManifest(serializeManifest(m))).toEqual(m);
    expect(() => parseManifest(JSON.stringify({ ...m, kind: "other" }))).toThrow();
    expect(() => parseManifest(JSON.stringify({ ...m, rows: { ...m.rows, videos: ["not-a-uuid"] } }))).toThrow(/uuid/);
    expect(() => parseManifest(JSON.stringify({ ...m, posters: ["../x.webp"] }))).toThrow(/poster/);
  });

  test("poster paths follow the bucket's check; purge goes children first", () => {
    expect(posterPath(V, "0123456789abcdef".repeat(4))).toBe(`${V}/0123456789abcdef.webp`);
    expect(PURGE_ORDER.indexOf("video_chapters")).toBeLessThan(PURGE_ORDER.indexOf("videos"));
    expect(PURGE_ORDER.indexOf("video_proposed_versions")).toBeLessThan(PURGE_ORDER.indexOf("video_proposed_songs"));
    expect(PURGE_ORDER.indexOf("videos")).toBeLessThan(PURGE_ORDER.indexOf("video_proposed_songs"));
  });
});

describe("arguments and guards", () => {
  test("modes and defaults", () => {
    const a = parseArgs(["--root", "/tmp/r", "--dry-run"], { TUVA_SEED_EMAIL: "editor-test@x" });
    expect(a).toMatchObject({ mode: "seed", dryRun: true, root: "/tmp/r", email: "editor-test@x", manifest: "/tmp/r/zz-test-seed.manifest.json" });
    expect(parseArgs(["--purge", "/m.json"]).mode).toBe("purge");
    expect(parseArgs(["--purge", "/m.json"]).manifest).toBe("/m.json");
    expect(parseArgs(["--delete-test-accounts", "a-test@x, b-test@x"]).accounts).toEqual(["a-test@x", "b-test@x"]);
    expect(parseArgs(["--root", "/r", "--clips-only"]).mode).toBe("clips-only");
    expect(() => parseArgs(["--dry-run"])).toThrow(/--root/);
    expect(() => parseArgs(["--root", "/r", "--bogus"])).toThrow(/unknown/);
    expect(() => parseArgs(["--purge", "/m", "--clips-only"])).toThrow(/exclusive/);
  });

  test("never the owner's data dir, never a non-test account", () => {
    expect(() => assertTestRoot("/Users/u/Library/Application Support/TuvaVideos", "/Users/u")).toThrow();
    expect(() => assertTestRoot("/Users/u/Library/Application Support/TuvaVideos/root", "/Users/u")).toThrow();
    expect(() => assertTestRoot("/Users/u", "/Users/u")).toThrow();
    expect(() => assertTestRoot("/tmp/scratch/root", "/Users/u")).not.toThrow();
    expect(() => assertTestEmail("owner@example.com")).toThrow();
    expect(() => assertTestEmail("tuva-test-editor@example.com")).not.toThrow();
  });
});
