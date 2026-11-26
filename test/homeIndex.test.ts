// The Home Server setting and the home index (docs/home-server-spec.md §4.1, §5.1, §5.2). The Tailscale CLI is
// stubbed and the "Home Server" is a fake fetch or an in-process TvServer: nothing here reaches a real tailnet.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { migrate } from "../src/server/db";
import { homeBase, homeLabel, matchHome, type HomeIndexDto, type HomeIndexVideo } from "../src/shared/homeIndex";
import { HomeServer, homeView, storeHomeIndex, type HomeCopyRow, type HomeVideoRow } from "../src/server/homeServer";
import { homeIndexBody, homeIndexEtag, homeOnlyDto, homeOnlySearch, withHome } from "../src/server/homeVideos";
import { TailscaleCheck } from "../src/server/tailscale";
import { TvServer } from "../src/server/tv";
import { matchTvRoute } from "../src/server/tvRoutes";
import { isOnHome, videoPresence } from "../src/shared/presence";
import type { VideoDto } from "../src/shared/types";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const FIX = join(import.meta.dir, "fixtures", "tailscale");
const read = (f: string) => JSON.parse(require("node:fs").readFileSync(join(FIX, f), "utf8"));

const id = (n: number) => `76696400-0000-8000-8000-${String(n).padStart(12, "0")}`;
const I = (n: number, youtubeId: string | null = null, contentHash: string | null = null) => ({ id: id(n), youtubeId, contentHash });

describe("matchHome (pure)", () => {
  test("id, else youtube_id, else content_hash; the rest are unmatched", () => {
    const local = [I(1, "yt1"), I(2, "yt2"), I(3, null, "h3")];
    const remote = [I(1, "yt1"), I(12, "yt2"), I(13, null, "h3"), I(14, "yt4"), I(15, null, "h5")];
    expect([...matchHome(local, remote)]).toEqual([
      [id(1), id(1)],
      [id(12), id(2)],
      [id(13), id(3)],
    ]);
  });
  test("an id match wins over another Video's youtube_id match; a local Video is taken once", () => {
    const local = [I(1, "ytA")];
    // the Home Server holds a youtube_id twin listed before the Shared twin
    expect([...matchHome(local, [I(9, "ytA"), I(1, "ytA")])]).toEqual([[id(1), id(1)]]);
    expect([...matchHome(local, [I(8, "ytA"), I(9, "ytA")])]).toEqual([[id(8), id(1)]]);
  });
  test("youtube_id is tried before content_hash", () => {
    expect([...matchHome([I(1, "ytA", null), I(2, null, "h")], [I(9, "ytA", "h")])]).toEqual([[id(9), id(1)]]);
  });
});

describe("homeBase and homeLabel (pure)", () => {
  test("a Tailscale name or address, the Library Server port when none is given", () => {
    expect(homeBase("mac-mini", 4401)).toBe("http://mac-mini:4401");
    expect(homeBase(" Mac-Mini.tailnet.ts.net:5000/ ", 4401)).toBe("http://mac-mini.tailnet.ts.net:5000");
    expect(homeBase("100.101.1.2", 4401)).toBe("http://100.101.1.2:4401");
    expect(homeBase("http://127.0.0.1:4555", 4401)).toBe("http://127.0.0.1:4555");
    expect(homeBase("fd7a:115c:a1e0::1", 4401)).toBe("http://[fd7a:115c:a1e0::1]:4401");
    expect(homeBase("[fd7a::1]:4402", 4401)).toBe("http://[fd7a::1]:4402");
    for (const bad of ["", "  ", "mac mini", "mini/api", "user@mini", ".mini"]) expect(homeBase(bad, 4401)).toBeNull();
  });
  test("the top bar's words", () => {
    const base = { configured: true, self: false, connected: true, server: "Mac mini", address: "mac-mini" };
    expect(homeLabel(base)).toBe("Home · Mac mini");
    expect(homeLabel({ ...base, connected: false })).toBe("Home · unreachable");
    expect(homeLabel({ ...base, configured: false })).toBeNull();
    expect(homeLabel({ ...base, configured: false, self: true })).toBe("Home Server · this Mac");
  });
});

// ---- the laptop's tables ----

