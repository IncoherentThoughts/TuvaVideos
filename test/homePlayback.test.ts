// Streaming from the Home Server (docs/home-server-spec.md §5.3, §5.4): the Preferred Copy order with remote Copies,
// the `/home/...` proxy, and the Library Server telling an Approved Mac from a TV. No real tailnet, no real files.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { migrate } from "../src/server/db";
import { preferredCopies } from "../src/server/ranking";
import { homeUpstream, proxyHome } from "../src/server/homeProxy";
import { homeCopyDto, homeOnlyDto, withHome } from "../src/server/homeVideos";
import type { HomeCopyRow, HomeView } from "../src/server/homeServer";
import { bestCopy, copyRoutes, homeDropAction, type PickableCopy } from "../src/shared/copies";
import { awaitCopy } from "../src/shared/prepare";
import { TailscaleCheck } from "../src/server/tailscale";
import { TvServer } from "../src/server/tv";
import { isMacRequest, isTvRequest } from "../src/server/tvRequest";
import type { VideoDto } from "../src/shared/types";

type C = { id: number; rootKind: "local" | "external"; playback: "native" | "remux" | "transcode"; width: number | null; height: number | null; size: number; available: boolean; missing: boolean };
const c = (id: number, o: Partial<C> = {}): C => ({ id, rootKind: "external", playback: "native", width: 1920, height: 1080, size: 100, available: true, missing: false, ...o });

describe("preferredCopies (pure, §5.3)", () => {
  test("a usable local Copy is always first, even a worse one", () => {
    const local = [c(1, { height: 480, width: 854, playback: "remux" })];
    const home = [c(-10, { height: 2160, width: 3840 })];
    expect(preferredCopies(local, home).map((x) => x.id)).toEqual([1, -10]);
    expect(bestCopy(preferredCopies(local, home))?.id).toBe(1);
  });
  test("no usable local Copy: the Home Server's by the existing rule (as-is, larger, smaller), then the unusable local ones", () => {
    const local = [c(1, { available: false, rootKind: "local" }), c(2, { missing: true })];
    const home = [c(-10, { playback: "remux", height: 2160, width: 3840 }), c(-11, { height: 720, width: 1280 }), c(-12, { height: 1080, size: 300 }), c(-13, { height: 1080, size: 200 })];
    expect(preferredCopies(local, home).map((x) => x.id)).toEqual([-13, -12, -11, -10, 1, 2]);
    expect(bestCopy(preferredCopies(local, home))?.id).toBe(-13);
  });
  test("nothing from the Home Server: this Mac's order unchanged", () => {
    const local = [c(1), c(2, { available: false }), c(3)];
    expect(preferredCopies(local).map((x) => x.id)).toEqual([1, 3, 2]);
  });
});

