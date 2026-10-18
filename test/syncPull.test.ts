// Sync's pull (sharing-spec §6.2–§6.4; ticket #139): the watermark math and its 5-minute overlap, the repair cases,
// the pull-vs-push guard through a real Sync, tombstones and the ids-only reconcile, the failure rules against a mocked
// PostgREST (nothing applied, watermark left alone), "Refresh all Shared data", and the browser's trigger rules and
// Sync state as the pure reducer.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb, type Db } from "../src/server/db";
import { getMeta, readSessionRecord, setMeta, SHARED_SCHEMA } from "../src/server/localCopy/meta";
import { coalesce, createSync, fullRefetchReason, pullSince, SYNCED_SCHEMA_KEY, TOMBSTONE_RETENTION_MS } from "../src/server/sync";
import {
  FOCUS_SYNC_AFTER_MS, INITIAL_SESSION_STATE, sessionReducer, syncBackoffMs, syncWanted, type SessionRecord, type SessionState,
} from "../src/shared/session";
import type { SharedChanges, SharedVideoRow } from "../src/shared/sharedRows";
import { archiveChanges } from "./helpers/archive";
import { insertCopy, insertVideo, U } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const T = (d: number, h = 0) => `2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000000+00:00`;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64({ alg: "HS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, sub: "u" })}.c2ln`;
const USER = "11111111-1111-4111-8111-111111111111";
const SV = "aaaaaaaa-0000-4000-8000-000000000001";
const PS = U(901);

const video = (id: string, o: Partial<SharedVideoRow> = {}): SharedVideoRow => ({
  id, youtube_id: null, content_hash: `hash-${id}`, instagram_id: null, rutube_id: null, title: "Shared one", title_latin: null, title_latin_source: null,
  type: "song", type_suggested: false, song_id: null, proposed_song_id: null, version_id: null, proposed_version_id: null, song_suggested: false,
  suggestion_source: null, poster_path: null, deleted_at: null, deleted_by: null, delete_reason: null, created_at: T(1), updated_at: T(10), ...o,
});

/** The fixture bundle: test/fixtures/backup's archive tables, one Shared Video, one Proposed Song. */
function firstBundle(): SharedChanges {
  const tables = archiveChanges();
  const ids = (t: keyof typeof tables) => ((tables[t] ?? []) as { id: string }[]).map((r) => String(r.id));
  return {
    shared_schema: 1, server_time: T(12, 1), since: null, watermark: T(12),
    tables: {
      ...tables,
      videos: [video(SV)],
      video_proposed_songs: [{ id: PS, name: "zz-test Song", english_name: null, alternate_titles: null, notes: null, created_by: null, created_at: T(5), updated_at: T(12) }],
    },
    replace_whole: ["album_tracks", "album_track_artists", "album_artists"],
    tombstones: [],
    archive_ids: { songs: ids("songs"), song_lyrics: ids("song_lyrics"), artists: ids("artists"), song_performances: ids("song_performances"), albums: ids("albums") },
  };
}

type Answer = { status: number; body: unknown } | "offline";

/** A mocked PostgREST: whoami and shared_changes_since, each answered by the current setter; records each p_since. */
function archive() {
  const m = {
    who: [] as Answer[],
    whoDefault: { status: 200, body: whoamiOf() } as Answer,
    pull: { status: 200, body: firstBundle() } as Answer,
    sinces: [] as (string | null)[],
    whoCalls: 0,
    fetchImpl: (async (url: string, init: RequestInit) => {
      const fn = new URL(url).pathname.split("/").pop();
      let a: Answer;
      if (fn === "video_whoami") {
        m.whoCalls++;
        a = m.who.shift() ?? m.whoDefault;
      } else if (fn === "shared_changes_since") {
        m.sinces.push(JSON.parse(String(init.body)).p_since);
        a = m.pull;
      } else a = { status: 404, body: {} };
      if (a === "offline") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(a.body), { status: a.status });
    }) as unknown as typeof fetch,
  };
  return m;
}
function whoamiOf(o: Record<string, unknown> = {}) {
  return { user_id: USER, email: "ed@example.org", display_name: "Ed", avatar_url: null, must_change_password: false, archive_role: "user", grant_level: "editor", granted_at: null, shared_schema: 1, server_time: T(12, 2), ...o };
}

function machine() {
  const db = openDb(":memory:", MIGRATIONS);
  const arch = archive();
  const clock = { ms: Date.now() };
  const sync = createSync(db, { url: "http://archive.test", key: "k" }, { fetchImpl: arch.fetchImpl, warn: () => {}, now: () => clock.ms });
  return { db, arch, clock, at: () => new Date(clock.ms).toISOString(), run: (full = false) => sync.request({ accessToken: TOKEN, full }) };
}
const count = (db: Db, t: string) => (db.query(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
const title = (db: Db, id: string) => (db.query("SELECT title FROM videos WHERE id = ?").get(id) as { title: string } | null)?.title;

describe("watermark math and the repair cases", () => {
  test("pullSince trails the watermark by 5 minutes; no readable watermark pulls everything", () => {
    expect(pullSince("2026-10-17T12:34:56.123456+00:00")).toBe("2026-10-17T12:29:56.123Z");
    expect(pullSince("2026-10-17 12:00:00+03")).toBe("2026-10-17T08:55:00.000Z");
    expect(pullSince(null)).toBeNull();
    expect(pullSince("not a time")).toBeNull();
  });
  test("full refetch: asked for, first Sync, Shared schema change, watermark older than retention", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    const o = { requested: false, watermark: "2026-10-17T11:00:00Z", syncedSchema: SHARED_SCHEMA, client: SHARED_SCHEMA, serverNowMs: now };
    expect(fullRefetchReason(o)).toBeNull();
    expect(fullRefetchReason({ ...o, requested: true })).toBe("requested");
    expect(fullRefetchReason({ ...o, watermark: null })).toBe("first");
    expect(fullRefetchReason({ ...o, syncedSchema: null })).toBe("schema");
    expect(fullRefetchReason({ ...o, syncedSchema: SHARED_SCHEMA - 1 })).toBe("schema");
    expect(fullRefetchReason({ ...o, watermark: new Date(now - TOMBSTONE_RETENTION_MS - 1).toISOString() })).toBe("retention");
    expect(fullRefetchReason({ ...o, watermark: new Date(now - TOMBSTONE_RETENTION_MS + 60_000).toISOString() })).toBeNull();
  });
  test("a coalesced follow-up keeps a queued full refetch full", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runs: boolean[] = [];
    const c = coalesce(
      async (a: { full: boolean }) => {
        runs.push(a.full);
        if (runs.length === 1) await gate;
        return a.full;
      },
      (a, b) => ({ full: a.full || b.full }),
    );
    const p = [c.request({ full: false }), c.request({ full: true }), c.request({ full: false })];
    release();
    await Promise.all(p);
    expect(runs).toEqual([false, true]);
  });
});

describe("a Sync pulls and applies (mocked PostgREST)", () => {
  test("first Sync pulls everything and fills the Local copy; the second pulls from watermark − 5 min", async () => {
    const { db, arch, run, at } = machine();
    const r1 = await run();
    expect(r1).toMatchObject({ ok: true, pulled: true, full: true, error: null });
    expect(arch.sinces).toEqual([null]);
    expect(count(db, "archive_song")).toBe(4);
    expect(count(db, "archive_performance")).toBe(8);
    expect(title(db, SV)).toBe("Shared one");
    expect(db.query("SELECT shared FROM video_local WHERE video_id = ?").get(SV)).toEqual({ shared: 1 });
    expect(r1.record).toMatchObject({ watermark: T(12), lastSyncAt: at() });
    expect(readSessionRecord(db)).toEqual(r1.record);
    expect(getMeta(db, SYNCED_SCHEMA_KEY)).toBe(String(SHARED_SCHEMA));

    // The second: a bumped Video, the overlap's repeat of the Proposed Song (same updated_at: skipped), its tombstone,
    // and archive_ids without one Song (a hard delete).
    const b = firstBundle();
    const [gone, ...kept] = b.archive_ids!.songs!;
    arch.pull = {
      status: 200,
      body: {
        shared_schema: 1, server_time: T(13, 1), since: "2026-10-11T23:55:00.000Z", watermark: T(13),
        tables: { videos: [video(SV, { title: "Bumped", updated_at: T(13) })], video_proposed_songs: b.tables!.video_proposed_songs },
        replace_whole: [], tombstones: [{ id: U(910), table_name: "video_proposed_songs", row_id: PS, kind: "deleted", replaced_by: null, at: T(13) }],
        archive_ids: { ...b.archive_ids, songs: kept },
      } satisfies SharedChanges,
    };
    const r2 = await run();
    expect(arch.sinces[1]).toBe("2026-10-11T23:55:00.000Z");
    expect(r2).toMatchObject({ ok: true, pulled: true, full: false });
    expect(r2.applied).toMatchObject({ tombstones: 1 });
    expect(r2.applied!.skipped.video_proposed_songs).toBe(1);
    expect(title(db, SV)).toBe("Bumped");
    expect(count(db, "video_proposed_songs")).toBe(0);
    expect(db.query("SELECT COUNT(*) n FROM archive_song WHERE id = ?").get(gone!)).toEqual({ n: 0 });
    expect(r2.record).toMatchObject({ watermark: T(13), lastSyncAt: at() });
  });

  test("the skip guard: a pull older than the row a write already applied here does not overwrite it", async () => {
    const { db, arch, run } = machine();
    await run();
    // An editor's write applied through /api/cache/apply at T(14); the overlap then re-sends the T(13) version.
    db.query("UPDATE videos SET title = 'Mine', updated_at = ? WHERE id = ?").run(T(14), SV);
    arch.pull = { status: 200, body: { shared_schema: 1, server_time: T(14, 1), watermark: T(13), tables: { videos: [video(SV, { title: "Older", updated_at: T(13) })] } } };
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.applied!.skipped.videos).toBe(1);
    expect(title(db, SV)).toBe("Mine");
  });

  test("an empty pull (the server's watermark = p_since) never moves the watermark back; last_sync_at is this machine's clock", async () => {
    const { db, arch, run, clock, at } = machine();
    await run();
    arch.pull = { status: 200, body: { shared_schema: 1, server_time: T(15), since: "2026-10-11T23:55:00.000Z", watermark: "2026-10-11T23:55:00.000Z", tables: {} } };
    clock.ms += 60_000;
    const r = await run();
    expect(r.record).toMatchObject({ watermark: T(12), lastSyncAt: at() });
    // ...so empty Syncs do not walk the pull window backwards 5 minutes at a time.
    await run();
    expect(arch.sinces.at(-1)).toBe("2026-10-11T23:55:00.000Z");
    expect(readSessionRecord(db)!.watermark).toBe(T(12));
  });
});

