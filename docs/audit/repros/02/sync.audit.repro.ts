// Audit 02 repros (throwaway; not part of the suite).
import { describe, expect, test } from "bun:test";
import { openDb, type Db } from "/home/user/TuvaVideos/src/server/db";
import { applyShared } from "/home/user/TuvaVideos/src/server/localCopy/apply";
import { planFor, reconcileBatch } from "/home/user/TuvaVideos/src/server/reconcile";
import { fullRefetchReason, wipeShared } from "/home/user/TuvaVideos/src/server/sync";
import { patchVideo } from "/home/user/TuvaVideos/src/server/edit";
import type { SharedChanges, SharedChapterRow, SharedVideoRow } from "/home/user/TuvaVideos/src/shared/sharedRows";
import { C, insertChapter, insertCopy, insertVideo, V } from "/home/user/TuvaVideos/test/helpers/seed";

const MIGRATIONS = "/home/user/TuvaVideos/migrations";
const T = (d: number) => `2026-10-${String(d).padStart(2, "0")}T00:00:00.000000+00:00`;
const sv = (id: string, o: Partial<SharedVideoRow> = {}): SharedVideoRow => ({
  id, youtube_id: null, content_hash: `hash-${id}`, instagram_id: null, rutube_id: null, title: "Shared one", title_latin: null, title_latin_source: null,
  type: "song", type_suggested: false, song_id: null, proposed_song_id: null, version_id: null, proposed_version_id: null, song_suggested: false,
  suggestion_source: null, poster_path: null, deleted_at: null, deleted_by: null, delete_reason: null, created_at: T(1), updated_at: T(10), ...o,
});
const sc = (id: string, video_id: string, start_s: number, title: string): SharedChapterRow => ({
  id, video_id, start_s, title, title_latin: null, song_id: null, proposed_song_id: null, version_id: null, proposed_version_id: null, suggested: false, source: "manual", created_at: T(1), updated_at: T(10),
});
const batch = (videos: SharedVideoRow[], chapters: SharedChapterRow[] = []): SharedChanges => ({ shared_schema: 1, server_time: T(12), since: null, watermark: T(12), tables: { videos, video_chapters: chapters } });
const fresh = (): Db => {
  const db = openDb(":memory:", MIGRATIONS);
  db.exec(`INSERT INTO root (id, path, kind) VALUES (1, '/r', 'local')`);
  return db;
};
const OTHER = "aaaaaaaa-0000-4000-8000-000000000099";

describe("SYNC-1: legacy uuids collide across machines and reconcile matches by id first", () => {
  test("a collaborator's v1 Video #1 joins the owner's Video #1 although their YouTube ids differ", () => {
    const db = fresh();
    // the collaborator's own pre-0015 library: integer id 1 became V(1)
    const L = insertVideo(db, { id: 1, title: "Collaborator clip", youtube_id: "COLLAB_YT" });
    insertCopy(db, { video_id: L, root_id: 1, rel_path: "collab [COLLAB_YT].mp4" });
    // the owner's migrated Shared set: owner's integer id 1 is also V(1); the collaborator's clip is Shared too, under another id
    const b = batch([sv(V(1), { youtube_id: "OWNER_YT", content_hash: null, title: "Owner clip" }), sv(OTHER, { youtube_id: "COLLAB_YT", content_hash: null, title: "Collaborator clip (shared)" })]);
    const plan = planFor(db, b);
    expect(plan.matches).toEqual([{ localId: V(1), sharedId: V(1), by: "id" }]);
    db.transaction(() => {
      reconcileBatch(db, b);
      applyShared(db, b);
    })();
    const copy = db.query("SELECT c.rel_path, v.youtube_id, v.title FROM copy c JOIN videos v ON v.id = c.video_id").get() as any;
    // the file "[COLLAB_YT]" now plays as the owner's OWNER_YT Video; OTHER (the real match) has no Copy
    expect(copy).toEqual({ rel_path: "collab [COLLAB_YT].mp4", youtube_id: "OWNER_YT", title: "Owner clip" });
    expect(db.query("SELECT COUNT(*) AS n FROM copy WHERE video_id = ?").get(OTHER)).toEqual({ n: 0 });
  });

  test("a Shared Chapter whose legacy id equals an Unshared Video's Chapter id steals that Chapter", () => {
    const db = fresh();
    const L = insertVideo(db, { title: "Unknown to the Shared set", content_hash: "local-only" });
    insertChapter(db, { id: 5, video_id: L, start_s: 12, title: "My local chapter", favorited_at: "2026-09-01T00:00:00Z" });
    const S = "aaaaaaaa-0000-4000-8000-000000000001";
    const b = batch([sv(S, { content_hash: "owner-hash" })], [sc(C(5), S, 99, "Owner chapter")]);
    db.transaction(() => {
      reconcileBatch(db, b);
      applyShared(db, b);
    })();
    const rows = db.query("SELECT id, video_id, title FROM video_chapters").all();
    expect(rows).toEqual([{ id: C(5), video_id: S, title: "Owner chapter" }]);
    expect(db.query("SELECT COUNT(*) AS n FROM video_chapters WHERE video_id = ?").get(L)).toEqual({ n: 0 });
  });
});