describe("Home Server Copies as the Player knows them", () => {
  const row = (id: number, o: Partial<HomeCopyRow> = {}): HomeCopyRow => ({ id, video_id: "v", youtube_id: null, content_hash: null, size: 100, container: "mp4", video_codec: "h264", audio_codec: "aac", width: 1920, height: 1080, duration_s: 60, available: 1, playback: "native", ...o });
  test("negated id, the id there, Available, streamed through /home", () => {
    expect(homeCopyDto(row(7))).toMatchObject({ id: -7, homeId: 7, available: true, missing: false, url: "/home/copy/7", path: "" });
    expect(copyRoutes({ id: -7, homeId: 7 })).toEqual({ file: "/home/copy/7", info: "/home/api/copies/7", keyframes: "/home/api/copies/7/keyframes" });
    expect(copyRoutes({ id: 3 })).toEqual({ file: "/copy/3", info: "/api/copies/3", keyframes: "/api/copies/3/keyframes" });
  });
  test("a matched Video keeps its own Copies and gains the Home Server's, ranked; a home_video row has only those", () => {
    const view: HomeView = { matched: new Map([["a", [row(5, { height: 720, width: 1280 }), row(6)]]]), homeOnly: [] };
    const local = { id: "a", available: false, copies: [{ id: 1, missing: false }] } as unknown as VideoDto;
    const v = withHome(local, view, "Mac mini");
    expect(v.copies.map((x) => x.id)).toEqual([1]);
    expect(v.homeCopies!.map((x) => x.id)).toEqual([-6, -5]);
    const only = homeOnlyDto({ row: { id: "b", youtube_id: null, content_hash: null, shared: 0, title: "t", title_latin: null, type: "song", created_at: "c", thumb: null, chapters: "[]" }, copies: [row(8)], chapters: [] }, "Mac mini");
    expect(only.copies).toEqual([]);
    expect(only.homeCopies!.map((x) => x.url)).toEqual(["/home/copy/8"]);
  });
  test("a Fallback being made on the Home Server is waited for through the proxy", async () => {
    const urls: string[] = [];
    let polls = 0;
    const res = await awaitCopy({ id: -4, homeId: 4 }, {
      fetch: async (url) => {
        urls.push(url);
        if (url.startsWith("/home/copy/")) return { ok: false, status: 503, json: async () => ({ state: "preparing", progress: 0.1 }) };
        return { ok: true, status: 200, json: async () => ({ fallback: { state: ++polls > 1 ? "ready" : "preparing" } }) };
      },
      sleep: async () => {},
      onProgress: () => {},
      cancelled: () => false,
    });
    expect(res).toBe("ready");
    expect(urls).toEqual(["/home/copy/4", "/home/api/copies/4", "/home/api/copies/4"]);
  });
});