describe("failure rules (§6.2–§6.3)", () => {
  async function synced() {
    const m = machine();
    await m.run();
    return { ...m, before: readSessionRecord(m.db)! };
  }

  test("unreachable pull: nothing applied, watermark and last_sync_at untouched, reported", async () => {
    const { db, arch, run, before } = await synced();
    arch.pull = "offline";
    const r = await run();
    expect(r).toMatchObject({ ok: false, reachable: false, pulled: false, error: "The archive can't be reached" });
    expect(readSessionRecord(db)).toMatchObject({ watermark: before.watermark, lastSyncAt: before.lastSyncAt });
  });

  test("a batch that fails to apply rolls back whole (the bumped Video too) and leaves the watermark", async () => {
    const { db, arch, run, before } = await synced();
    arch.pull = {
      status: 200,
      body: {
        shared_schema: 1, server_time: T(13, 1), watermark: T(13), tables: { videos: [video(SV, { title: "Never", updated_at: T(13) })] },
        tombstones: [{ id: U(911), table_name: "videos" as never, row_id: SV, kind: "deleted", replaced_by: null, at: T(13) }],
      },
    };
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Sync failed, nothing was applied: tombstone for an unknown table/);
    expect(title(db, SV)).toBe("Shared one");
    expect(readSessionRecord(db)!.watermark).toBe(before.watermark);
  });

  test("a 401 on the pull is reported as unauthorized (the browser then runs the revocation probe)", async () => {
    const { arch, run } = await synced();
    arch.pull = { status: 401, body: { code: "PGRST301", message: "JWT expired" } };
    expect(await run()).toMatchObject({ ok: false, reachable: true, unauthorized: true, pulled: false });
  });

  test("a permission error re-reads the grant and updates the record", async () => {
    const { db, arch, run } = await synced();
    arch.pull = { status: 403, body: { code: "42501", message: "permission denied" } };
    arch.who = [{ status: 200, body: whoamiOf() }, { status: 200, body: whoamiOf({ grant_level: null }) }];
    const n = arch.whoCalls;
    const r = await run();
    expect(arch.whoCalls - n).toBe(2);
    expect(r).toMatchObject({ ok: false, error: "This account no longer has access to the shared library" });
    expect(readSessionRecord(db)!.grantLevel).toBeNull();
  });

  test("a batch of another Shared schema is refused whole; the schema pair names it", async () => {
    const { db, arch, run, before } = await synced();
    arch.pull = { status: 200, body: { ...firstBundle(), shared_schema: 2, tables: { videos: [video(SV, { title: "Never", updated_at: T(20) })] } } };
    const r = await run();
    expect(r).toMatchObject({ ok: false, schema: { client: 1, archive: 2 }, error: "Update TuvaVideos: git pull, then restart" });
    expect(title(db, SV)).toBe("Shared one");
    expect(readSessionRecord(db)!.watermark).toBe(before.watermark);
  });

  test("the whoami schema gate stops before the pull", async () => {
    const { arch, run } = await synced();
    arch.whoDefault = { status: 200, body: whoamiOf({ shared_schema: 2 }) };
    const n = arch.sinces.length;
    expect(await run()).toMatchObject({ ok: false, pulled: false, error: "Update TuvaVideos: git pull, then restart" });
    expect(arch.sinces.length).toBe(n);
  });

  test("an account without the grant pulls nothing", async () => {
    const { arch, run } = machine();
    arch.whoDefault = { status: 200, body: whoamiOf({ grant_level: null }) };
    expect(await run()).toMatchObject({ ok: false, reachable: true, pulled: false });
    expect(arch.sinces).toEqual([]);
  });
});