const copy = (cid: number, extra: Partial<HomeIndexVideo["copies"][number]> = {}) => ({ id: cid, size: 1000 + cid, container: "mp4", videoCodec: "h264", audioCodec: "aac", width: 1920, height: 1080, durationS: 60, available: true, playback: "native" as const, ...extra });
const hv = (n: number, extra: Partial<HomeIndexVideo> = {}): HomeIndexVideo => ({
  id: id(n), youtubeId: null, contentHash: null, shared: false, title: `Video ${n}`, titleLatin: null, type: "song", createdAt: "2026-01-01T00:00:00.000Z", thumb: `k${n}`, chapters: [], copies: [copy(n * 10)], ...extra,
});
const INDEX: HomeIndexDto = {
  server: "Mac mini",
  videos: [
    hv(1, { shared: true }), // the laptop has it by id (Shared)
    hv(2, { youtubeId: "yt2" }), // the laptop has it by youtube_id
    hv(3, { title: "Хоомей мини", titleLatin: "Khoomei mini", chapters: [{ startS: 5, title: "Intro", titleLatin: null }] }), // mini-only
    hv(4, { copies: [copy(40, { available: false })] }), // mini-only, its drive unplugged there
  ],
};
const memDb = () => {
  const db = new Database(":memory:");
  migrate(db, MIGRATIONS);
  return db;
};
const LOCAL = [I(1), I(22, "yt2"), I(30, null, "local-only")];
const rows = (db: Database) => ({ copies: db.query("SELECT * FROM home_copy").all() as HomeCopyRow[], videos: db.query("SELECT * FROM home_video").all() as HomeVideoRow[] });

describe("home_copy / home_video", () => {
  test("replaced wholesale; unmatched Videos go to home_video", () => {
    const db = memDb();
    expect(storeHomeIndex(db as never, INDEX, LOCAL)).toEqual({ videos: 4, copies: 4, homeOnly: 2 });
    expect(rows(db).videos.map((v) => v.id)).toEqual([id(3), id(4)]);
    expect(storeHomeIndex(db as never, { server: "Mac mini", videos: [hv(5)] }, LOCAL)).toEqual({ videos: 1, copies: 1, homeOnly: 1 });
    expect(rows(db).copies.map((c) => c.id)).toEqual([50]);
    expect(rows(db).videos.map((v) => v.id)).toEqual([id(5)]);
  });

  test("the view: a matched Video, a mini-only Video, an unmatched local Video; unmounted Copies do not count", () => {
    const db = memDb();
    storeHomeIndex(db as never, INDEX, LOCAL);
    const { copies, videos } = rows(db);
    const v = homeView(LOCAL, copies, videos);
    expect([...v.matched.keys()].sort()).toEqual([id(1), id(22)]);
    expect(v.homeOnly.map((e) => e.row.id)).toEqual([id(3)]); // id(4) has no mounted Copy there
    expect(v.matched.has(id(30))).toBe(false);
    // a Video that arrived here since the fetch takes its Home Server twin's place
    expect(homeView([...LOCAL, I(3)], copies, videos).homeOnly).toEqual([]);
  });

  test("the DTOs: matched is marked, mini-only is read-only On the Home Server with a proxied poster, search by title", () => {
    const db = memDb();
    storeHomeIndex(db as never, INDEX, LOCAL);
    const { copies, videos } = rows(db);
    const view = homeView(LOCAL, copies, videos);
    const only = homeOnlyDto(view.homeOnly[0]!, "Mac mini");
    expect(only).toMatchObject({ id: id(3), title: "Хоомей мини", titleLatin: "Khoomei mini", type: "song", homeOnly: true, available: false, chapterCount: 1, home: { copies: 1, server: "Mac mini" } });
    expect(only.thumbnail?.poster).toBe(`/home/thumbs/${id(3)}/poster.webp?v=k3`);
    expect(videoPresence(only)).toBe("home");

    const local = (n: number, available: boolean) => ({ id: id(n), available, copies: available ? [{ missing: false }] : [] }) as unknown as VideoDto;
    expect(isOnHome(withHome(local(22, false), view, "Mac mini"))).toBe(true); // matched, no Copy here: On the Home Server
    expect(videoPresence(withHome(local(22, true), view, "Mac mini"))).toBe("available"); // a usable local Copy is first
    expect(videoPresence(withHome(local(30, false), view, "Mac mini"))).toBe("notHere"); // unmatched: Not on this machine

    expect(homeOnlySearch(view, "khoomei").map((e) => e.row.id)).toEqual([id(3)]);
    expect(homeOnlySearch(view, "nothing")).toEqual([]);
  });
});

