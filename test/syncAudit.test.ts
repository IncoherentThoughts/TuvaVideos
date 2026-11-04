// Regression tests for the sync and shared-data audit (docs/audit/02-sync-shared-data.md, SYNC-1 to SYNC-16, and
// DOC-2 of 08-spec-drift.md). Each one failed on the audited commit (2f7b8bf) and passes with its fix.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/server/db";
import { applyShared } from "../src/server/localCopy/apply";
import { clearSessionRecord, getMeta, readSessionRecord, setMeta, writeSessionRecord } from "../src/server/localCopy/meta";
import { createReconcile, reconcileBatch, planFor } from "../src/server/reconcile";
import { createSync, wipeShared } from "../src/server/sync";
import type { SharedChanges, SharedChapterRow, SharedVideoRow } from "../src/shared/sharedRows";
import { editAccess, schemaMismatchOf } from "../src/shared/session";
import { SHARED_VIDEO_LOCAL_EDIT } from "../src/shared/share";
import { confirmVideoArtists, patchVideo, setVideoArtists } from "../src/server/edit";
import { addChapter, confirmAll, deleteChapter, patchChapter } from "../src/server/chapters/store";
import { C, insertChapter, insertCopy, insertVideo, V } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const T = (d: number) => `2026-10-${String(d).padStart(2, "0")}T00:00:00.000000+00:00`;
const sv = (id: string, o: Partial<SharedVideoRow> = {}): SharedVideoRow => ({
  id, youtube_id: null, content_hash: `hash-${id}`, instagram_id: null, rutube_id: null, title: "Shared one", title_latin: null, title_latin_source: null,
  type: "song", type_suggested: false, song_id: null, proposed_song_id: null, version_id: null, proposed_version_id: null, song_suggested: false,
  suggestion_source: null, poster_path: null, deleted_at: null, deleted_by: null, delete_reason: null, created_at: T(1), updated_at: T(10), ...o,
});
const sc = (id: string, video_id: string, start_s: number, title: string, o: Partial<SharedChapterRow> = {}): SharedChapterRow => ({
  id, video_id, start_s, title, title_latin: null, song_id: null, proposed_song_id: null, version_id: null, proposed_version_id: null, suggested: false,
  source: "manual", created_at: T(1), updated_at: T(10), ...o,
});
const batch = (videos: SharedVideoRow[], chapters: SharedChapterRow[] = [], o: Partial<SharedChanges> = {}): SharedChanges => ({
  shared_schema: 1, server_time: T(12), since: null, watermark: T(12), tables: { videos, video_chapters: chapters }, ...o,
});
const fresh = (): Db => {
  const db = openDb(":memory:", MIGRATIONS);
  db.exec(`INSERT INTO root (id, path, kind) VALUES (1, '/r', 'local')`);
  return db;
};
const stampOf = (db: Db, table: string, id: string) => (db.query(`SELECT updated_at FROM ${table} WHERE id = ?`).get(id) as { updated_at: string } | null)?.updated_at;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64({ alg: "HS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, sub: "u" })}.c2ln`;
const USER = "11111111-1111-4111-8111-111111111111";
const whoamiOf = (o: Record<string, unknown> = {}) => ({
  user_id: USER, email: "ed@example.org", display_name: "Ed", avatar_url: null, must_change_password: false, archive_role: "user",
  grant_level: "editor", granted_at: null, shared_schema: 1, server_time: T(12), ...o,
});
type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
/** A mocked PostgREST: one handler per function (a thrown error is an unreachable archive). */
function fakeArchive(h: { whoami?: Handler; pull?: Handler }) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const fn = new URL(url).pathname.split("/").pop()!;
    calls.push(fn);
    const args = JSON.parse(String(init.body ?? "{}"));
    const body = fn === "video_whoami" ? await (h.whoami ?? (() => whoamiOf()))(args) : fn === "shared_changes_since" ? await (h.pull ?? (() => batch([])))(args) : null;
    return new Response(JSON.stringify(body), { status: body == null ? 404 : 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const ENDPOINT = { url: "http://archive.test", key: "k" };

const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const CH1 = "cccccccc-0000-4000-8000-000000000001";
const CH2 = "cccccccc-0000-4000-8000-000000000002";

describe("SYNC-2: an apply never restamps a row with this machine's clock", () => {
  test("a bumped Video's unchanged Chapter keeps the archive's stamp", () => {
    const db = fresh();
    applyShared(db, batch([sv(S1)], [sc(CH1, S1, 0, "A")]));
    applyShared(db, batch([sv(S1, { updated_at: T(11) })], [sc(CH1, S1, 0, "A"), sc(CH2, S1, 30, "B", { updated_at: T(11) })]));
    expect(stampOf(db, "video_chapters", CH1)).toBe(T(10));
    expect(stampOf(db, "video_chapters", CH2)).toBe(T(11));
  });

  test("a full refetch (wipe + apply) keeps every Chapter's and Artist link's stamp", () => {
    const db = fresh();
    const link = { id: "dddddddd-0000-4000-8000-000000000001", video_id: S1, artist_id: "00000000-0000-4000-8000-000000000777", proposed_artist_id: null, position: 0, suggested: false, created_at: T(1), updated_at: T(10) };
    const b = batch([sv(S1)], [sc(CH1, S1, 0, "A")]);
    b.tables!.video_artists = [link as never];
    applyShared(db, b);
    db.transaction(() => {
      wipeShared(db);
      applyShared(db, b);
    })();
    expect(stampOf(db, "video_chapters", CH1)).toBe(T(10));
    expect(stampOf(db, "video_artists", link.id)).toBe(T(10));
    expect(stampOf(db, "videos", S1)).toBe(T(10));
  });

  test("a local edit still stamps, and no apply flag is left behind", () => {
    const db = fresh();
    applyShared(db, batch([sv(S1)], [sc(CH1, S1, 0, "A")]));
    db.query("UPDATE video_chapters SET title = 'local' WHERE id = ?").run(CH1);
    expect(stampOf(db, "video_chapters", CH1)).not.toBe(T(10));
    expect(db.query("SELECT COUNT(*) AS n FROM meta WHERE key = 'applying_shared'").get()).toEqual({ n: 0 });
  });

  test("a failed apply leaves no apply flag either", () => {
    const db = fresh();
    expect(() => applyShared(db, { tables: { videos: [sv(S1)] }, tombstones: [{ table_name: "nope" } as never] })).toThrow();
    expect(db.query("SELECT COUNT(*) AS n FROM meta WHERE key = 'applying_shared'").get()).toEqual({ n: 0 });
  });
});

describe("SYNC-1: legacy uuids are not identity across machines", () => {
  const OTHER = "aaaaaaaa-0000-4000-8000-000000000099";

  test("another machine's Video #1 joins its real Shared Video, not the owner's Video #1", () => {
    const db = fresh();
    const L = insertVideo(db, { id: 1, title: "Collaborator clip", youtube_id: "COLLAB_YT" });
    insertCopy(db, { video_id: L, root_id: 1, rel_path: "collab [COLLAB_YT].mp4" });
    const b = batch([sv(V(1), { youtube_id: "OWNER_YT", content_hash: null, title: "Owner clip" }), sv(OTHER, { youtube_id: "COLLAB_YT", content_hash: null, title: "Collaborator clip (shared)" })]);
    expect(planFor(db, b).matches).toEqual([{ localId: V(1), sharedId: OTHER, by: "youtube_id" }]);
    db.transaction(() => {
      reconcileBatch(db, b);
      applyShared(db, b);
    })();
    const copy = db.query("SELECT c.rel_path, v.id, v.youtube_id FROM copy c JOIN videos v ON v.id = c.video_id").get();
    expect(copy).toEqual({ rel_path: "collab [COLLAB_YT].mp4", id: OTHER, youtube_id: "COLLAB_YT" });
    expect(db.query("SELECT youtube_id, title FROM videos WHERE id = ?").get(V(1))).toEqual({ youtube_id: "OWNER_YT", title: "Owner clip" });
  });

  test("an unknown local Video under a Shared id moves to a fresh id instead of being overwritten", () => {
    const db = fresh();
    const L = insertVideo(db, { id: 1, title: "Mine only", content_hash: "mine" });
    insertCopy(db, { video_id: L, root_id: 1, rel_path: "mine.mp4" });
    db.query("UPDATE video_local SET favorited_at = '2026-09-01T00:00:00Z' WHERE video_id = ?").run(L);
    const b = batch([sv(V(1), { content_hash: "owner", title: "Owner clip" })]);
    db.transaction(() => {
      reconcileBatch(db, b);
      applyShared(db, b);
    })();
    const mine = db.query("SELECT v.id, v.title, v.content_hash, l.favorited_at, l.shared FROM copy c JOIN videos v ON v.id = c.video_id JOIN video_local l ON l.video_id = v.id").get() as any;
    expect(mine.id).not.toBe(V(1));
    expect(mine).toMatchObject({ title: "Mine only", content_hash: "mine", favorited_at: "2026-09-01T00:00:00Z", shared: 0 });
    expect(db.query("SELECT title, content_hash FROM videos WHERE id = ?").get(V(1))).toEqual({ title: "Owner clip", content_hash: "owner" });
  });

  test("the same applies to a cache apply, without a reconcile step", () => {
    const db = fresh();
    insertVideo(db, { id: 1, title: "Mine only", content_hash: "mine", updated_at: "2020-01-01T00:00:00.000Z" });
    applyShared(db, batch([sv(V(1), { content_hash: "owner", title: "Owner clip" })]));
    expect(db.query("SELECT title FROM videos WHERE id = ?").get(V(1))).toEqual({ title: "Owner clip" });
    expect(db.query("SELECT COUNT(*) AS n FROM videos WHERE title = 'Mine only' AND content_hash = 'mine'").get()).toEqual({ n: 1 });
  });

  test("a Shared Chapter whose id an Unshared Video's Chapter holds no longer steals it", () => {
    const db = fresh();
    const L = insertVideo(db, { title: "Unknown to the Shared set", content_hash: "local-only" });
    insertChapter(db, { id: 5, video_id: L, start_s: 12, title: "My local chapter", favorited_at: "2026-09-01T00:00:00Z" });
    const b = batch([sv(S1, { content_hash: "owner-hash" })], [sc(C(5), S1, 99, "Owner chapter")]);
    db.transaction(() => {
      reconcileBatch(db, b);
      applyShared(db, b);
    })();
    expect(db.query("SELECT video_id, title FROM video_chapters WHERE id = ?").get(C(5))).toEqual({ video_id: S1, title: "Owner chapter" });
    const mine = db.query("SELECT c.id, c.title, cl.favorited_at FROM video_chapters c LEFT JOIN chapter_local cl ON cl.chapter_id = c.id WHERE c.video_id = ?").all(L) as any[];
    expect(mine.length).toBe(1);
    expect(mine[0].id).not.toBe(C(5));
    expect(mine[0]).toMatchObject({ title: "My local chapter", favorited_at: "2026-09-01T00:00:00Z" });
  });

  test("the owner's machine (same id, same identity) still matches by id and keeps its id", () => {
    const db = fresh();
    const L = insertVideo(db, { id: 1, title: "Owner clip", youtube_id: "OWNER_YT" });
    insertChapter(db, { id: 5, video_id: L, start_s: 12, title: "Intro", favorited_at: "2026-09-01T00:00:00Z" });
    const b = batch([sv(V(1), { youtube_id: "OWNER_YT", content_hash: null, title: "Owner clip" })], [sc(C(5), V(1), 12, "Intro")]);
    expect(planFor(db, b).matches).toEqual([{ localId: V(1), sharedId: V(1), by: "id" }]);
    db.transaction(() => {
      reconcileBatch(db, b);
      applyShared(db, b);
    })();
    expect(db.query("SELECT id FROM videos").all()).toEqual([{ id: V(1) }]);
    expect(db.query("SELECT chapter_id, favorited_at FROM chapter_local").all()).toEqual([{ chapter_id: C(5), favorited_at: "2026-09-01T00:00:00Z" }]);
  });

  test("a drained insert coming back under its own id stays the same row", () => {
    const db = fresh();
    const id = insertVideo(db, { title: "Scanned", youtube_id: "YT9", pending_share: 1 });
    const ch = insertChapter(db, { video_id: id, start_s: 3, title: "One" });
    db.query("UPDATE videos SET updated_at = '2026-10-01T00:00:00.000Z' WHERE id = ?").run(id);
    applyShared(db, batch([sv(id, { youtube_id: "YT9", content_hash: null, title: "Scanned" })], [sc(ch, id, 3, "One")]));
    expect(db.query("SELECT id FROM videos").all()).toEqual([{ id }]);
    expect(db.query("SELECT id FROM video_chapters").all()).toEqual([{ id: ch }]);
  });

  test("a Local Artist whose legacy id a differently named Proposed Artist brings moves away, with its links", () => {
    const db = fresh();
    const LA1 = "61727400-0000-8000-8000-000000000003";
    db.query("INSERT INTO local_artist (id, name, created_at) VALUES (?, 'Collab artist', '2026-01-01')").run(LA1);
    const L = insertVideo(db, { title: "Mine", content_hash: "mine" });
    db.query("INSERT INTO video_artists (id, video_id, artist_id, position, suggested, updated_at) VALUES ('va-1', ?, ?, 0, 0, '2026-01-01')").run(L, LA1);
    applyShared(db, { tables: { video_proposed_artists: [{ id: LA1, name: "Owner artist", created_at: T(1), updated_at: T(10) } as never] } });
    expect(db.query("SELECT kind, name FROM artist_all WHERE id = ?").all(LA1)).toEqual([{ kind: "proposed", name: "Owner artist" }]);
    const link = db.query("SELECT a.name, a.kind FROM video_artists va JOIN artist_all a ON a.id = va.artist_id WHERE va.video_id = ?").get(L);
    expect(link).toEqual({ name: "Collab artist", kind: "local" });
  });

  test("a Sync renames the moved Video's thumbnail files, so the Shared Video does not show them", async () => {
    const db = fresh();
    const dir = mkdtempSync(join(tmpdir(), "tuva-sync1-"));
    try {
      insertVideo(db, { id: 1, title: "Mine only", content_hash: "mine", thumbnail_generated_at: "2026-09-01T00:00:00Z" });
      writeFileSync(join(dir, `${V(1)}.poster.webp`), "mine");
      writeSessionRecord(db, { userId: USER, grantLevel: "editor" });
      const a = fakeArchive({ pull: () => batch([sv(V(1), { content_hash: "owner", title: "Owner clip" })]) });
      const r = await createSync(db, ENDPOINT, { fetchImpl: a.fetchImpl, warn: () => {}, thumbsDir: dir }).request({ accessToken: TOKEN });
      expect(r.error).toBeNull();
      const mine = db.query("SELECT v.id, l.thumbnail_generated_at FROM videos v JOIN video_local l ON l.video_id = v.id WHERE v.title = 'Mine only'").get() as any;
      expect(mine.id).not.toBe(V(1));
      expect(mine.thumbnail_generated_at).toBe("2026-09-01T00:00:00Z");
      expect(readdirSync(dir).filter((f) => f.endsWith(".webp"))).toEqual([`${mine.id}.poster.webp`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the owner's own Local Artist that became the Proposed Artist of its id (same name) stays where it is", () => {
    const db = fresh();
    const LA1 = "61727400-0000-8000-8000-000000000003";
    db.query("INSERT INTO local_artist (id, name, created_at) VALUES (?, 'Collab artist', '2026-01-01')").run(LA1);
    applyShared(db, { tables: { video_proposed_artists: [{ id: LA1, name: "collab ARTIST", created_at: T(1), updated_at: T(10) } as never] } });
    expect(db.query("SELECT id FROM local_artist").all()).toEqual([{ id: LA1 }]);
  });
});

describe("SYNC-4: a Shared Video the archive no longer returns no longer wedges Sync", () => {
  const OLD = "aaaaaaaa-0000-4000-8000-0000000000a1";
  const NEW = "aaaaaaaa-0000-4000-8000-0000000000a2";
  const seed = (db: Db) => {
    applyShared(db, batch([sv(OLD, { youtube_id: "YT", content_hash: null })], [sc(CH1, OLD, 0, "stale")]));
    insertCopy(db, { video_id: OLD, root_id: 1, rel_path: "clip [YT].mp4" });
    db.query("UPDATE video_local SET favorited_at = '2026-09-09T00:00:00Z' WHERE video_id = ?").run(OLD);
  };
  const b = batch([sv(NEW, { youtube_id: "YT", content_hash: null, title: "Shared again", updated_at: T(11) })]);

  test("an incremental pull: the new row takes the key, the Copy and the Favorite", () => {
    const db = fresh();
    seed(db);
    db.transaction(() => {
      reconcileBatch(db, b);
      applyShared(db, b);
    })();
    expect(db.query("SELECT id, title FROM videos").all()).toEqual([{ id: NEW, title: "Shared again" }]);
    expect(db.query("SELECT video_id FROM copy").all()).toEqual([{ video_id: NEW }]);
    expect(db.query("SELECT favorited_at, shared FROM video_local WHERE video_id = ?").get(NEW)).toEqual({ favorited_at: "2026-09-09T00:00:00Z", shared: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM video_chapters").get()).toEqual({ n: 0 });
  });

  test("a full refetch (wipe + apply) too", () => {
    const db = fresh();
    seed(db);
    db.transaction(() => {
      wipeShared(db);
      reconcileBatch(db, b);
      applyShared(db, b);
    })();
    expect(db.query("SELECT id FROM videos").all()).toEqual([{ id: NEW }]);
  });

  test("(an Unshared Video holding the key: see below)", () => {});
});

describe("SYNC-3: no Sync runs while the sign-in confirmation waits for Continue", () => {
  const shared = () => batch([sv(S1, { youtube_id: "YT1", content_hash: null, title: "Shared title", type: "concert" })]);
  const machine = () => {
    const db = fresh();
    const L = insertVideo(db, { title: "My own title", youtube_id: "YT1", type: "song", type_suggested: 0, suggestion_source: "manual" });
    const a = fakeArchive({ pull: shared });
    return {
      db, L, a,
      reconcile: createReconcile(db, ENDPOINT, { fetchImpl: a.fetchImpl, warn: () => {} }),
      sync: createSync(db, ENDPOINT, { fetchImpl: a.fetchImpl, warn: () => {} }),
    };
  };

  test("a focus Sync after the preview is refused and reconciles nothing; Continue then runs it", async () => {
    const m = machine();
    const p = await m.reconcile.preview(TOKEN);
    expect(p.ok).toBe(true);
    expect(p.counts.shelved).toBeGreaterThan(0);
    const r = await m.sync.request({ accessToken: TOKEN });
    expect(r.ok).toBe(false);
    expect(r.pulled).toBe(false);
    expect(m.db.query("SELECT COUNT(*) AS n FROM shelved_edit").get()).toEqual({ n: 0 });
    expect(m.db.query("SELECT id FROM videos").all()).toEqual([{ id: m.L }]);
    expect((await m.reconcile.confirm(TOKEN)).ok).toBe(true);
    expect((await m.sync.request({ accessToken: TOKEN })).ok).toBe(true);
  });

  test("Cancel (the record cleared) leaves the library as it was, and Syncs are no longer blocked", async () => {
    const m = machine();
    await m.reconcile.preview(TOKEN);
    clearSessionRecord(m.db);
    expect(m.db.query("SELECT id FROM videos").all()).toEqual([{ id: m.L }]);
    expect(getMeta(m.db, "reconcile_pending")).toBeNull();
  });

  test("a no-grant preview leaves nothing pending", async () => {
    const db = fresh();
    const a = fakeArchive({ whoami: () => whoamiOf({ grant_level: null }) });
    await createReconcile(db, ENDPOINT, { fetchImpl: a.fetchImpl }).preview(TOKEN);
    expect(getMeta(db, "reconcile_pending")).toBeNull();
  });
});

describe("SYNC-7: a Sign out during a Sync (or a reconciliation) is not undone", () => {
  test("the record cleared while the pull is on the wire: nothing applied, no record written", async () => {
    const db = fresh();
    writeSessionRecord(db, { userId: USER, grantLevel: "member" });
    const a = fakeArchive({
      whoami: () => whoamiOf({ grant_level: "member" }),
      pull: () => {
        clearSessionRecord(db);
        return batch([sv(S1)]);
      },
    });
    const r = await createSync(db, ENDPOINT, { fetchImpl: a.fetchImpl, warn: () => {} }).request({ accessToken: TOKEN });
    expect(r.ok).toBe(false);
    expect(readSessionRecord(db)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM videos").get()).toEqual({ n: 0 });
  });

  test("the record cleared while whoami is on the wire: no record comes back", async () => {
    const db = fresh();
    writeSessionRecord(db, { userId: USER, grantLevel: "member" });
    const a = fakeArchive({
      whoami: () => {
        clearSessionRecord(db);
        return whoamiOf({ grant_level: "member" });
      },
    });
    await createSync(db, ENDPOINT, { fetchImpl: a.fetchImpl, warn: () => {} }).request({ accessToken: TOKEN });
    expect(readSessionRecord(db)).toBeNull();
  });

  test("Cancel while Continue's pull is on the wire: nothing reconciled, no record", async () => {
    const db = fresh();
    const L = insertVideo(db, { title: "Mine", youtube_id: "YT1" });
    let pulls = 0;
    const a = fakeArchive({
      pull: () => {
        if (++pulls === 2) clearSessionRecord(db);
        return batch([sv(S1, { youtube_id: "YT1", content_hash: null })]);
      },
    });
    let clock = Date.now();
    const rc = createReconcile(db, ENDPOINT, { fetchImpl: a.fetchImpl, warn: () => {}, now: () => clock });
    await rc.preview(TOKEN);
    clock += 11 * 60_000; // past the preview's reuse window: Continue pulls again
    const c = await rc.confirm(TOKEN);
    expect(c.ok).toBe(false);
    expect(readSessionRecord(db)).toBeNull();
    expect(db.query("SELECT id FROM videos").all()).toEqual([{ id: L }]);
  });
});

describe("SYNC-5: a drained insert is applied even when this machine's clock is ahead", () => {
  test("the queued Video takes the Proposed Song and the archive's stamp and link ids", () => {
    const db = fresh();
    db.exec(`INSERT INTO local_song (id, name, created_at) VALUES ('ls-1', 'Local song', '2026-10-01')`);
    const id = insertVideo(db, { title: "Scanned", youtube_id: "YT9", song_id: "ls-1", type: "song", pending_share: 1 });
    db.query("INSERT INTO video_artists (id, video_id, artist_id, position, suggested, updated_at) VALUES ('local-link', ?, 'x', 0, 0, '2026-10-10T00:00:05.000Z')").run(id);
    db.query("UPDATE videos SET updated_at = ? WHERE id = ?").run("2026-10-10T00:00:05.000Z", id); // machine clock 5 s ahead
    const P = "bbbbbbbb-0000-4000-8000-000000000001";
    const stamp = "2026-10-10T00:00:02.000000+00:00";
    const r = applyShared(db, {
      tables: {
        video_proposed_songs: [{ id: P, name: "Local song", english_name: null, alternate_titles: null, notes: null, created_by: null, created_at: T(10), updated_at: T(10) } as never],
        videos: [sv(id, { youtube_id: "YT9", content_hash: null, title: "Scanned", proposed_song_id: P, updated_at: stamp })],
        video_artists: [{ id: "server-link", video_id: id, artist_id: "x", proposed_artist_id: null, position: 0, suggested: false, created_at: stamp, updated_at: stamp } as never],
      },
    });
    expect(r.skipped.videos ?? 0).toBe(0);
    expect(db.query("SELECT song_id, proposed_song_id, updated_at FROM videos WHERE id = ?").get(id)).toEqual({ song_id: null, proposed_song_id: P, updated_at: stamp });
    expect(db.query("SELECT id FROM video_artists WHERE video_id = ?").all(id)).toEqual([{ id: "server-link" }]);
    expect(db.query("SELECT shared, pending_share FROM video_local WHERE video_id = ?").get(id)).toEqual({ shared: 1, pending_share: 0 });
  });
  test("a Shared row is still guarded (an older pull does not overwrite a newer cache apply)", () => {
    const db = fresh();
    applyShared(db, batch([sv(S1, { title: "newer", updated_at: T(11) })]));
    expect(applyShared(db, batch([sv(S1, { title: "older", updated_at: T(10) })])).skipped.videos).toBe(1);
  });
});

describe("DOC-2: the scan's default Type `song` is not a person's edit", () => {
  const sharedConcert = () => batch([sv(S1, { youtube_id: "YT1", content_hash: null, title: "T", type: "concert" })]);
  const shelvedKinds = (db: Db) => (db.query("SELECT kind FROM shelved_edit ORDER BY id").all() as { kind: string }[]).map((r) => r.kind);
  const run = (db: Db) => db.transaction(() => {
    reconcileBatch(db, sharedConcert());
    applyShared(db, sharedConcert());
  })();
  test("an untouched scanned Video (Type song) shelves no Type", () => {
    const db = fresh();
    insertVideo(db, { title: "T", youtube_id: "YT1", type: "song" });
    expect(planFor(db, sharedConcert()).shelve).toEqual([]);
    run(db);
    expect(shelvedKinds(db)).toEqual([]);
  });
  test("a matcher's Suggested Type shelves nothing either", () => {
    const db = fresh();
    insertVideo(db, { title: "T", youtube_id: "YT1", type: "interview", type_suggested: 1, suggestion_source: "performance" });
    run(db);
    expect(shelvedKinds(db)).toEqual([]);
  });
  test("a Type the person set (even `song`) is shelved", () => {
    const db = fresh();
    const L = insertVideo(db, { title: "T", youtube_id: "YT1", type: "other" });
    expect(patchVideo(db, L, { type: "song" })).toEqual({ ok: true });
    run(db);
    expect(shelvedKinds(db)).toEqual(["type"]);
  });
});

describe("SYNC-6: the companion's local edit routes refuse a Shared Video", () => {
  test("Video header, Artists and Chapter routes answer 409; the Shared row is untouched", () => {
    const db = fresh();
    applyShared(db, batch([sv(S1, { title: "Server title" })], [sc(CH1, S1, 0, "A")]));
    const refused = { ok: false as const, status: 409, error: SHARED_VIDEO_LOCAL_EDIT };
    expect(patchVideo(db, S1, { title: "Local fork" })).toEqual(refused);
    expect(setVideoArtists(db, S1, [])).toEqual(refused);
    expect(confirmVideoArtists(db, S1)).toEqual(refused);
    expect(addChapter(db, S1, { startS: 10, title: "x" })).toEqual(refused);
    expect(patchChapter(db, CH1, { title: "x" })).toEqual(refused);
    expect(deleteChapter(db, CH1)).toEqual(refused);
    expect(confirmAll(db, S1)).toEqual(refused);
    expect(db.query("SELECT title, updated_at FROM videos WHERE id = ?").get(S1)).toEqual({ title: "Server title", updated_at: T(10) });
    expect(db.query("SELECT title FROM video_chapters WHERE id = ?").get(CH1)).toEqual({ title: "A" });
  });
  test("an Unshared Video is still edited locally", () => {
    const db = fresh();
    const L = insertVideo(db, { title: "Mine", content_hash: "m" });
    expect(patchVideo(db, L, { title: "Mine 2" })).toEqual({ ok: true });
    expect(addChapter(db, L, { startS: 10, title: "x" }).ok).toBe(true);
  });
});

describe("SYNC-8: the schema gate stops writes as it stops Sync", () => {
  const editorState = {
    record: { userId: USER, grantLevel: "editor" } as never, authSettled: true, browser: { userId: USER, expiresAt: null }, reachable: true,
  };
  test("edit controls are disabled while the schemas disagree", () => {
    expect(editAccess(editorState, Date.now()).enabled).toBe(true);
    expect(editAccess({ ...editorState, schemaMismatch: schemaMismatchOf(1, 2) }, Date.now())).toEqual({ shown: true, enabled: false });
  });
  test("a cache apply without shared_schema is refused once whoami reported another schema", async () => {
    const db = fresh();
    writeSessionRecord(db, { userId: USER, grantLevel: "editor" });
    const a = fakeArchive({ whoami: () => whoamiOf({ shared_schema: 2 }) });
    const r = await createSync(db, ENDPOINT, { fetchImpl: a.fetchImpl, warn: () => {} }).request({ accessToken: TOKEN });
    expect(r.ok).toBe(false);
    expect(() => applyShared(db, { tables: { videos: [sv(S1)] } })).toThrow(/Shared schema 2/);
    expect(db.query("SELECT COUNT(*) AS n FROM videos").get()).toEqual({ n: 0 });
    setMeta(db, "archive_shared_schema", "1");
    expect(() => applyShared(db, { tables: { videos: [sv(S1)] } })).not.toThrow();
  });
});

describe("SYNC-4 (cont.)", () => {
  const NEW = "aaaaaaaa-0000-4000-8000-0000000000a2";
  const b = batch([sv(NEW, { youtube_id: "YT", content_hash: null, title: "Shared again", updated_at: T(11) })]);
  test("an Unshared Video holding the key is still refused by the apply alone (reconcile handles it)", () => {
    const db = fresh();
    insertVideo(db, { title: "Mine", youtube_id: "YT" });
    expect(() => applyShared(db, b)).toThrow(/held by/);
  });
});