describe("repair: Refresh all Shared data and the other full refetches (§6.4)", () => {
  test("full: wipes the Shared rows in the apply's transaction; Shared Videos are overwritten, not deleted; Unshared ones stay", async () => {
    const { db, arch, run } = machine();
    await run();
    db.exec("INSERT INTO root (id, path, kind) VALUES (1, '/r', 'local')");
    insertCopy(db, { video_id: SV, root_id: 1, rel_path: "a.mp4" });
    db.query("UPDATE video_local SET favorited_at = ? WHERE video_id = ?").run(T(11), SV);
    db.query("UPDATE videos SET title = 'Drifted', updated_at = ? WHERE id = ?").run(T(30), SV); // newer than anything the archive holds
    const local = insertVideo(db, { content_hash: "h-local", title: "Unshared one" });
    db.query("INSERT INTO archive_song (id, name, slug, is_hidden, updated_at) VALUES ('zz-stray', 'Stray', 'stray', 0, ?)").run(T(1));
    arch.pull = { status: 200, body: { ...firstBundle(), archive_ids: undefined, server_time: T(16) } }; // no reconcile: only the wipe can drop the stray row
    const r = await run(true);
    expect(arch.sinces.at(-1)).toBeNull();
    expect(r).toMatchObject({ ok: true, full: true, pulled: true });
    expect(title(db, SV)).toBe("Shared one");
    expect(db.query("SELECT favorited_at FROM video_local WHERE video_id = ?").get(SV)).toEqual({ favorited_at: T(11) });
    expect(count(db, "copy")).toBe(1);
    expect(title(db, local)).toBe("Unshared one");
    expect(db.query("SELECT COUNT(*) n FROM archive_song WHERE id = 'zz-stray'").get()).toEqual({ n: 0 });
    expect(count(db, "archive_song")).toBe(4);
  });

  test("a failed full refetch wipes nothing", async () => {
    const { db, arch, run } = machine();
    await run();
    arch.pull = { status: 200, body: { ...firstBundle(), tombstones: [{ id: U(1), table_name: "nope" as never, row_id: "x", kind: "deleted", replaced_by: null, at: T(1) }] } };
    expect((await run(true)).ok).toBe(false);
    expect(count(db, "archive_song")).toBe(4);
    expect(count(db, "video_proposed_songs")).toBe(1);
  });

  test("a Shared schema change since the last pull refetches everything", async () => {
    const { db, arch, run } = machine();
    await run();
    await run();
    expect(arch.sinces[1]).not.toBeNull();
    setMeta(db, SYNCED_SCHEMA_KEY, String(SHARED_SCHEMA - 1));
    const r = await run();
    expect(arch.sinces[2]).toBeNull();
    expect(r.full).toBe(true);
  });
});

