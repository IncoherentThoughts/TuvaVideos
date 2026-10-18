// Posters and the `pending_share` drain (sharing-spec §6.5, §6.6, §4.3; ticket #140): the poster hash logic, the
// download half of a Sync against a mocked PostgREST + Storage (4 at a time, the token's lifetime, re-download on a
// hash change, adopting a poster uploaded from here), the browser's upload batching, the question's trigger rules, the
// queue's payloads and the drain (Proposed rows first, `local_*` pointers substituted, the apply clearing the flag).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/server/db";
import { applyShared } from "../src/server/localCopy/apply";
import { pendingShareIds, setPendingShare, writeSessionRecord } from "../src/server/localCopy/meta";
import { downloadPosters, posterUploadCandidates } from "../src/server/posters";
import { pendingShareBatch, pendingShareSummary, setShareAuto } from "../src/server/share";
import { createSync } from "../src/server/sync";
import {
  hashMatches, POSTER_CONCURRENCY, posterAction, posterHashOf, posterPathFor, runPool, sha256Hex, uploadPosters, type PosterUploadDeps,
} from "../src/shared/posters";
import {
  drainPendingShare, noProvenanceLine, resolveInsert, shareQuestionLine, shareStep, type CallOutcome, type DrainDeps, type ShareFacts, type ShareMemory,
} from "../src/shared/share";
import type { SharedChanges, SharedVideoRow } from "../src/shared/sharedRows";
import { insertChapter, insertCopy, insertLocalArtist, insertVideo, U } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "tuva-posters-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const T = (d: number, h = 0) => `2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000000+00:00`;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tokenFor = (expS: number) => `${b64({ alg: "HS256" })}.${b64({ exp: expS, sub: "u" })}.c2ln`;
const USER = "11111111-1111-4111-8111-111111111111";
const VA = "aaaaaaaa-0000-4000-8000-000000000001";
const VB = "aaaaaaaa-0000-4000-8000-000000000002";
const H1 = "0123456789abcdef";
const H2 = "fedcba9876543210";

const video = (id: string, o: Partial<SharedVideoRow> = {}): SharedVideoRow => ({
  id, youtube_id: null, content_hash: `hash-${id}`, instagram_id: null, rutube_id: null, title: "Shared", title_latin: null, title_latin_source: null,
  type: "song", type_suggested: false, song_id: null, proposed_song_id: null, version_id: null, proposed_version_id: null, song_suggested: false,
  suggestion_source: null, poster_path: null, deleted_at: null, deleted_by: null, delete_reason: null, created_at: T(1), updated_at: T(10), ...o,
});

describe("poster hash logic", () => {
  test("paths are <uuid>/<sha256 prefix>.webp; the prefix is the hash", () => {
    expect(posterPathFor(VA.toUpperCase(), "ABCDEF0123456789" + "0".repeat(48))).toBe(`${VA}/abcdef0123456789.webp`);
    expect(posterHashOf(`${VA}/${H1}.webp`)).toBe(H1);
    expect(posterHashOf(`${VA}/${H1}.png`)).toBeNull();
    expect(posterHashOf(`not-a-uuid/${H1}.webp`)).toBeNull();
    expect(posterHashOf(`${VA}/abc.webp`)).toBeNull(); // under 8 hex digits
    expect(posterHashOf(null)).toBeNull();
    expect(hashMatches(`${VA}/${H1}.webp`, H1 + "99".repeat(24))).toBe(true);
    expect(hashMatches(`${VA}/${H1}.webp`, H2 + "99".repeat(24))).toBe(false);
  });
  test("what Sync does: nothing held → download; same hash with its file → nothing; hash changed → download; path cleared → drop", () => {
    const p = `${VA}/${H1}.webp`;
    expect(posterAction({ posterPath: p, posterHash: null, fileExists: false })).toBe("download");
    expect(posterAction({ posterPath: p, posterHash: H1, fileExists: true })).toBe("none");
    expect(posterAction({ posterPath: p, posterHash: H1, fileExists: false })).toBe("download");
    expect(posterAction({ posterPath: `${VA}/${H2}.webp`, posterHash: H1, fileExists: true })).toBe("download");
    // A local file with no recorded hash may be the one this machine uploaded: its bytes are checked first.
    expect(posterAction({ posterPath: p, posterHash: null, fileExists: true })).toBe("adopt-or-download");
    expect(posterAction({ posterPath: null, posterHash: H1, fileExists: true })).toBe("drop");
    expect(posterAction({ posterPath: null, posterHash: null, fileExists: true })).toBe("none");
  });
});