describe("the index body (on the Home Server)", () => {
  test("Videos with a Copy that is not Missing; identity, facts, the browser decision; a stable ETag", () => {
    const v = (n: number, copies: Partial<VideoDto["copies"][number]>[]) =>
      ({ id: id(n), youtubeId: `yt${n}`, shared: true, title: `T${n}`, titleLatin: null, type: "concert", createdAt: "c", thumbnail: { generatedAt: "g" }, copies: copies.map((c, i) => ({ id: n * 10 + i, size: 5, container: "mkv", videoCodec: "hevc", audioCodec: "opus", width: 1, height: 2, durationS: 3, available: true, missing: false, playback: "remux", ...c })) }) as unknown as VideoDto;
    const body = homeIndexBody("Mac mini", [v(1, [{}]), v(2, [{ missing: true }]), v(3, [{ available: false }])], new Map([[id(1), null]]), new Map([[id(1), [{ startS: 0, title: "a", titleLatin: null }]]]));
    expect(body.videos.map((x) => x.id)).toEqual([id(1), id(3)]);
    expect(body.videos[0]).toEqual({ id: id(1), youtubeId: "yt1", contentHash: null, shared: true, title: "T1", titleLatin: null, type: "concert", createdAt: "c", thumb: "g", chapters: [{ startS: 0, title: "a", titleLatin: null }], copies: [{ id: 10, size: 5, container: "mkv", videoCodec: "hevc", audioCodec: "opus", width: 1, height: 2, durationS: 3, available: true, playback: "remux" }] });
    expect(body.videos[1]!.copies[0]!.available).toBe(false);
    const s = JSON.stringify(body);
    expect(homeIndexEtag(s)).toBe(homeIndexEtag(s));
    expect(homeIndexEtag(s)).not.toBe(homeIndexEtag(s + " "));
  });
});

// ---- the Library Server's route, and the laptop's HomeServer against a fake Home Server ----

describe("GET /api/home/index on the Library Server", () => {
  const status = read("status.json");
  const same = read("whois-same.json");
  const server = (home?: () => boolean) => {
    const db = memDb();
    const tv = new TvServer({ cfg: { tvPort: 0, passive: false, webDir: "", tvLoopback: false }, db: db as never, home, tailscale: new TailscaleCheck(async (a) => (a[0] === "status" ? status : a[2] === "100.101.1.2" ? same : null)) });
    tv.setHandler(async (r) => (r.headers.get("if-none-match") === '"e1"' ? new Response(null, { status: 304, headers: { etag: '"e1"' } }) : new Response(JSON.stringify({ server: "Mac mini", videos: [] }), { headers: { "content-type": "application/json", etag: '"e1"' } })));
    return tv;
  };
  const req = (init: RequestInit = {}) => new Request("http://100.101.1.1:4401/api/home/index", init);

  test("listed, for Approved Macs only; an ETag that is unchanged answers 304", async () => {
    expect(matchTvRoute("GET", "/api/home/index")?.kind).toBe("mac");
    expect(matchTvRoute("POST", "/api/home/index")).toBeNull();
    const tv = server();
    await tv.fetch(req(), "192.168.77.5");
    tv.approve("192.168.77.5"); // a TV
    expect((await tv.fetch(req(), "192.168.77.5")).status).toBe(403);
    expect((await tv.fetch(req(), "192.168.77.9")).status).toBe(403);
    const ok = await tv.fetch(req(), "100.101.1.2"); // a Mac of the same Tailscale user
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).toBe('"e1"');
    expect((await tv.fetch(req({ headers: { "if-none-match": '"e1"' } }), "100.101.1.2")).status).toBe(304);
  });

  test("health's home follows the toggle", async () => {
    let on = false;
    const tv = server(() => on);
    const h = async () => (await (await tv.fetch(new Request("http://100.101.1.1:4401/api/health"), "100.101.1.2")).json()).home;
    expect(await h()).toBe(false);
    on = true;
    expect(await h()).toBe(true);
  });
});