describe("the browser's triggers and Sync state (§6.4, pure)", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const rec = (o: Partial<SessionRecord> = {}): SessionRecord => ({
    userId: "u-1", email: null, displayName: null, avatarUrl: null, grantLevel: "editor", archiveRole: null, lastVerifiedAt: null,
    lastSyncAt: new Date(now - 60_000).toISOString(), watermark: null, ...o,
  });
  const st = (o: Partial<SessionState> = {}): SessionState => ({ ...INITIAL_SESSION_STATE, record: rec(), authSettled: true, browser: { userId: "u-1", expiresAt: null }, ...o });

  test("sign-in always; the others only for the record's own user; launch once settled", () => {
    expect(syncWanted("sign-in", st({ record: null, browser: null }), now)).toBe(true);
    for (const t of ["launch", "after-write", "button", "refresh-all", "focus"] as const) {
      expect(syncWanted(t, st({ record: null }), now)).toBe(false);
      expect(syncWanted(t, st({ browser: { userId: "someone-else", expiresAt: null } }), now)).toBe(false);
    }
    expect(syncWanted("launch", st(), now)).toBe(true);
    expect(syncWanted("launch", st({ authSettled: false }), now)).toBe(false);
    expect(syncWanted("after-write", st(), now)).toBe(true);
    expect(syncWanted("button", st({ failures: 3, lastFailureAt: now }), now)).toBe(true);
    expect(syncWanted("refresh-all", st(), now)).toBe(true);
  });

  test("focus: only when the last successful Sync is older than 10 minutes, and after failures once the back-off passed", () => {
    expect(syncWanted("focus", st(), now)).toBe(false);
    const stale = rec({ lastSyncAt: new Date(now - FOCUS_SYNC_AFTER_MS - 1).toISOString() });
    expect(syncWanted("focus", st({ record: stale }), now)).toBe(true);
    expect(syncWanted("focus", st({ record: rec({ lastSyncAt: null }) }), now)).toBe(true);
    expect(syncWanted("focus", st({ record: stale, failures: 1, lastFailureAt: now - 30_000 }), now)).toBe(false);
    expect(syncWanted("focus", st({ record: stale, failures: 1, lastFailureAt: now - 60_000 }), now)).toBe(true);
    expect(syncWanted("focus", st({ record: stale, failures: 3, lastFailureAt: now - 200_000 }), now)).toBe(false);
    expect([1, 2, 3, 4, 5, 9].map(syncBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
    expect(syncBackoffMs(0)).toBe(0);
  });

  test("the reducer: progress through the phases, failures counted and reset, the schema mismatch set and cleared", () => {
    let s = sessionReducer(st(), { type: "sync-start", full: true, at: 5 });
    expect(s).toMatchObject({ syncing: true, progress: { phase: "checking", full: true, startedAt: 5 } });
    s = sessionReducer(s, { type: "sync-phase", phase: "pulling" });
    expect(s.progress!.phase).toBe("pulling");
    s = sessionReducer(s, { type: "sync-end", reachable: true, error: "Update TuvaVideos: git pull, then restart", schema: { client: 1, archive: 2 }, at: 9 });
    expect(s).toMatchObject({ syncing: false, progress: null, failures: 1, lastFailureAt: 9 });
    expect(s.schemaMismatch).toEqual({ client: 1, archive: 2, behind: true, line: "Update TuvaVideos: git pull, then restart" });
    // an offline Sync (whoami never answered) keeps the banner
    s = sessionReducer(s, { type: "sync-end", reachable: false, error: "The archive can't be reached", schema: { client: 1, archive: null }, at: 10 });
    expect(s.schemaMismatch?.behind).toBe(true);
    expect(s.failures).toBe(2);
    s = sessionReducer(s, { type: "sync-end", reachable: true, error: null, schema: { client: 1, archive: 1 } });
    expect(s).toMatchObject({ schemaMismatch: null, failures: 0, lastFailureAt: null, lastSyncError: null });
    const ahead = sessionReducer(s, { type: "sync-end", reachable: true, error: "x", schema: { client: 2, archive: 1 } });
    expect(ahead.schemaMismatch).toMatchObject({ behind: false });
    expect(sessionReducer(ahead, { type: "signed-out" })).toMatchObject({ schemaMismatch: null, progress: null, failures: 0 });
    expect(sessionReducer(st(), { type: "sync-phase", phase: "pulling" }).progress).toBeNull();
  });
});