describe("batching", () => {
  test("runPool keeps at most n in flight, counts failures and throws, and skips what it may no longer start", async () => {
    let inFlight = 0;
    let peak = 0;
    const r = await runPool(Array.from({ length: 11 }, (_, i) => i), 4, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(2);
      inFlight--;
      if (i === 3) throw new Error("boom");
      return i !== 5;
    });
    expect(peak).toBe(4);
    expect(r).toEqual({ done: 9, failed: 2, skipped: 0 });
    let started = 0;
    const s = await runPool(Array.from({ length: 10 }, (_, i) => i), 4, async () => {
      started++;
      return true;
    }, () => started < 6);
    expect(s.done + s.failed + s.skipped).toBe(10);
    expect(s.skipped).toBeGreaterThan(0);
  });

  test("the upload: 4 at a time; path from the bytes; an existing object counts; poster_path written with its stamp and Edit, then applied", async () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ videoId: U(100 + i), updatedAt: T(10, i) }));
    let inFlight = 0;
    let peak = 0;
    const log: string[] = [];
    const writes: unknown[] = [];
    const deps: PosterUploadDeps = {
      readPoster: async (id) => (id === U(108) ? null : new TextEncoder().encode(`webp ${id}`).buffer as ArrayBuffer),
      async upload(path) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(3);
        inFlight--;
        log.push(path);
        if (path.startsWith(U(101))) return { ok: false, exists: true, error: "The resource already exists" };
        if (path.startsWith(U(102))) return { ok: false, exists: false, error: "Payload too large" };
        return { ok: true };
      },
      async setPosterPath(videoId, path, updatedAt, edit) {
        writes.push({ videoId, path, updatedAt, edit });
        return videoId === U(103) ? { ok: false, error: "conflict" } : { ok: true, value: { tables: { videos: [] } } };
      },
      apply: async () => true,
    };
    const r = await uploadPosters(items, deps);
    expect(peak).toBeLessThanOrEqual(POSTER_CONCURRENCY);
    expect(peak).toBe(4);
    expect(r.uploaded).toBe(6); // 9 − the missing file (108), the refused upload (102), the conflict (103)
    expect(r.failed).toBe(3);
    const want = posterPathFor(U(100), await sha256Hex(new TextEncoder().encode(`webp ${U(100)}`)));
    expect(log).toContain(want);
    expect(writes).toContainEqual({
      videoId: U(100), path: want, updatedAt: T(10, 0),
      edit: { event_type: "video.poster_changed", field_name: "poster_path", old_value: null, new_value: want, description: "Poster uploaded" },
    });
    expect(writes.some((w) => (w as { videoId: string }).videoId === U(101))).toBe(true); // "exists" goes on to the write
    expect(writes.some((w) => (w as { videoId: string }).videoId === U(102))).toBe(false);
  });
});

/** A mocked PostgREST (whoami, shared_changes_since) and Storage (`/storage/v1/object/authenticated/posters/...`). */
function archive(bundle: SharedChanges) {
  const m = {
    pull: bundle,
    objects: new Map<string, Uint8Array>(),
    gets: [] as string[],
    auth: [] as string[],
    inFlight: 0,
    peak: 0,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.startsWith("/storage/v1/object/authenticated/posters/")) {
        const path = decodeURIComponent(u.pathname.slice("/storage/v1/object/authenticated/posters/".length));
        m.gets.push(path);
        m.auth.push(String((init?.headers as Record<string, string>)?.authorization ?? ""));
        m.inFlight++;
        m.peak = Math.max(m.peak, m.inFlight);
        await Bun.sleep(3);
        m.inFlight--;
        const o = m.objects.get(path);
        return o ? new Response(o as unknown as BodyInit, { status: 200, headers: { "content-type": "image/webp" } }) : new Response(JSON.stringify({ error: "not_found" }), { status: 400 });
      }
      const fn = u.pathname.split("/").pop();
      if (fn === "video_whoami")
        return Response.json({ user_id: USER, email: "ed@example.org", display_name: "Ed", avatar_url: null, must_change_password: false, archive_role: "user", grant_level: "editor", granted_at: null, shared_schema: 1, server_time: T(12, 2) });
      if (fn === "shared_changes_since") return Response.json(m.pull);
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch,
  };
  return m;
}

