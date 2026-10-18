// Sign-in reconciliation (sharing-spec §2.3, §2.5; ticket #149): the matcher and the shelving rules as pure functions
// over fixtures (a Standalone library meeting a Shared set with overlaps, conflicts and favourites), then the same
// fixture carried out against a Local copy (re-keying, Copies following, stars, `pending_share`), the Sync's clash
// step, the two routes' jobs against a mocked PostgREST, and losing the grant.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb, type Db } from "../src/server/db";
import { applyShared } from "../src/server/localCopy/apply";
import { listShelved, pendingShareIds, readSessionRecord, setPendingShare, writeSessionRecord } from "../src/server/localCopy/meta";
import {
  applyPlan, createReconcile, matchVideo, planCounts, planDiffs, planFor, planReconcile, sharedIndex, shelvedFor, type ReconcileVideo,
} from "../src/server/reconcile";
import { createSync } from "../src/server/sync";
import type { SharedChanges, SharedChapterRow, SharedVideoArtistRow, SharedVideoRow } from "../src/shared/sharedRows";
import { insertChapter, insertCopy, insertVideo, linkArtist, U } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const T = (d: number) => `2026-10-${String(d).padStart(2, "0")}T00:00:00.000000+00:00`;

// ---------------------------------------------------------------------------------------------------------------
// Pure fixtures
// ---------------------------------------------------------------------------------------------------------------

const vid = (id: string, o: Partial<ReconcileVideo> = {}): ReconcileVideo => ({
  id, youtubeId: null, contentHash: null, instagramId: null, rutubeId: null, title: "T", titleLatin: null, type: "other",
  songId: null, versionId: null, artistIds: [], chapters: [], ...o,
});

describe("the matcher (pure)", () => {
  const shared = [
    vid("S1", { youtubeId: "yt1", contentHash: "h1" }),
    vid("S2", { contentHash: "h2", instagramId: "ig2" }),
    vid("S3", { contentHash: "h3", rutubeId: "rt3" }),
    vid("S4", { contentHash: "h4" }),
  ];
  const idx = sharedIndex(shared);
  test("YouTube id, then content hash, then Instagram shortcode or Rutube id; the same uuid before all", () => {
    expect(matchVideo(vid("L", { youtubeId: "yt1", contentHash: "h2" }), idx)).toMatchObject({ shared: { id: "S1" }, by: "youtube_id" });
    expect(matchVideo(vid("L", { contentHash: "h2", instagramId: "nope" }), idx)).toMatchObject({ shared: { id: "S2" }, by: "content_hash" });
    expect(matchVideo(vid("L", { contentHash: "other", instagramId: "ig2" }), idx)).toMatchObject({ shared: { id: "S2" }, by: "instagram_id" });
    expect(matchVideo(vid("L", { contentHash: "other", rutubeId: "rt3" }), idx)).toMatchObject({ shared: { id: "S3" }, by: "rutube_id" });
    expect(matchVideo(vid("S4", { contentHash: "other" }), idx)).toMatchObject({ shared: { id: "S4" }, by: "id" });
    expect(matchVideo(vid("L", { contentHash: "unknown" }), idx)).toBeNull();
  });
});