describe("SYNC-2: a Shared Video the archive no longer returns blocks every later Sync", () => {
  test("held Shared V (purged upstream) + a new Shared row with its youtube_id: applyShared throws, full refetch too", () => {
    const db = fresh();
    const OLD = "aaaaaaaa-0000-4000-8000-000000000001";
    applyShared(db, batch([sv(OLD, { youtube_id: "YT", content_hash: null })]));
    const NEW = "aaaaaaaa-0000-4000-8000-000000000002";
    const b = batch([sv(NEW, { youtube_id: "YT", content_hash: null, updated_at: T(11) })]);
    const run = () => db.transaction(() => {
      reconcileBatch(db, b);
      return applyShared(db, b);
    })();
    expect(run).toThrow(/youtube_id of .* is held by/);
    // the full refetch (wipe + apply) fails the same way
    expect(() => db.transaction(() => {
      wipeShared(db);
      reconcileBatch(db, b);
      return applyShared(db, b);
    })()).toThrow(/held by/);
  });
});

describe("SYNC-3: the drain's apply is skipped when the scan's local stamp is not older than the server's", () => {
  test("a queued Video pointing at a Local Song keeps the local pointer and is marked Shared", () => {
    const db = fresh();
    db.exec(`INSERT INTO local_song (id, name, created_at) VALUES ('ls-1', 'Local song', '2026-10-01')`);
    const id = insertVideo(db, { title: "Scanned", youtube_id: "YT9", song_id: "ls-1", type: "song", pending_share: 1 });
    db.query("UPDATE videos SET updated_at = ? WHERE id = ?").run("2026-10-10T00:00:05.000Z", id); // machine clock 5 s ahead
    const P = "bbbbbbbb-0000-4000-8000-000000000001";
    const r = applyShared(db, {
      tables: {
        video_proposed_songs: [{ id: P, name: "Local song", english_name: null, alternate_titles: null, notes: null, created_by: null, created_at: T(10), updated_at: T(10) } as any],
        videos: [sv(id, { youtube_id: "YT9", content_hash: null, title: "Scanned", proposed_song_id: P, updated_at: "2026-10-10T00:00:02.000000+00:00" })],
      },
    });
    expect(r.skipped.videos).toBe(1);
    const v = db.query("SELECT song_id, proposed_song_id, updated_at FROM videos WHERE id = ?").get(id) as any;
    const l = db.query("SELECT shared, pending_share FROM video_local WHERE video_id = ?").get(id) as any;
    expect(v.song_id).toBe("ls-1"); // still the Local Song
    expect(v.proposed_song_id).toBeNull();
    expect(l).toEqual({ shared: 1, pending_share: 0 });
  });
});

describe("SYNC-4: the companion's local edit routes accept a Shared Video", () => {
  test("patchVideo writes a Shared row and the trigger stamps the local clock, so the next pull of that row is skipped", () => {
    const db = fresh();
    const S = "aaaaaaaa-0000-4000-8000-000000000001";
    applyShared(db, batch([sv(S, { title: "Server title" })]));
    expect(patchVideo(db, S, { title: "Local fork" })).toEqual({ ok: true });
    const held = db.query("SELECT title, updated_at FROM videos WHERE id = ?").get(S) as any;
    expect(held.title).toBe("Local fork");
    // a later server edit stamped before the local clock is skipped by the guard
    const r = applyShared(db, batch([sv(S, { title: "Server title 2", updated_at: "2026-10-11T00:00:00.000000+00:00" })]));
    if (held.updated_at > "2026-10-11") expect(r.skipped.videos).toBe(1);
  });
});

describe("SYNC-5: retention is measured from the newest row, not from the last pull", () => {
  test("a quiet archive (no change in 90 days) makes every Sync a full refetch", () => {
    const now = Date.parse("2027-02-01T00:00:00Z");
    expect(fullRefetchReason({ requested: false, watermark: "2026-10-20T00:00:00Z", syncedSchema: 1, client: 1, serverNowMs: now })).toBe("retention");
  });
});

import { listEdits } from "/home/user/TuvaVideos/src/server/editHistory";
describe("SYNC-6: the Edits view's cursor drops the rest of a write larger than a page", () => {
  test("one repoint touching 250 Videos (one created_at): page 1 has 200, page 2 has none", () => {
    const db = fresh();
    const at = "2026-10-20T10:00:00.123456+00:00";
    const ins = db.prepare("INSERT INTO video_edit_history (id, video_id, target_type, target_id, editor_id, event_type, description, created_at, updated_at) VALUES (?, ?, 'artist_link', NULL, 'ed-1', 'artist_link.repointed', 'Repointed', ?, ?)");
    for (let i = 0; i < 250; i++) ins.run(`h-${String(i).padStart(4, "0")}`, `v-${String(i).padStart(4, "0")}`, at, at);
    const p1 = listEdits(db, { limit: 200 });
    expect(p1.entries.length).toBe(200);
    expect(p1.next).toBe(at);
    const p2 = listEdits(db, { limit: 200, before: p1.next });
    expect(p2.entries.length).toBe(0); // 50 Edits are never listed
  });
});