describe("the /home proxy (§5.4)", () => {
  const V = "76696400-0000-8000-8000-000000000001";
  test("only the streaming routes pass", () => {
    expect(homeUpstream("/home/copy/12")).toBe("/copy/12");
    expect(homeUpstream("/home/live/12/index.m3u8", "?q=720")).toBe("/live/12/index.m3u8?q=720");
    expect(homeUpstream("/home/live/12/seg3.ts", "?q=orig")).toBe("/live/12/seg3.ts?q=orig");
    expect(homeUpstream("/home/live/12/seg3.ts", "?q=evil&x=1")).toBe("/live/12/seg3.ts");
    expect(homeUpstream("/home/api/copies/12")).toBe("/api/copies/12");
    expect(homeUpstream("/home/api/copies/12/keyframes")).toBe("/api/copies/12/keyframes");
    expect(homeUpstream(`/home/api/videos/${V}/audio`)).toBe(`/api/videos/${V}/audio`);
    for (const p of ["/home/api/videos", "/home/api/approvals", "/home/api/home/index", "/home/copy/1/pcm", "/home/copy/../api/roots", `/home/api/videos/${V}`, "/copy/1", "/home/api/me/state"]) expect(homeUpstream(p)).toBeNull();
  });

  test("Range goes through, the partial answer comes back; no base, a dead or refusing Home Server", async () => {
    let seen: { url: string; range: string | null; method?: string } | null = null;
    const up = (async (url: string, init?: RequestInit) => {
      seen = { url, range: (init?.headers as Record<string, string>)?.range ?? null, method: init?.method };
      return new Response("abcd", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 10-13/100", "accept-ranges": "bytes", "x-secret": "no" } });
    }) as typeof fetch;
    const req = new Request("http://127.0.0.1:4400/home/copy/9", { headers: { range: "bytes=10-13", cookie: "c=1" } });
    const r = await proxyHome(req, "http://mac-mini:4401", "/copy/9", up);
    expect(seen!).toEqual({ url: "http://mac-mini:4401/copy/9", range: "bytes=10-13", method: "GET" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 10-13/100");
    expect(r.headers.get("x-secret")).toBeNull();
    expect(await r.text()).toBe("abcd");
    expect((await proxyHome(req, null, "/copy/9", up)).status).toBe(404);
    expect((await proxyHome(req, "http://x", "/copy/9", (async () => { throw new Error("down"); }) as unknown as typeof fetch)).status).toBe(502);
    let marked = 0;
    await proxyHome(req, "http://x", "/copy/9", (async () => { throw new Error("down"); }) as unknown as typeof fetch, () => marked++);
    expect(marked).toBe(1); // §9: the connection state hears of it
    const gone = new AbortController();
    gone.abort();
    await proxyHome(new Request("http://127.0.0.1:4400/home/copy/9", { signal: gone.signal }), "http://x", "/copy/9", (async () => { throw new Error("aborted"); }) as unknown as typeof fetch, () => marked++);
    expect(marked).toBe(1); // the tab giving up is not the Home Server dropping
    expect((await proxyHome(req, "http://x", "/copy/9", (async () => Response.json({ error: "approve" }, { status: 403 })) as unknown as typeof fetch)).status).toBe(502);
  });

  test("a real Range read through a real listener", async () => {
    const body = new Uint8Array(1000).map((_, i) => i % 251);
    const srv = Bun.serve({ port: 0, fetch: (r) => {
      const m = r.headers.get("range")?.match(/bytes=(\d+)-(\d+)/);
      if (!m) return new Response(body, { headers: { "accept-ranges": "bytes" } });
      const [a, b] = [Number(m[1]), Number(m[2])];
      return new Response(body.slice(a, b + 1), { status: 206, headers: { "content-range": `bytes ${a}-${b}/${body.length}`, "accept-ranges": "bytes" } });
    } });
    try {
      const r = await proxyHome(new Request("http://127.0.0.1/home/copy/1", { headers: { range: "bytes=500-509" } }), `http://127.0.0.1:${srv.port}`, "/copy/1");
      expect(r.status).toBe(206);
      expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([...body.slice(500, 510)]);
    } finally {
      srv.stop(true);
    }
  });
});

describe("the Library Server marks an Approved Mac's requests (§5.4)", () => {
  const FIX = join(import.meta.dir, "fixtures", "tailscale");
  const read = (f: string) => JSON.parse(require("node:fs").readFileSync(join(FIX, f), "utf8"));
  test("a Mac gets the browser profile's branch, a TV the TV's", async () => {
    const db = new Database(":memory:");
    migrate(db as never, join(import.meta.dir, "..", "migrations"));
    const status = read("status.json");
    const same = read("whois-same.json");
    const tv = new TvServer({ cfg: { tvPort: 0, passive: false, webDir: "", tvLoopback: false }, db: db as never, tailscale: new TailscaleCheck(async (a) => (a[0] === "status" ? status : a[2] === "100.101.1.2" ? same : null)) });
    const marks: { tv: boolean; mac: boolean }[] = [];
    tv.setHandler(async (r) => (marks.push({ tv: isTvRequest(r), mac: isMacRequest(r) }), new Response("x")));
    const req = () => new Request("http://100.101.1.1:4401/copy/1");
    await tv.fetch(req(), "192.168.77.5");
    tv.approve("192.168.77.5"); // a TV
    await tv.fetch(req(), "192.168.77.5");
    await tv.fetch(req(), "100.101.1.2"); // a Mac of the same Tailscale user
    expect(marks).toEqual([{ tv: true, mac: false }, { tv: true, mac: true }]);
  });
});

describe("homeDropAction (pure, §9)", () => {
  const cp = (id: number, o: Partial<PickableCopy> = {}) => ({ id, available: true, ...o }) as PickableCopy;
  test("Home Server unreachable and no usable local Copy: pause", () => {
    expect(homeDropAction([cp(-1), cp(2, { available: false })], -1, new Set(), false)).toBe("pause");
    expect(homeDropAction([cp(-1)], -1, new Set(), false)).toBe("pause");
  });
  test("a usable local Copy takes over; a failed one does not count", () => {
    expect(homeDropAction([cp(-1), cp(2)], -1, new Set(), false)).toBe("failover");
    expect(homeDropAction([cp(-1), cp(2)], -1, new Set([2]), false)).toBe("pause");
  });
  test("the Home Server answering means the Copy is broken: the usual failover", () => {
    expect(homeDropAction([cp(-1)], -1, new Set(), true)).toBe("failover");
  });
});