describe("shelving (pure)", () => {
  const S = vid("S", {
    youtubeId: "yt", title: "Shared title", type: "song", songId: "song-a", versionId: "ver-a", artistIds: ["art-1", "art-2"],
    chapters: [
      { id: "sc1", startS: 0, title: "Intro", titleLatin: null, songId: null, versionId: null },
      { id: "sc2", startS: 60, title: "Second", titleLatin: null, songId: "song-b", versionId: null },
    ],
  });
  test("what the Shared row already says loses nothing", () => {
    const L = vid("L", { youtubeId: "yt", title: "Shared title", type: "other", artistIds: ["art-2"], chapters: [{ id: "lc1", startS: 0, title: "Intro", titleLatin: null, songId: null, versionId: null }] });
    expect(shelvedFor(L, S)).toEqual({ shelved: [], stars: [], favoritesShelved: 0 });
  });
  test("conflicting title, Type, Song, Artists and Chapters are shelved; stars follow kept Chapters or stay with shelved ones", () => {
    const L = vid("L", {
      youtubeId: "yt", title: "My title", titleLatin: "My", type: "concert", songId: "local-song", versionId: null, artistIds: ["art-1", "local-artist"],
      chapters: [
        { id: "lc1", startS: 0, title: "Intro", titleLatin: null, songId: null, versionId: null, favoritedAt: "2026-01-01" },
        { id: "lc2", startS: 60, title: "Second", titleLatin: null, songId: "local-song", versionId: null, favoritedAt: "2026-01-02" },
        { id: "lc3", startS: 90, title: "Mine only", titleLatin: null, songId: null, versionId: null },
      ],
    });
    const r = shelvedFor(L, S);
    expect(r.shelved).toEqual([
      { kind: "title", title: "My title", titleLatin: "My" },
      { kind: "type", type: "concert" },
      { kind: "song", songId: "local-song", versionId: null },
      { kind: "artists", artistIds: ["art-1", "local-artist"] },
      { kind: "chapter", startS: 60, title: "Second", songId: "local-song", versionId: null, favoritedAt: "2026-01-02" },
      { kind: "chapter", startS: 90, title: "Mine only", songId: null, versionId: null, favoritedAt: null },
    ]);
    expect(r.stars).toEqual([{ chapterId: "sc1", favoritedAt: "2026-01-01" }]);
    expect(r.favoritesShelved).toBe(1);
  });
  test("a Standalone library meeting a Shared set: overlaps, a merge, unknowns and the counts", () => {
    const shared = [S, vid("S9", { contentHash: "h9", title: "Nine" })];
    const locals = [
      vid("L1", { youtubeId: "yt", title: "My title" }),                // title shelved
      vid("L2", { contentHash: "h9", title: "Nine" }),                  // matches, nothing lost
      vid("L3", { contentHash: "other", instagramId: null, youtubeId: null, title: "x" }), // unknown
      vid("L4", { youtubeId: null, contentHash: "zzz", rutubeId: null, title: "Nine", instagramId: null }), // unknown
      vid("L5", { contentHash: "h9", youtubeId: null, title: "Nine bis" }), // second local Video of S9
    ];
    const plan = planReconcile(locals, shared);
    expect(plan.matches).toEqual([
      { localId: "L1", sharedId: "S", by: "youtube_id" },
      { localId: "L2", sharedId: "S9", by: "content_hash" },
      { localId: "L5", sharedId: "S9", by: "content_hash" },
    ]);
    expect(plan.unknown).toEqual(["L3", "L4"]);
    expect(plan.shelve.map((s) => [s.videoId, s.payload.kind])).toEqual([["S", "title"], ["S9", "title"]]);
    expect(planCounts(plan, true)).toEqual({ matched: 3, shelved: 2, shelvedVideos: 2, favoritesShelved: 0, queued: 2, unshared: 0 });
    expect(planCounts(plan, false)).toMatchObject({ queued: 0, unshared: 2 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Against a Local copy
// ---------------------------------------------------------------------------------------------------------------

const SV1 = "aaaaaaaa-0000-4000-8000-000000000001";
const SV2 = "aaaaaaaa-0000-4000-8000-000000000002";
const SC1 = "cccccccc-0000-4000-8000-000000000001";
const SC2 = "cccccccc-0000-4000-8000-000000000002";
const ART = U(7001);

const sv = (id: string, o: Partial<SharedVideoRow> = {}): SharedVideoRow => ({
  id, youtube_id: null, content_hash: `hash-${id}`, instagram_id: null, rutube_id: null, title: "Shared one", title_latin: null, title_latin_source: null,
  type: "song", type_suggested: false, song_id: null, proposed_song_id: null, version_id: null, proposed_version_id: null, song_suggested: false,
  suggestion_source: null, poster_path: null, deleted_at: null, deleted_by: null, delete_reason: null, created_at: T(1), updated_at: T(10), ...o,
});
const sc = (id: string, video_id: string, start_s: number, title: string): SharedChapterRow => ({
  id, video_id, start_s, title, title_latin: null, song_id: null, proposed_song_id: null, version_id: null, proposed_version_id: null, suggested: false, source: "manual", created_at: T(1), updated_at: T(10),
});
const sa = (video_id: string, artist_id: string): SharedVideoArtistRow => ({ id: U(8000 + Math.floor(Math.random() * 999)), video_id, artist_id, proposed_artist_id: null, position: 0, suggested: false, created_at: T(1), updated_at: T(10) });

/** The Shared set: SV1 (YouTube yt-1, two Chapters, one Artist) and SV2 (by hash). */
function bundle(): SharedChanges {
  return {
    shared_schema: 1, server_time: T(12), since: null, watermark: T(12),
    tables: {
      videos: [sv(SV1, { youtube_id: "yt-1", content_hash: null, title: "Song of the steppe" }), sv(SV2, { content_hash: "h-2", title: "Two" })],
      video_chapters: [sc(SC1, SV1, 0, "Intro"), sc(SC2, SV1, 30, "Verse")],
      video_artists: [sa(SV1, ART)],
    },
  };
}

/** A Standalone library: L1 overlaps SV1 with local edits and favourites, L2 and L3 both meet SV2, L4 is unknown. */
function library() {
  const db = openDb(":memory:", MIGRATIONS);
  db.exec(`INSERT INTO root (id, path, kind) VALUES (1, '/r', 'local')`);
  const L1 = insertVideo(db, { title: "My steppe song", youtube_id: "yt-1", content_hash: "h-local-1", type: "concert", favorited_at: "2026-09-01T00:00:00Z", resume_s: 42 });
  insertChapter(db, { video_id: L1, start_s: 0, title: "Intro", favorited_at: "2026-09-02T00:00:00Z" });
  insertChapter(db, { video_id: L1, start_s: 45, title: "My part", favorited_at: "2026-09-03T00:00:00Z" });
  db.exec(`INSERT INTO local_artist (id, name, created_at) VALUES ('${U(9001)}', 'Local singer', '2026-01-01')`);
  linkArtist(db, L1, U(9001), 0);
  const c1 = insertCopy(db, { video_id: L1, root_id: 1, rel_path: "a.mp4" });
  const L2 = insertVideo(db, { title: "Two", content_hash: "h-2" });
  const c2 = insertCopy(db, { video_id: L2, root_id: 1, rel_path: "b.mp4" });
  const L3 = insertVideo(db, { title: "Two again", content_hash: "h-3", instagram_id: null, youtube_id: null, favorited_at: "2026-09-04T00:00:00Z" });
  db.query("UPDATE videos SET content_hash = 'h-2-other', instagram_id = NULL WHERE id = ?").run(L3);
  const L4 = insertVideo(db, { title: "Only here", content_hash: "h-4" });
  return { db, L1, L2, L3, L4, c1, c2 };
}

const fav = (db: Db, id: string) => (db.query("SELECT favorited_at FROM video_local WHERE video_id = ?").get(id) as { favorited_at: string | null } | null)?.favorited_at;
const chapterStars = (db: Db) => db.query("SELECT chapter_id, favorited_at FROM chapter_local ORDER BY chapter_id").all();

describe("carrying the plan out", () => {
  test("Shared wins; the loser is shelved; Copies, Favorite and resume follow; stars move or are shelved; unknowns queued", () => {
    const { db, L1, L2, L4, c1, c2 } = library();
    const b = bundle();
    const preview = planCounts(planFor(db, b), true);
    db.transaction(() => {
      const r = applyPlan(db, planFor(db, b), { queueUnknown: true });
      applyShared(db, b);
      expect(r.counts).toEqual(preview);
    })();
    // L1 is now SV1: the Shared title, its Copy, its Favorite and resume point.
    expect(db.query("SELECT COUNT(*) n FROM videos WHERE id = ?").get(L1)).toEqual({ n: 0 });
    expect(db.query("SELECT title, youtube_id, type FROM videos WHERE id = ?").get(SV1)).toEqual({ title: "Song of the steppe", youtube_id: "yt-1", type: "song" });
    expect(db.query("SELECT video_id FROM copy WHERE id = ?").get(c1)).toEqual({ video_id: SV1 });
    expect(db.query("SELECT shared, resume_s FROM video_local WHERE video_id = ?").get(SV1)).toEqual({ shared: 1, resume_s: 42 });
    expect(fav(db, SV1)).toBe("2026-09-01T00:00:00Z");
    // Shelved: title, Type, Artists and the Chapter the Shared Video lacks (it keeps its star).
    const shelved = listShelved(db, SV1).map((s) => s.payload);
    expect(shelved).toEqual([
      { kind: "title", title: "My steppe song", titleLatin: null },
      { kind: "type", type: "concert" },
      { kind: "artists", artistIds: [U(9001)] },
      { kind: "chapter", startS: 45, title: "My part", songId: null, versionId: null, favoritedAt: "2026-09-03T00:00:00Z" },
    ]);
    // The Intro star moved to the Shared Chapter; "My part" left the Favorites list.
    expect(chapterStars(db)).toEqual([{ chapter_id: SC1, favorited_at: "2026-09-02T00:00:00Z" }]);
    expect(db.query("SELECT COUNT(*) n FROM video_chapters WHERE video_id = ?").get(SV1)).toEqual({ n: 2 });
    // L2 (by hash) became SV2 with its Copy; L3 (another hash, no provenance) is unknown.
    expect(db.query("SELECT video_id FROM copy WHERE id = ?").get(c2)).toEqual({ video_id: SV2 });
    expect(db.query("SELECT COUNT(*) n FROM videos WHERE id = ?").get(L2)).toEqual({ n: 0 });
    // The unknown Videos are queued to be shared (a Video Editor) and stay Unshared.
    expect(pendingShareIds(db)).toContain(L4);
    expect(db.query("SELECT shared FROM video_local WHERE video_id = ?").get(L4)).toEqual({ shared: 0 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("two local Videos meeting one Shared Video merge: both Copies, the first Favorite, both shelved", () => {
    const { db, L2, L3 } = library();
    db.query("UPDATE videos SET instagram_id = 'ig-2' WHERE id = ?").run(L3);
    const b = bundle();
    b.tables!.videos![1]!.instagram_id = "ig-2";
    insertCopy(db, { video_id: L3, root_id: 1, rel_path: "c.mp4" });
    db.transaction(() => {
      applyPlan(db, planFor(db, b));
      applyShared(db, b);
    })();
    expect(db.query("SELECT COUNT(*) n FROM videos WHERE id IN (?, ?)").get(L2, L3)).toEqual({ n: 0 });
    expect(db.query("SELECT rel_path FROM copy WHERE video_id = ? ORDER BY rel_path").all(SV2)).toEqual([{ rel_path: "b.mp4" }, { rel_path: "c.mp4" }]);
    expect(fav(db, SV2)).toBe("2026-09-04T00:00:00Z");
    expect(listShelved(db, SV2).map((s) => s.payload)).toEqual([{ kind: "title", title: "Two again", titleLatin: null }]);
  });

  test("the owner's migrated machine: same uuids, same data, nothing shelved", () => {
    const db = openDb(":memory:", MIGRATIONS);
    insertVideo(db, { id: SV2, title: "Two", content_hash: "h-2" });
    const b = bundle();
    db.transaction(() => {
      expect(applyPlan(db, planFor(db, b)).counts).toMatchObject({ matched: 1, shelved: 0 });
      applyShared(db, b);
    })();
    expect(db.query("SELECT shared FROM video_local WHERE video_id = ?").get(SV2)).toEqual({ shared: 1 });
    expect(listShelved(db)).toEqual([]);
  });
});

describe("the Sync's clash step", () => {
  test("an Unshared Video holding a Shared Video's youtube_id no longer fails the Sync: it reconciles", async () => {
    const { db, L1 } = library();
    const sync = createSync(db, { url: "http://archive.test", key: "k" }, { fetchImpl: mock(bundle()).fetchImpl, warn: () => {} });
    const r = await sync.request({ accessToken: TOKEN });
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(db.query("SELECT COUNT(*) n FROM videos WHERE id = ?").get(L1)).toEqual({ n: 0 });
    expect(listShelved(db, SV1).length).toBe(4);
    expect(pendingShareIds(db)).toEqual([]); // the Sync queues nothing
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The routes' jobs
// ---------------------------------------------------------------------------------------------------------------

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64({ alg: "HS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, sub: "u" })}.c2ln`;
const USER = "11111111-1111-4111-8111-111111111111";

function mock(batch: SharedChanges, who: Record<string, unknown> = {}) {
  const m = {
    who: { user_id: USER, email: "ed@example.org", display_name: "Ed", avatar_url: null, must_change_password: false, archive_role: "user", grant_level: "editor", shared_schema: 1, server_time: T(12), ...who },
    pulls: 0,
    fetchImpl: (async (url: string) => {
      const fn = new URL(url).pathname.split("/").pop();
      if (fn === "video_whoami") return new Response(JSON.stringify(m.who), { status: 200 });
      if (fn === "shared_changes_since") {
        m.pulls++;
        return new Response(JSON.stringify(batch), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch,
  };
  return m;
}

describe("preview and confirm", () => {
  test("the preview counts and writes only the record; Continue reuses its pull and reconciles", async () => {
    const { db, L1 } = library();
    const m = mock(bundle());
    const rc = createReconcile(db, { url: "http://archive.test", key: "k" }, { fetchImpl: m.fetchImpl });
    const p = await rc.preview(TOKEN);
    expect(p).toMatchObject({ ok: true, record: { userId: USER, grantLevel: "editor" }, counts: { matched: 2, shelved: 4, queued: 2, favoritesShelved: 1 } });
    expect(listShelved(db)).toEqual([]);
    expect(db.query("SELECT COUNT(*) n FROM videos WHERE id = ?").get(L1)).toEqual({ n: 1 });
    const c = await rc.confirm(TOKEN);
    expect(c.counts).toEqual(p.counts);
    // #157: the post-Sync popup's rows are the confirmation's.
    expect(p.diffs?.map((d) => [d.videoId, d.rows.length])).toEqual([[SV1, 4]]);
    expect(c.diffs).toEqual(p.diffs!);
    expect(m.pulls).toBe(1);
    expect(listShelved(db).length).toBe(4);
    expect(readSessionRecord(db)?.watermark).toBeNull(); // the Sync that follows pulls and sets it
  });

  test("#157: the diff rows say each local value against the Shared one, names from the batch first", () => {
    const { db } = library();
    const b = bundle();
    b.tables!.artists = [{ id: ART, name: "Shared singer" }];
    expect(planDiffs(db, planFor(db, b), b)).toEqual([
      {
        videoId: SV1, videoTitle: "Song of the steppe", rows: [
          { attr: "title", label: "Title", before: "My steppe song", after: "Song of the steppe" },
          { attr: "type", label: "Type", before: "concert", after: "song" },
          { attr: "artists", label: "Artists", before: "Local singer", after: "Shared singer" },
          { attr: "chapter", label: "Chapter at 0:45", before: "“My part”", after: "No Chapter here" },
        ],
      },
    ]);
  });

  test("a Member's unknown Videos stay Unshared; no grant reconciles nothing", async () => {
    const { db, L4 } = library();
    setPendingShare(db, L4, true);
    const member = createReconcile(db, { url: "http://archive.test", key: "k" }, { fetchImpl: mock(bundle(), { grant_level: "member" }).fetchImpl });
    expect((await member.preview(TOKEN)).counts).toMatchObject({ queued: 0, unshared: 2 });
    await member.confirm(TOKEN);
    expect(pendingShareIds(db)).toEqual([]);

    const fresh = library();
    const none = createReconcile(fresh.db, { url: "http://archive.test", key: "k" }, { fetchImpl: mock(bundle(), { grant_level: null }).fetchImpl });
    expect(await none.confirm(TOKEN)).toMatchObject({ ok: true, counts: { matched: 0, shelved: 0 }, record: { grantLevel: null } });
    expect(listShelved(fresh.db)).toEqual([]);
  });
});

describe("losing the grant (§2.5)", () => {
  test("an editor re-read as a Member leaves the share queue; the Videos stay Unshared", () => {
    const { db, L4 } = library();
    writeSessionRecord(db, { userId: USER, grantLevel: "editor" });
    setPendingShare(db, L4, true);
    writeSessionRecord(db, { userId: USER, watermark: T(12) }); // a write that does not re-read the grant
    expect(pendingShareIds(db)).toEqual([L4]);
    writeSessionRecord(db, { userId: USER, grantLevel: "member" });
    expect(pendingShareIds(db)).toEqual([]);
    expect(db.query("SELECT COUNT(*) n FROM videos WHERE id = ?").get(L4)).toEqual({ n: 1 });
  });
});