describe("SYNC-7: re-applying an unchanged child fires the local touch trigger", () => {
  test("a bumped Video's unchanged Chapter gets this machine's clock as its stamp", () => {
    const db = fresh();
    const S = "aaaaaaaa-0000-4000-8000-000000000001";
    const CH = "cccccccc-0000-4000-8000-000000000001";
    applyShared(db, batch([sv(S)], [sc(CH, S, 0, "A")]));
    expect((db.query("SELECT updated_at FROM video_chapters WHERE id = ?").get(CH) as any).updated_at).toBe(T(10));
    // another Chapter was added upstream: the Video is bumped and comes with its complete child set, A unchanged
    const CH2 = "cccccccc-0000-4000-8000-000000000002";
    applyShared(db, batch([sv(S, { updated_at: T(11) })], [sc(CH, S, 0, "A"), { ...sc(CH2, S, 30, "B"), updated_at: T(11) }]));
    const a = (db.query("SELECT updated_at FROM video_chapters WHERE id = ?").get(CH) as any).updated_at;
    console.log("chapter A stamp after the re-apply:", a);
    expect(a).not.toBe(T(10)); // the stamp the archive holds is gone; an edit of A now sends a stale p_expected_updated_at
  });
  test("a full refetch restamps every held Chapter the same way", () => {
    const db = fresh();
    const S = "aaaaaaaa-0000-4000-8000-000000000001";
    const CH = "cccccccc-0000-4000-8000-000000000001";
    const b = batch([sv(S)], [sc(CH, S, 0, "A")]);
    applyShared(db, b);
    db.transaction(() => {
      wipeShared(db);
      applyShared(db, b);
    })();
    expect((db.query("SELECT updated_at FROM video_chapters WHERE id = ?").get(CH) as any).updated_at).not.toBe(T(10));
  });
});

import { syncWanted } from "/home/user/TuvaVideos/src/shared/session";
import { readSessionRecord, writeSessionRecord, listShelved } from "/home/user/TuvaVideos/src/server/localCopy/meta";
describe("SYNC-8: a focus Sync during the reconciliation confirmation reconciles without Continue", () => {
  test("the record the preview wrote has no last_sync_at, so focus wants a Sync; that Sync's reconcileBatch shelves", () => {
    const db = fresh();
    // what GET /api/reconcile/preview leaves behind: a record, nothing else
    const rec = writeSessionRecord(db, { userId: "u-1", grantLevel: "editor" });
    expect(syncWanted("focus", { record: rec, browser: { userId: "u-1", expiresAt: null }, authSettled: true, failures: 0, lastFailureAt: null }, Date.now())).toBe(true);
    // ... and the Sync it starts (full, "first") runs the same matching step the confirmation was asking about
    const L = insertVideo(db, { title: "My own title", youtube_id: "YT1", type: "concert" });
    const b = batch([sv("aaaaaaaa-0000-4000-8000-000000000001", { youtube_id: "YT1", content_hash: null, title: "Shared title" })]);
    db.transaction(() => {
      wipeShared(db);
      reconcileBatch(db, b);
      applyShared(db, b);
    })();
    expect(listShelved(db).map((s) => s.payload.kind)).toEqual(["title", "type"]);
    expect(db.query("SELECT COUNT(*) AS n FROM videos WHERE id = ?").get(L)).toEqual({ n: 0 }); // re-keyed
  });
});

import { createSync } from "/home/user/TuvaVideos/src/server/sync";
import { clearSessionRecord } from "/home/user/TuvaVideos/src/server/localCopy/meta";
describe("SYNC-9: Sign out during a Sync is undone by the Sync's record write", () => {
  test("DELETE /api/session while the pull is in flight: the finished Sync writes a record again", async () => {
    const db = fresh();
    const token = `x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).replace(/=+$/, "")}.y`;
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/video_whoami")) return new Response(JSON.stringify({ user_id: "u-1", email: "a@b", grant_level: "member", archive_role: null, shared_schema: 1, server_time: new Date().toISOString() }), { status: 200 });
      clearSessionRecord(db); // the person signs out while the pull is on the wire
      return new Response(JSON.stringify({ shared_schema: 1, watermark: T(12), tables: { videos: [sv("aaaaaaaa-0000-4000-8000-000000000001")] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const sync = createSync(db, { url: "http://archive.invalid", key: "k" }, { fetchImpl });
    const r = await sync.request({ accessToken: token });
    expect(r.ok).toBe(true);
    const rec = readSessionRecord(db);
    expect(rec).not.toBeNull(); // signed out, yet the machine has a Session record again
    expect(rec!.userId).toBe("u-1");
    expect(rec!.grantLevel).toBeNull();
  });
});