const bundleOf = (videos: SharedVideoRow[], watermark = T(12)): SharedChanges => ({ shared_schema: 1, server_time: T(12, 1), since: null, watermark, tables: { videos } });
const hashOf = (db: Db, id: string) => (db.query("SELECT poster_hash FROM video_local WHERE video_id = ?").get(id) as { poster_hash: string | null }).poster_hash;

describe("the download half of a Sync (mocked PostgREST + Storage)", () => {
  function machine(videos: SharedVideoRow[]) {
    const db = openDb(":memory:", MIGRATIONS);
    const thumbs = scratch();
    const arch = archive(bundleOf(videos));
    const clock = { ms: Date.now() };
    const sync = createSync(db, { url: "http://archive.test", key: "k" }, { fetchImpl: arch.fetchImpl, warn: () => {}, now: () => clock.ms, thumbsDir: thumbs });
    const token = tokenFor(Math.floor(clock.ms / 1000) + 3600);
    return { db, thumbs, arch, clock, run: (t = token) => sync.request({ accessToken: t }) };
  }

  test("after the apply: fetched with the token, 4 at a time, written as <uuid>.poster.webp, poster_hash recorded; the next Sync fetches nothing", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => U(200 + i));
    const m = machine(ids.map((id, i) => video(id, { poster_path: `${id}/${H1.slice(0, 15)}${i}.webp` })));
    for (const [i, id] of ids.entries()) m.arch.objects.set(`${id}/${H1.slice(0, 15)}${i}.webp`, new TextEncoder().encode(`poster ${i}`));
    const r = await m.run();
    expect(r.ok).toBe(true);
    expect(r.posters).toEqual({ downloaded: 7, adopted: 0, dropped: 0, failed: 0, remaining: 0 });
    expect(m.arch.peak).toBe(4);
    expect(m.arch.auth.every((a) => a.startsWith("Bearer "))).toBe(true);
    expect(readFileSync(join(m.thumbs, `${ids[2]}.poster.webp`), "utf8")).toBe("poster 2");
    expect(hashOf(m.db, ids[2]!)).toBe(`${H1.slice(0, 15)}2`);
    const before = m.arch.gets.length;
    const r2 = await m.run();
    expect(r2.posters).toEqual({ downloaded: 0, adopted: 0, dropped: 0, failed: 0, remaining: 0 });
    expect(m.arch.gets.length).toBe(before);
  });

  test("a changed poster_path re-downloads; a cleared one drops the file so the pool generates again; a missing object resumes next Sync", async () => {
    const m = machine([video(VA, { poster_path: `${VA}/${H1}.webp` }), video(VB, { poster_path: `${VB}/${H1}.webp` })]);
    m.arch.objects.set(`${VA}/${H1}.webp`, new TextEncoder().encode("one"));
    const r = await m.run();
    expect(r.posters).toMatchObject({ downloaded: 1, failed: 1 });
    expect(hashOf(m.db, VB)).toBeNull();
    m.arch.objects.set(`${VA}/${H2}.webp`, new TextEncoder().encode("two"));
    m.arch.objects.set(`${VB}/${H1}.webp`, new TextEncoder().encode("bee"));
    m.arch.pull = bundleOf([video(VA, { poster_path: `${VA}/${H2}.webp`, updated_at: T(11) })], T(13));
    const r2 = await m.run();
    expect(r2.posters).toMatchObject({ downloaded: 2, failed: 0 });
    expect(readFileSync(join(m.thumbs, `${VA}.poster.webp`), "utf8")).toBe("two");
    expect(hashOf(m.db, VA)).toBe(H2);
    m.db.query("UPDATE video_local SET thumbnail_generated_at = ? WHERE video_id = ?").run(T(12), VA);
    m.arch.pull = bundleOf([video(VA, { poster_path: null, updated_at: T(12) })], T(14));
    const r3 = await m.run();
    expect(r3.posters).toMatchObject({ dropped: 1 });
    expect(existsSync(join(m.thumbs, `${VA}.poster.webp`))).toBe(false);
    expect(m.db.query("SELECT poster_hash, thumbnail_generated_at FROM video_local WHERE video_id = ?").get(VA)).toEqual({ poster_hash: null, thumbnail_generated_at: null });
  });

  test("a local poster that already is the Shared one (uploaded from here) is adopted without a request", async () => {
    const bytes = new TextEncoder().encode("mine");
    const path = posterPathFor(VA, await sha256Hex(bytes));
    const m = machine([video(VA, { poster_path: path })]);
    writeFileSync(join(m.thumbs, `${VA}.poster.webp`), bytes);
    const r = await m.run();
    expect(r.posters).toMatchObject({ downloaded: 0, adopted: 1 });
    expect(m.arch.gets).toEqual([]);
    expect(hashOf(m.db, VA)).toBe(posterHashOf(path));
  });

  test("within the token's lifetime: nothing starts once exp is near; the remainder waits for the next Sync", async () => {
    const db = openDb(":memory:", MIGRATIONS);
    const thumbs = scratch();
    const arch = archive(bundleOf([]));
    for (const i of [0, 1]) {
      const id = U(300 + i);
      insertVideo(db, { id, title: "x", content_hash: `h-${id}`, poster_path: `${id}/${H1}.webp`, shared: 1 });
      arch.objects.set(`${id}/${H1}.webp`, new Uint8Array([1]));
    }
    const now = Date.now();
    const r = await downloadPosters(db, { url: "http://archive.test", key: "k" }, "t", { thumbsDir: thumbs, fetchImpl: arch.fetchImpl, now: () => now, expMs: now + 5_000 });
    expect(r).toMatchObject({ downloaded: 0, remaining: 2 });
    const r2 = await downloadPosters(db, { url: "http://archive.test", key: "k" }, "t", { thumbsDir: thumbs, fetchImpl: arch.fetchImpl, now: () => now, expMs: now + 3_600_000 });
    expect(r2).toMatchObject({ downloaded: 2, remaining: 0 });
  });

  test("upload candidates: Shared, no poster_path, a local poster file; never an Unshared or deleted Video", () => {
    const db = openDb(":memory:", MIGRATIONS);
    const thumbs = scratch();
    const mk = (n: number, o: Record<string, unknown>) => {
      const id = insertVideo(db, { id: U(400 + n), title: "x", content_hash: `h-${n}`, thumbnail_generated_at: T(10), ...o });
      writeFileSync(join(thumbs, `${id}.poster.webp`), "p");
      return id;
    };
    const yes = mk(1, { shared: 1 });
    mk(2, { shared: 0 });
    mk(3, { shared: 1, poster_path: `${U(403)}/${H1}.webp` });
    mk(4, { shared: 1, deleted_at: T(11) });
    insertVideo(db, { id: U(405), title: "no file", content_hash: "h-405", shared: 1, thumbnail_generated_at: T(10) });
    expect(posterUploadCandidates(db, thumbs).map((c) => c.videoId)).toEqual([yes]);
  });
});

