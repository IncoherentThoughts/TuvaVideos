// Resume and Favorites follow you (docs/home-server-spec.md §6): the pure merge and outbox rules, the 0027 backfill,
// and two machines in one test (a laptop's HomeSync against a Home Server's /api/me/* routes, each its own library.db).
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/server/db";
import { recordResume, setFavorite } from "../src/server/catalog";
import { HomeSync } from "../src/server/homeSync";
import { createMeRoutes } from "../src/server/meRoutes";
import { favoritesFile, importFavorites, stateSince } from "../src/server/meState";
import { TailscaleCheck } from "../src/server/tailscale";
import { TvServer } from "../src/server/tv";
import { matchTvRoute } from "../src/server/tvRoutes";
import { backupName, chapterStartMs, newer, outboxKey, outboxPlan, parseFavoritesFile } from "../src/shared/meState";
import { insertChapter, insertVideo } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const FIX = join(import.meta.dir, "fixtures", "tailscale");
const tmp = mkdtempSync(join(tmpdir(), "tuva-follow-you-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const memDb = () => {
  const db = new Database(":memory:");
  migrate(db, MIGRATIONS);
  return db;
};

describe("newest wins and the outbox (pure)", () => {
  test("newer: incoming wins only when strictly newer; nothing stored loses to anything", () => {
    expect(newer("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(true);
    expect(newer("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")).toBe(false);
    expect(newer("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z")).toBe(false); // a tie keeps what is stored
    expect(newer("2026-01-01T00:00:00Z", null)).toBe(true);
    expect(newer(null, "2026-01-01T00:00:00Z")).toBe(false);
    expect(newer("garbage", "2026-01-01T00:00:00Z")).toBe(false);
  });
  test("outboxPlan: oldest first, the last write of a key supersedes the earlier ones", () => {
    const v = { id: "a", youtubeId: null, contentHash: null };
    const w = { id: "b", youtubeId: null, contentHash: null };
    const rows = [
      { id: 3, key: outboxKey("resume", v) },
      { id: 1, key: outboxKey("resume", v) },
      { id: 2, key: outboxKey("favorite", v) },
      { id: 4, key: outboxKey("favorite", v, 12500) },
      { id: 5, key: outboxKey("resume", w) },
    ];
    const p = outboxPlan(rows);
    expect(p.send.map((r) => r.id)).toEqual([2, 3, 4, 5]);
    expect(p.superseded).toEqual([1]);
  });
  test("chapter key and backup names", () => {
    expect(chapterStartMs(12.3456)).toBe(12346);
    const at = new Date(2026, 10, 26, 9, 0);
    expect(backupName(at, () => false)).toBe("favorites.before-home-sync-2026-11-26.json");
    expect(backupName(at, (n) => n === "favorites.before-home-sync-2026-11-26.json")).toBe("favorites.before-home-sync-2026-11-26-2.json");
    expect(parseFavoritesFile({ kind: "favorites", favorites: [{ id: "x", favoritedAt: "2026-01-01T00:00:00Z", startMs: null }] })).not.toBeNull();
    expect(parseFavoritesFile({ kind: "favorites", favorites: [{ id: 3 }] })).toBeNull();
  });
});

describe("migration 0027", () => {
  test("resume_at = last_played_at, favorite_at = favorited_at; Chapters likewise", () => {
    const dir = join(tmp, "mig");
    cpSync(MIGRATIONS, dir, { recursive: true });
    for (const f of readdirSync(dir)) if (f >= "0027") rmSync(join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    const v = insertVideo(db as never, { title: "A", youtube_id: "ya", favorited_at: "2026-02-01T00:00:00Z", resume_s: 30, last_played_at: "2026-03-01T00:00:00Z" });
    const c = insertChapter(db as never, { video_id: v, start_s: 5, favorited_at: "2026-04-01T00:00:00Z" });
    migrate(db, MIGRATIONS);
    expect(db.query("SELECT resume_at, favorite_at, me_changed_at FROM video_local WHERE video_id = ?").get(v)).toEqual({ resume_at: "2026-03-01T00:00:00Z", favorite_at: "2026-02-01T00:00:00Z", me_changed_at: "2026-03-01T00:00:00Z" });
    expect(db.query("SELECT favorite_at FROM chapter_local WHERE chapter_id = ?").get(c)).toEqual({ favorite_at: "2026-04-01T00:00:00Z" });
  });
});

/** Two machines: the laptop (a HomeSync) and the Home Server (its /api/me/* routes), with a switch for the network. */
function machines() {
  const laptop = memDb();
  const mini = memDb();
  const miniDir = mkdtempSync(join(tmp, "mini-"));
  const routes = createMeRoutes({ db: mini as never, dataDir: miniDir, machine: () => "Mac mini", sync: () => null });
  const net = { up: true, calls: [] as string[] };
  const f = (async (url: string, init?: RequestInit) => {
    if (!net.up) throw new Error("unreachable");
    const req = new Request(url, init);
    net.calls.push(`${req.method} ${new URL(url).pathname}`);
    return (await routes(req, new URL(url))) ?? new Response("{}", { status: 404 });
  }) as typeof fetch;
  const home = { base: () => "http://mac-mini:4401", status: () => ({ connected: net.up }) as never };
  const sync = new HomeSync({ db: laptop as never, home, machine: () => "MacBook", fetch: f });
  // a Shared Video (same id on both), an Unshared one known by youtube_id (different ids), one by content hash
  const shared = insertVideo(laptop as never, { title: "Shared", youtube_id: "ys" });
  insertVideo(mini as never, { id: shared, title: "Shared", youtube_id: "ys" });
  const lYt = insertVideo(laptop as never, { title: "Mine", youtube_id: "y2" });
  const mYt = insertVideo(mini as never, { title: "Mine", youtube_id: "y2" });
  const lH = insertVideo(laptop as never, { title: "File", content_hash: "h3" });
  const mH = insertVideo(mini as never, { title: "File", content_hash: "h3" });
  const lCh = insertChapter(laptop as never, { video_id: lYt, start_s: 12.5 });
  const mCh = insertChapter(mini as never, { video_id: mYt, start_s: 12.5 });
  return { laptop, mini, miniDir, sync, net, ids: { shared, lYt, mYt, lH, mH, lCh, mCh } };
}
const resumeOn = (db: Database, id: string) => (db.query("SELECT resume_s FROM video_local WHERE video_id = ?").get(id) as { resume_s: number | null } | null)?.resume_s ?? null;
const favOn = (db: Database, table: "video" | "chapter", id: string) =>
  (db.query(`SELECT favorited_at FROM ${table === "video" ? "video_full" : "chapter_full"} WHERE id = ?`).get(id) as { favorited_at: string | null }).favorited_at;
const outbox = (db: Database) => (db.query("SELECT COUNT(*) n FROM home_outbox").get() as { n: number }).n;
const tick = () => Bun.sleepSync(3);

describe("two machines: Resume and Favorites follow you", () => {
  test("a Resume on the laptop reaches the Home Server, matched by identity; a newer one there comes back", async () => {
    const m = machines();
    recordResume(m.laptop as never, m.ids.lYt, 100);
    m.sync.wroteResume(m.ids.lYt);
    await m.sync.flush();
    expect(resumeOn(m.mini, m.ids.mYt)).toBe(100);
    tick();
    recordResume(m.mini as never, m.ids.mH, 200); // the TV on the mini
    await m.sync.sync();
    expect(resumeOn(m.laptop, m.ids.lH)).toBe(200);
    // an older write does not win
    tick();
    recordResume(m.laptop as never, m.ids.lH, 50);
    const sent = JSON.parse((m.laptop.query("SELECT body FROM home_outbox").get() as { body: string } | null)?.body ?? "null");
    expect(sent).toBeNull(); // not enqueued yet: wroteResume was not called
    m.mini.query("UPDATE video_local SET resume_at = '2099-01-01T00:00:00.000Z' WHERE video_id = ?").run(m.ids.mH);
    m.sync.wroteResume(m.ids.lH);
    await m.sync.flush();
    expect(resumeOn(m.mini, m.ids.mH)).toBe(200);
    expect(outbox(m.laptop)).toBe(0);
  });

  test("written while the Home Server is unreachable: kept in home_outbox, sent in order on reconnect", async () => {
    const m = machines();
    m.net.up = false;
    recordResume(m.laptop as never, m.ids.shared, 10);
    m.sync.wroteResume(m.ids.shared);
    tick();
    recordResume(m.laptop as never, m.ids.shared, 20);
    m.sync.wroteResume(m.ids.shared);
    await m.sync.flush();
    expect(outbox(m.laptop)).toBe(2);
    expect(m.sync.status().error).toContain("could not be reached");
    m.net.up = true;
    m.net.calls.length = 0;
    await m.sync.sync();
    expect(outbox(m.laptop)).toBe(0);
    expect(m.net.calls.filter((c) => c.startsWith("PUT"))).toEqual(["PUT /api/me/resume"]); // the superseded one is not sent
    expect(resumeOn(m.mini, m.ids.shared)).toBe(20);
  });

  test("first connect: Favorites wait; Export Favorites… then the laptop's replace the mini's, which are backed up first", async () => {
    const m = machines();
    setFavorite(m.mini as never, "video", m.ids.shared, true); // the mini's own, about to be replaced
    tick();
    setFavorite(m.mini as never, "chapter", m.ids.mCh, true);
    tick();
    setFavorite(m.laptop as never, "video", m.ids.lH, true);
    m.sync.wroteFavorite("video", m.ids.lH);
    expect(outbox(m.laptop)).toBe(0); // before the first-connect replace, Favorites stay here
    await m.sync.sync();
    expect(favOn(m.laptop, "video", m.ids.shared)).toBeNull(); // nor do the mini's come
    const path = join(tmp, "laptop-favorites.json");
    const r = await m.sync.firstSync(path);
    expect(r.ok).toBe(true);
    const exported = parseFavoritesFile(JSON.parse(readFileSync(path, "utf8")))!;
    expect(exported.favorites.map((f) => f.title)).toEqual(["File"]);
    const backups = readdirSync(m.miniDir).filter((f) => f.startsWith("favorites.before-home-sync-"));
    expect(backups.length).toBe(1);
    const backup = parseFavoritesFile(JSON.parse(readFileSync(join(m.miniDir, backups[0]!), "utf8")))!;
    expect(backup.favorites.map((f) => [f.title, f.startMs])).toEqual([["Mine", 12500], ["Shared", null]]);
    expect(favOn(m.mini, "video", m.ids.mH)).not.toBeNull();
    expect(favOn(m.mini, "video", m.ids.shared)).toBeNull();
    expect(favOn(m.mini, "chapter", m.ids.mCh)).toBeNull();
    expect(m.sync.status().firstSyncDone).toBe(true);

    // from now on both ways: a Chapter star on the laptop, a Video star on the mini
    tick();
    setFavorite(m.laptop as never, "chapter", m.ids.lCh, true);
    m.sync.wroteFavorite("chapter", m.ids.lCh);
    await m.sync.flush();
    expect(favOn(m.mini, "chapter", m.ids.mCh)).not.toBeNull();
    tick();
    setFavorite(m.mini as never, "video", m.ids.mYt, true);
    setFavorite(m.mini as never, "video", m.ids.mH, false); // an unstar wins over the older star
    await m.sync.sync();
    expect(favOn(m.laptop, "video", m.ids.lYt)).not.toBeNull();
    expect(favOn(m.laptop, "video", m.ids.lH)).toBeNull();

    // Import Favorites… on the mini reads its backup back, newest wins against what is there
    const imp = importFavorites(m.mini as never, backup);
    expect(imp.applied.length).toBe(0); // everything in the backup is older than the replace
    expect(imp.older).toBe(2);
  });

  test("a Video only the Home Server has: its star is kept in home_me and sent by id", async () => {
    const m = machines();
    await m.sync.firstSync(join(tmp, "x.json"));
    const only = insertVideo(m.mini as never, { title: "Mini only", youtube_id: "ymini" });
    const row = { id: only, youtube_id: "ymini", content_hash: null };
    const at = m.sync.starHomeOnly(row, true);
    expect(at).not.toBeNull();
    await m.sync.flush();
    expect(favOn(m.mini, "video", only)).toBe(at);
    tick();
    recordResume(m.mini as never, only, 42);
    await m.sync.sync();
    expect(m.laptop.query("SELECT favorited_at, resume_s FROM home_me WHERE video_id = ?").get(only)).toEqual({ favorited_at: at, resume_s: 42 });
  });

  test("state since: only rows changed after it, by the Home Server's own clock", () => {
    const m = machines();
    recordResume(m.mini as never, m.ids.mYt, 5);
    const s1 = stateSince(m.mini as never, null);
    expect(s1.resume.map((r) => r.video.youtubeId)).toEqual(["y2"]);
    expect(stateSince(m.mini as never, s1.now).resume).toEqual([]);
    expect(favoritesFile(m.mini as never, "Mac mini").favorites).toEqual([]);
  });
});

describe("/api/me/* on the Library Server", () => {
  test("listed as kind mac: 403 to a TV and to anyone not approved, answered for an Approved Mac", async () => {
    expect(matchTvRoute("GET", "/api/me/state")?.kind).toBe("mac");
    for (const p of ["/api/me/resume", "/api/me/favorite", "/api/me/favorites"]) expect(matchTvRoute("PUT", p)?.kind).toBe("mac");
    expect(matchTvRoute("POST", "/api/me/resume")).toBeNull();
    const read = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
    const status = read("status.json");
    const same = read("whois-same.json");
    const db = memDb();
    const tv = new TvServer({ cfg: { tvPort: 0, passive: false, webDir: "", tvLoopback: false }, db: db as never, tailscale: new TailscaleCheck(async (a) => (a[0] === "status" ? status : a[2] === "100.101.1.2" ? same : null)) });
    const routes = createMeRoutes({ db: db as never, dataDir: tmp, machine: () => "mini", sync: () => null });
    tv.setHandler(async (r) => (await routes(r, new URL(r.url))) ?? new Response("{}", { status: 404 }));
    const req = () => new Request("http://100.101.1.1:4401/api/me/state");
    await tv.fetch(req(), "192.168.77.5");
    tv.approve("192.168.77.5"); // a TV
    expect((await tv.fetch(req(), "192.168.77.5")).status).toBe(403);
    expect((await tv.fetch(req(), "192.168.77.9")).status).toBe(403);
    const ok = await tv.fetch(req(), "100.101.1.2");
    expect(ok.status).toBe(200);
    expect(Object.keys(await ok.json())).toEqual(["now", "resume", "favorites"]);
    const bad = await tv.fetch(new Request("http://100.101.1.1:4401/api/me/resume", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }), "100.101.1.2");
    expect(bad.status).toBe(400);
    expect(existsSync(tmp)).toBe(true);
  });
});