describe("HomeServer (this Mac's setting and connection)", () => {
  const health = { app: "TuvaVideos TV Server", name: "Mac mini", home: true, drive: "mounted", version: "abc1234" };
  const fake = (o: { index?: HomeIndexDto; indexStatus?: number; down?: boolean } = {}) => {
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push(`${url}${(init?.headers as Record<string, string> | undefined)?.["if-none-match"] ? " (if-none-match)" : ""}`);
      if (o.down) throw new Error("down");
      if (url.endsWith("/api/health")) return Response.json(health);
      if (url.endsWith("/api/home/index")) {
        if ((init?.headers as Record<string, string> | undefined)?.["if-none-match"] === '"e1"') return new Response(null, { status: 304 });
        return o.indexStatus ? Response.json({ error: "approve" }, { status: o.indexStatus }) : new Response(JSON.stringify(o.index ?? INDEX), { headers: { etag: '"e1"' } });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    return { f, calls };
  };
  const make = (o: Parameters<typeof fake>[0] = {}, env: Record<string, string | undefined> = {}) => {
    const db = memDb();
    let now = Date.parse("2026-11-26T10:00:00Z");
    const { f, calls } = fake(o);
    const home = new HomeServer({ db: db as never, defaultPort: 4401, localIdentities: () => LOCAL, env, fetch: f, now: () => now });
    return { db, home, calls, tick: (ms: number) => (now += ms) };
  };

  test("the field, the toggle and the env override", () => {
    const { home } = make();
    expect(home.status()).toMatchObject({ configured: false, self: false, address: null });
    expect(home.set({ address: "mac mini" })).toEqual({ ok: false, error: "Not a Tailscale name or address" });
    expect(home.set({ address: "mac-mini" }).ok).toBe(true);
    expect(home.base()).toBe("http://mac-mini:4401");
    expect(home.target()).toBe("http://mac-mini:4401");
    home.set({ self: true });
    expect(home.self).toBe(true);
    expect(home.base()).toBeNull(); // a Mac that is its own Home Server never connects to itself
    expect(home.status()).toMatchObject({ configured: false, self: true, address: "mac-mini" });
    home.set({ self: false, address: null });
    expect(home.status().configured).toBe(false);
    const { home: o } = make({}, { TUVA_HOME_SERVER: "http://127.0.0.1:4555" });
    expect(o.status()).toMatchObject({ configured: true, override: true, base: "http://127.0.0.1:4555" });
  });

  test("connect fetches health and the index; focus refetches only when stale (60 s health, 10 min index); 304 keeps the tables", async () => {
    const { home, calls, tick, db } = make();
    home.set({ address: "mac-mini" });
    const s = await home.refresh({ force: true });
    expect(s).toMatchObject({ connected: true, server: "Mac mini", version: "abc1234", drive: "mounted", index: { videos: 4, copies: 4, homeOnly: 2 } });
    expect(calls).toEqual(["http://mac-mini:4401/api/health", "http://mac-mini:4401/api/home/index"]);
    calls.length = 0;
    tick(30_000);
    await home.refresh();
    expect(calls).toEqual([]); // fresh
    tick(31_000);
    await home.refresh();
    expect(calls).toEqual(["http://mac-mini:4401/api/health"]); // health only
    calls.length = 0;
    tick(10 * 60_000);
    await home.refresh();
    expect(calls).toEqual(["http://mac-mini:4401/api/health", "http://mac-mini:4401/api/home/index (if-none-match)"]);
    expect((db.query("SELECT COUNT(*) n FROM home_copy").get() as { n: number }).n).toBe(4);
    expect(home.view(LOCAL).homeOnly.map((e) => e.row.id)).toEqual([id(3)]);
  });

  test("unreachable or refused: not connected, and the grid gets nothing from it (§9)", async () => {
    const down = make({ down: true });
    down.home.set({ address: "mac-mini" });
    expect(await down.home.refresh({ force: true })).toMatchObject({ configured: true, connected: false });
    expect(down.home.view(LOCAL).matched.size).toBe(0);

    const refused = make({ indexStatus: 403 });
    refused.home.set({ address: "mac-mini" });
    const s = await refused.home.refresh({ force: true });
    expect(s.connected).toBe(false);
    expect(s.error).toContain("does not know this Mac");
  });

  test("another Home Server drops the old index", async () => {
    const { home, db } = make();
    home.set({ address: "mac-mini" });
    await home.refresh({ force: true });
    home.set({ address: "other-mini" });
    expect((db.query("SELECT COUNT(*) n FROM home_copy").get() as { n: number }).n).toBe(0);
    expect(home.status()).toMatchObject({ connected: false, index: null });
  });
});