describe("the one question's trigger rules (§6.6)", () => {
  const facts = (o: Partial<ShareFacts> = {}, s: Partial<ShareFacts["summary"]> = {}): ShareFacts => ({
    canEdit: true, online: true, scanning: false, ...o, summary: { count: 3, newestAt: T(12), auto: false, ...s },
  });
  const mem = (o: Partial<ShareMemory> = {}): ShareMemory => ({ firstSyncAfterSignIn: false, askedNewestAt: null, ...o });

  test("never offline, never mid-scan, never off an editor's machine, never with an empty queue", () => {
    for (const e of ["scan-end", "sync", "open"] as const) {
      expect(shareStep(e, facts({ online: false }), mem({ firstSyncAfterSignIn: true }))).toBe("none");
      expect(shareStep(e, facts({ scanning: true }), mem({ firstSyncAfterSignIn: true }))).toBe("none");
      expect(shareStep(e, facts({ canEdit: false }), mem({ firstSyncAfterSignIn: true }))).toBe("none");
      expect(shareStep(e, facts({}, { count: 0 }), mem({ firstSyncAfterSignIn: true }))).toBe("none");
    }
  });
  test("asks at the end of a scan that filled the queue, and again only for newer Videos", () => {
    expect(shareStep("scan-end", facts(), mem())).toBe("ask");
    expect(shareStep("scan-end", facts(), mem({ askedNewestAt: T(12) }))).toBe("none");
    expect(shareStep("scan-end", facts({}, { newestAt: T(13) }), mem({ askedNewestAt: T(12) }))).toBe("ask");
  });
  test("asks right after the first Sync after a sign-in; a launch's Sync does not ask", () => {
    expect(shareStep("sync", facts(), mem({ firstSyncAfterSignIn: true }))).toBe("ask");
    expect(shareStep("sync", facts(), mem())).toBe("none");
  });
  test("after one Share, scan ends and Syncs drain without asking; the chip row always asks", () => {
    expect(shareStep("scan-end", facts({}, { auto: true }), mem({ askedNewestAt: T(12) }))).toBe("drain");
    expect(shareStep("sync", facts({}, { auto: true }), mem())).toBe("drain");
    expect(shareStep("open", facts({}, { auto: true }), mem())).toBe("ask");
    expect(shareStep("open", facts(), mem({ askedNewestAt: T(12) }))).toBe("ask");
  });
  test("the question's lines", () => {
    expect(shareQuestionLine({ count: 2, folders: [{ path: "/Users/x/Tuvan Videos/", count: 2 }] })).toBe("Share 2 new Videos from Tuvan Videos?");
    expect(shareQuestionLine({ count: 1, folders: [] })).toBe("Share 1 new Video?");
    expect(shareQuestionLine({ count: 3, folders: [{ path: "/a", count: 2 }, { path: "/b", count: 1 }] })).toBe("Share 3 new Videos from 2 folders?");
    expect(noProvenanceLine({ count: 3, noProvenance: 0 })).toBeNull();
    expect(noProvenanceLine({ count: 3, noProvenance: 1 })).toBe("1 of them have no YouTube id, Instagram shortcode or Rutube id.");
    expect(noProvenanceLine({ count: 2, noProvenance: 2 })).toBe("None of them have a YouTube id, Instagram shortcode or Rutube id.");
  });
});

describe("the pending_share queue and its drain (§6.6, §4.3)", () => {
  function editorMachine() {
    const db = openDb(":memory:", MIGRATIONS);
    writeSessionRecord(db, { userId: USER, grantLevel: "editor" });
    db.exec("INSERT INTO root (id, path, kind) VALUES (1, '/scratch/Root', 'local')");
    return db;
  }
  /** Two queued Videos: one with a local Song + Version, a local Artist and a Chapter on the local Song; one bare. */
  function queued(db: Db) {
    db.query("INSERT INTO local_song (id, name, english_name, created_at) VALUES (?, 'Local song', 'Eng', ?)").run(U(501), T(1));
    db.query("INSERT INTO local_version (id, song_id, label, display_order, cyrillic, footnotes_cyrillic, created_at, updated_at) VALUES (?, ?, 'Live', 0, 'Кирилл', '[1]', ?, ?)").run(U(502), U(501), T(1), T(1));
    const la = insertLocalArtist(db, { id: U(503), name: "Local band" });
    const a = insertVideo(db, { id: VA, title: "Clip A", youtube_id: "yt-a", song_id: U(501), version_id: U(502), created_at: T(2), pending_share: 1 });
    insertChapter(db, { video_id: a, start_s: 5, title: "Ch", song_id: U(501) });
    db.query("INSERT INTO video_artists (id, video_id, artist_id, position, suggested, updated_at, created_at) VALUES (?, ?, ?, 0, 1, ?, ?)").run(U(504), a, la, T(2), T(2));
    const b = insertVideo(db, { id: VB, title: "Clip B", content_hash: "h-b", created_at: T(3), pending_share: 1 });
    insertCopy(db, { video_id: a, root_id: 1, rel_path: "a.mp4" });
    insertCopy(db, { video_id: b, root_id: 1, rel_path: "b.mp4" });
    insertVideo(db, { id: U(509), title: "Not queued", content_hash: "h-509", created_at: T(4) });
    return { a, b };
  }

  test("the summary: count, those without any provenance id, the folder, the newest; empty on a non-editor's machine", () => {
    const db = editorMachine();
    queued(db);
    expect(pendingShareSummary(db)).toEqual({ count: 2, noProvenance: 1, folders: [{ path: "/scratch/Root", count: 2 }], newestAt: T(3), auto: false });
    setShareAuto(db, true);
    expect(pendingShareSummary(db).auto).toBe(true);
    writeSessionRecord(db, { userId: USER, grantLevel: "member" });
    expect(pendingShareSummary(db)).toMatchObject({ count: 0, auto: true });
  });

  test("the batch: one insert per Video with its Chapters and Artists in order, and the local rows they point at", () => {
    const db = editorMachine();
    queued(db);
    const b = pendingShareBatch(db);
    expect(b.items.map((i) => i.videoId)).toEqual([VA, VB]);
    expect(b.items[0]!.insert).toMatchObject({ title: "Clip A", youtube_id: "yt-a", song_id: U(501), version_id: U(502), type: "other", type_suggested: false });
    expect(b.items[0]!.insert.chapters).toEqual([expect.objectContaining({ start_s: 5, title: "Ch", song_id: U(501), suggested: false })]);
    expect(b.items[0]!.insert.artists).toEqual([{ artist_id: U(503), suggested: true }]);
    expect(b.items[1]!.insert).toMatchObject({ title: "Clip B", content_hash: "h-b", chapters: [], artists: [] });
    expect(b.locals.songs).toEqual([{ id: U(501), create: { name: "Local song", english_name: "Eng", alternate_titles: null } }]);
    expect(b.locals.versions).toEqual([expect.objectContaining({ id: U(502), songId: U(501), create: expect.objectContaining({ label: "Live", lyrics_cyrillic: "Кирилл", footnotes_cyrillic: [1] }) })]);
    expect(b.locals.artists).toEqual([{ id: U(503), create: { name: "Local band" } }]);
  });

  test("resolveInsert swaps local pointers to Proposed (or deduped archive) ones and leaves the input alone", () => {
    const insert = { title: "t", song_id: "L-song", version_id: "A-version", chapters: [{ start_s: 0, song_id: "L-song", version_id: null }], artists: [{ artist_id: "L-art" }, { artist_id: "A-art" }] };
    const out = resolveInsert(insert, new Map([["L-song", { kind: "proposed", id: "P1" }], ["L-art", { kind: "archive", id: "A9" }]]));
    expect(out).toMatchObject({ song_id: null, proposed_song_id: "P1", version_id: "A-version" });
    expect(out.chapters![0]).toMatchObject({ song_id: null, proposed_song_id: "P1" });
    expect(out.artists).toEqual([{ artist_id: "A9", proposed_artist_id: null }, { artist_id: "A-art" }]);
    expect(insert.song_id).toBe("L-song");
  });

  test("the drain: Song → Version → Artist first, then one insert per Video; the apply clears pending_share", async () => {
    const db = editorMachine();
    queued(db);
    const calls: string[] = [];
    let n = 0;
    const ok = (tables: SharedChanges["tables"]): CallOutcome => ({ ok: true, value: { tables: tables!, tombstones: [] } });
    const deps: DrainDeps = {
      newId: () => U(600 + ++n),
      async createProposedSong(id, p) {
        calls.push(`song ${p.name}`);
        return ok({ video_proposed_songs: [{ id, name: p.name, english_name: p.english_name, alternate_titles: null, notes: null, created_by: USER, created_at: T(12), updated_at: T(12) }] });
      },
      async createProposedVersion(id, p) {
        calls.push(`version ${p.label} under ${p.proposed_song_id}`);
        return ok({ video_proposed_versions: [{ id, song_id: null, proposed_song_id: p.proposed_song_id, label: p.label, lyrics_cyrillic: p.lyrics_cyrillic, lyrics_transliteration: null, lyrics_translation: null, footnotes_cyrillic: null, footnotes_transliteration: null, footnotes_translation: null, source: null, created_by: USER, created_at: T(12), updated_at: T(12) }] as never });
      },
      async createProposedArtist(_id, p) {
        calls.push(`artist ${p.name}`);
        // The dedupe found an archive Artist of the same name: the drain points at it instead.
        return { ok: false, error: { word: "duplicate-candidate", code: "VD422", message: "dup", detail: [{ kind: "archive", id: U(700), name: p.name }] } };
      },
      async insertVideo(id, p) {
        calls.push(`insert ${id} song=${p.proposed_song_id} version=${p.proposed_version_id} artists=${JSON.stringify(p.artists)} ch=${p.chapters?.[0]?.proposed_song_id ?? "-"}`);
        return ok({ videos: [video(id, { title: p.title, proposed_song_id: p.proposed_song_id ?? null, proposed_version_id: p.proposed_version_id ?? null, updated_at: T(1) })] });
      },
      apply: async (r) => {
        applyShared(db, r as SharedChanges);
        return true;
      },
    };
    const r = await drainPendingShare(pendingShareBatch(db), deps);
    expect(r).toEqual({ shared: 2, failed: 0, proposed: 2, deduped: 1, errors: [] });
    expect(calls).toEqual([
      "song Local song",
      `version Live under ${U(601)}`,
      "artist Local band",
      `insert ${VA} song=${U(601)} version=${U(602)} artists=${JSON.stringify([{ artist_id: U(700), suggested: true, proposed_artist_id: null }])} ch=${U(601)}`,
      `insert ${VB} song=null version=null artists=[] ch=-`,
    ]);
    // The stamps came back older than the scan's local ones (the guard skipped the rows): still Shared, still dequeued.
    expect(pendingShareIds(db)).toEqual([]);
    expect(db.query("SELECT shared, pending_share FROM video_local WHERE video_id = ?").get(VA)).toEqual({ shared: 1, pending_share: 0 });
    expect(db.query("SELECT COUNT(*) n FROM video_proposed_songs").get()).toEqual({ n: 1 });
  });

  test("a failed Proposed row leaves its Videos queued; a failed insert leaves only that Video queued", async () => {
    const db = editorMachine();
    queued(db);
    const fail = (word: "forbidden" | "exists"): CallOutcome => ({ ok: false, error: { word, code: word === "exists" ? "23505" : "42501", message: word, detail: null } });
    const deps: DrainDeps = {
      newId: () => crypto.randomUUID(),
      createProposedSong: async () => fail("forbidden"),
      createProposedVersion: async () => fail("forbidden"),
      createProposedArtist: async () => fail("forbidden"),
      insertVideo: async (id) => (id === VB ? fail("exists") : fail("forbidden")),
      apply: async () => true,
    };
    const r = await drainPendingShare(pendingShareBatch(db), deps);
    expect(r.shared).toBe(0);
    expect(r.failed).toBe(2);
    expect(r.errors.some((e) => e.includes(VA) && e.includes("Proposed row"))).toBe(true);
    expect(r.errors.some((e) => e.includes(VB) && e.includes("exists"))).toBe(true);
    expect(pendingShareIds(db)).toEqual([VA, VB]);
    setPendingShare(db, VB, false);
    expect(pendingShareIds(db)).toEqual([VA]);
  });
});
