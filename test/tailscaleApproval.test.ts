// Tailscale devices on sight and Allow from any approved Mac (docs/home-server-spec.md §3.1, §3.2). The tailscale CLI
// is always stubbed (fixtures in test/fixtures/tailscale): nothing here reaches a real tailnet.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/server/db";
import { answerHomeApproval, homeApprovals, homeServerFromEnv } from "../src/server/homeApprovals";
import { cliRunner, isTailscaleAddress, TAILSCALE_CACHE_MS, TAILSCALE_FAIL_CACHE_MS, TailscaleCheck, tailscaleDecision, type TailscaleRun } from "../src/server/tailscale";
import { TvServer } from "../src/server/tv";
import { matchTvRoute } from "../src/server/tvRoutes";
import { homePromptText } from "../src/web/HomeApprovals";

const FIX = join(import.meta.dir, "fixtures", "tailscale");
const read = (f: string) => JSON.parse(require("node:fs").readFileSync(join(FIX, f), "utf8"));
const status = read("status.json");
const same = read("whois-same.json");
const other = read("whois-other.json");
const tagged = read("whois-tagged.json");
const MIGRATIONS = join(import.meta.dir, "..", "migrations");

describe("tailscaleDecision (pure)", () => {
  test("a device of this Mac's own Tailscale user is approved, as a Mac, with its name and login", () => {
    expect(tailscaleDecision(same, status)).toEqual({ approve: true, kind: "mac", name: "MacBook Pro", login: "owner@example.com" });
  });
  test("another user's device, or a tagged node, falls through", () => {
    expect(tailscaleDecision(other, status)).toEqual({ approve: false, reason: "other user" });
    expect(tailscaleDecision(tagged, status)).toEqual({ approve: false, reason: "other user" });
  });
  test("a failed lookup of either answer falls through", () => {
    expect(tailscaleDecision(null, status)).toEqual({ approve: false, reason: "lookup failed" });
    expect(tailscaleDecision(same, null)).toEqual({ approve: false, reason: "lookup failed" });
    expect(tailscaleDecision({ Node: {} }, status)).toEqual({ approve: false, reason: "lookup failed" });
    expect(tailscaleDecision("nonsense", { Self: {} })).toEqual({ approve: false, reason: "lookup failed" });
  });
  test("whois saying a TV OS makes it a TV; the name falls back to the MagicDNS name", () => {
    const tv = { ...same, Node: { ...same.Node, Hostinfo: { OS: "tvOS" }, ComputedName: "" } };
    expect(tailscaleDecision(tv, status)).toMatchObject({ approve: true, kind: "tv", name: "macbook-pro" });
  });
  test("UserProfile.ID stands in when Node.User is missing; ids compare as numbers or strings", () => {
    const noUser = { ...same, Node: { ...same.Node, User: undefined } };
    expect(tailscaleDecision(noUser, { Self: { UserID: "4001" } })).toMatchObject({ approve: true });
  });
});

describe("isTailscaleAddress", () => {
  test("100.64.0.0/10 and fd7a:115c:a1e0::/48 only", () => {
    for (const a of ["100.64.0.1", "100.101.1.2", "100.127.255.255", "::ffff:100.100.1.1", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:ab12::2"]) expect(isTailscaleAddress(a)).toBe(true);
    for (const a of ["100.63.255.255", "100.128.0.1", "192.168.4.56", "127.0.0.1", "10.0.0.1", "fd7a:115c:a1e1::1", ""]) expect(isTailscaleAddress(a)).toBe(false);
  });
});

describe("TailscaleCheck cache", () => {
  const counting = (answers: Record<string, unknown>) => {
    const calls: string[] = [];
    const run: TailscaleRun = async (args) => {
      calls.push(args.join(" "));
      return args[0] === "status" ? status : (answers[args[2]!] ?? null);
    };
    return { calls, run };
  };

  test("one lookup per IP for 10 minutes; concurrent requests share it", async () => {
    let now = 0;
    const { calls, run } = counting({ "100.101.1.2": same });
    const c = new TailscaleCheck(run, () => now);
    await Promise.all([c.check("100.101.1.2"), c.check("100.101.1.2")]);
    expect(calls.filter((x) => x.startsWith("whois"))).toHaveLength(1);
    now = TAILSCALE_CACHE_MS - 1;
    expect((await c.check("100.101.1.2")).approve).toBe(true);
    expect(calls.filter((x) => x.startsWith("whois"))).toHaveLength(1);
    now = TAILSCALE_CACHE_MS;
    await c.check("100.101.1.2");
    expect(calls.filter((x) => x.startsWith("whois"))).toHaveLength(2);
  });

  test("a failed lookup is retried sooner (30 s), another user's answer stands 10 min", async () => {
    let now = 0;
    const { calls, run } = counting({ "100.101.1.3": other });
    const c = new TailscaleCheck(run, () => now);
    await c.check("100.101.1.9");
    await c.check("100.101.1.3");
    now = TAILSCALE_FAIL_CACHE_MS;
    await c.check("100.101.1.9");
    await c.check("100.101.1.3");
    expect(calls.filter((x) => x.startsWith("whois"))).toEqual(["whois --json 100.101.1.9", "whois --json 100.101.1.3", "whois --json 100.101.1.9"]);
  });

  test("the CLI runner reads a stub's JSON, and a failing command is null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tuva-ts-"));
    copyFileSync(join(FIX, "status.json"), join(dir, "status.json"));
    copyFileSync(join(FIX, "whois-same.json"), join(dir, "whois-100.101.1.2.json"));
    process.env.TUVA_TS_FIXTURES = dir;
    try {
      const run = cliRunner(join(FIX, "stub.sh"));
      expect(await run(["status", "--json"])).toMatchObject({ Self: { UserID: 4001 } });
      expect(await run(["whois", "--json", "100.101.1.2"])).toMatchObject({ Node: { User: 4001 } });
      expect(await run(["whois", "--json", "100.101.1.9"])).toBeNull();
      expect(await cliRunner(null)(["status", "--json"])).toBeNull();
    } finally {
      delete process.env.TUVA_TS_FIXTURES;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- the Library Server: on sight, and the approvals routes ----

const stubCheck = (answers: Record<string, unknown>) => new TailscaleCheck(async (args) => (args[0] === "status" ? status : (answers[args[2]!] ?? null)));

function server(answers: Record<string, unknown>, extra: { tvLoopback?: boolean; tailscaleOwn?: boolean } = {}) {
  const db = new Database(":memory:");
  migrate(db, MIGRATIONS);
  const tv = new TvServer({ cfg: { tvPort: 0, passive: false, webDir: "", tvLoopback: extra.tvLoopback }, db: db as never, tailscale: stubCheck(answers), tailscaleOwn: extra.tailscaleOwn });
  tv.setHandler(async () => new Response("[]", { headers: { "content-type": "application/json" } }));
  return { db, tv };
}
const req = (path: string, init: RequestInit = {}) => new Request(`http://100.101.1.1:4401${path}`, init);

describe("Library Server, Tailscale on sight", () => {
  test("same user: served at once and stored via 'tailscale', kind 'mac', with name and login", async () => {
    const { db, tv } = server({ "100.101.1.2": same });
    expect((await tv.fetch(req("/api/videos"), "100.101.1.2")).status).toBe(200);
    expect(db.query("SELECT ip, kind, name, via, tailscale_login FROM approved_device").all()).toEqual([
      { ip: "100.101.1.2", kind: "mac", name: "MacBook Pro", via: "tailscale", tailscale_login: "owner@example.com" },
    ]);
    expect(tv.state().pending).toEqual([]);
  });

  test("another user's device and a failed lookup fall through to the Allow prompt", async () => {
    const { db, tv } = server({ "100.101.1.3": other });
    expect((await tv.fetch(req("/api/videos"), "100.101.1.3")).status).toBe(403);
    expect((await tv.fetch(req("/api/videos"), "100.101.1.9")).status).toBe(403);
    expect(tv.state().pending.map((p) => p.ip)).toEqual(["100.101.1.3", "100.101.1.9"]);
    expect(db.query("SELECT COUNT(*) AS n FROM approved_device").get()).toEqual({ n: 0 });
  });

  test("a LAN address is never looked up", async () => {
    const calls: string[] = [];
    const db = new Database(":memory:");
    migrate(db, MIGRATIONS);
    const tv = new TvServer({ cfg: { tvPort: 0, passive: false, webDir: "" }, db: db as never, tailscale: { check: async (ip) => (calls.push(ip), { approve: true, kind: "mac", name: null, login: null }) } });
    expect((await tv.fetch(req("/api/videos"), "192.168.77.5")).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("Remove clears the row for both kinds; a Tailscale device is approved again on its next request", async () => {
    const { tv } = server({ "100.101.1.2": same });
    await tv.fetch(req("/api/videos"), "100.101.1.2");
    await tv.fetch(req("/api/videos"), "192.168.77.5");
    expect(tv.approve("192.168.77.5")).toBe(true);
    expect(tv.approved().map((d) => [d.ip, d.kind, d.via])).toEqual([
      ["100.101.1.2", "mac", "tailscale"],
      ["192.168.77.5", "tv", "click"],
    ]);
    expect(tv.remove("100.101.1.2")).toBe(true);
    expect(tv.remove("192.168.77.5")).toBe(true);
    expect(tv.approved()).toEqual([]);
    expect((await tv.fetch(req("/api/videos"), "100.101.1.2")).status).toBe(200);
    expect((await tv.fetch(req("/api/videos"), "192.168.77.5")).status).toBe(403);
    expect(tv.approved().map((d) => d.ip)).toEqual(["100.101.1.2"]);
  });

  test("a MagicDNS Host is accepted; another name is still refused", async () => {
    const { tv } = server({ "100.101.1.2": same });
    const h = (host: string) => tv.fetch(new Request(`http://${host}/api/videos`, { headers: { host } }), "100.101.1.2");
    expect((await h("mac-mini.example-tailnet.ts.net:4401")).status).toBe(200);
    expect((await h("evil.example.com:4401")).status).toBe(403);
  });
});

describe("Library Server, /api/approvals", () => {
  test("listed routes; the only Mac-side write is POST /api/approvals/:ip", () => {
    expect(matchTvRoute("GET", "/api/approvals")?.kind).toBe("approvals");
    expect(matchTvRoute("POST", "/api/approvals/192.168.4.56")?.kind).toBe("approvals");
    expect(matchTvRoute("POST", "/api/approvals/fd7a%3A115c%3Aa1e0%3A%3A1")?.kind).toBe("approvals");
    expect(matchTvRoute("POST", "/api/approvals/../tv")).toBeNull();
    expect(matchTvRoute("GET", "/api/approvals/1.2.3.4")).toBeNull();
  });

  test("Approved Macs only: a TV, another user's device and an unknown device are refused", async () => {
    const { tv } = server({ "100.101.1.2": same, "100.101.1.3": other });
    await tv.fetch(req("/api/videos"), "192.168.77.5");
    tv.approve("192.168.77.5");
    expect((await tv.fetch(req("/api/approvals"), "192.168.77.5")).status).toBe(403);
    expect((await tv.fetch(req("/api/approvals"), "100.101.1.3")).status).toBe(403);
    expect((await tv.fetch(req("/api/approvals"), "192.168.77.6")).status).toBe(403);
    expect((await tv.fetch(req("/api/approvals"), "100.101.1.2")).status).toBe(200);
  });

  test("an Approved Mac lists pending TVs and answers Allow / Deny", async () => {
    const { tv } = server({ "100.101.1.2": same });
    await tv.fetch(req("/api/videos", { headers: { "x-tuva-tv": "Samsung 85R85H" } }), "192.168.77.5");
    await tv.fetch(req("/api/videos"), "192.168.77.6");
    const list = await (await tv.fetch(req("/api/approvals"), "100.101.1.2")).json();
    expect(list.pending).toEqual([
      { ip: "192.168.77.5", model: "Samsung 85R85H" },
      { ip: "192.168.77.6", model: null },
    ]);
    expect(typeof list.server).toBe("string");
    const post = (ip: string, body: unknown) => tv.fetch(req(`/api/approvals/${ip}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), "100.101.1.2");
    expect((await post("192.168.77.5", {})).status).toBe(400);
    expect((await post("192.168.77.9", { allow: true })).status).toBe(404);
    expect((await (await post("192.168.77.5", { allow: true })).json()).pending).toEqual([{ ip: "192.168.77.6", model: null }]);
    expect((await (await post("192.168.77.6", { allow: false })).json()).pending).toEqual([]);
    expect(tv.approved().find((d) => d.ip === "192.168.77.5")).toMatchObject({ kind: "tv", via: "click", model: "Samsung 85R85H" });
    expect((await tv.fetch(req("/api/videos"), "192.168.77.5")).status).toBe(200);
    expect((await tv.fetch(req("/api/videos"), "192.168.77.6")).status).toBe(403); // denied until the next turn-on
    expect(tv.state().pending).toEqual([]);
  });

  test("a Mac polling its approvals is seen but does not make the Library Server look busy", async () => {
    const { tv, db } = server({ "100.101.1.2": same });
    await tv.fetch(req("/api/approvals"), "100.101.1.2");
    expect((tv as unknown as { activity: unknown }).activity).toBeNull(); // what `playing` is made from
    await tv.fetch(req("/api/videos"), "100.101.1.2");
    expect((tv as unknown as { activity: unknown }).activity).not.toBeNull();
    expect((db.query("SELECT last_seen_at FROM approved_device WHERE ip = '100.101.1.2'").get() as { last_seen_at: string | null }).last_seen_at).not.toBeNull();
  });
});

// ---- two machines: a Home Server listening, a Mac's localhost side asking it over HTTP ----

describe("Allow from another Mac (two machines)", () => {
  const { tv } = server({ "127.0.0.1": same }, { tvLoopback: true, tailscaleOwn: true });
  afterAll(() => tv.stop());

  test("the Mac sees 'Allow TV at ‹IP› on ‹name›?' and its Allow approves the TV on the server", async () => {
    expect(tv.start()).toEqual({ ok: true });
    const target = () => `http://127.0.0.1:${tv.port}`;
    expect(await homeApprovals(target)).toMatchObject({ configured: true, connected: true, pending: [] });
    expect(tv.approved()).toMatchObject([{ ip: "127.0.0.1", kind: "mac", via: "tailscale" }]);

    await tv.fetch(req("/api/videos", { headers: { "x-tuva-tv": "Samsung 85R85H" } }), "192.168.77.5");
    const seen = await homeApprovals(target);
    expect(seen.pending).toEqual([{ ip: "192.168.77.5", model: "Samsung 85R85H" }]);
    expect(homePromptText(seen)).toBe(`Allow TV at 192.168.77.5 on ${seen.server}?`);

    const after = await answerHomeApproval(target, "192.168.77.5", true);
    expect(after).toMatchObject({ connected: true, pending: [] });
    expect(homePromptText(after)).toBeNull();
    expect(tv.approved().find((d) => d.ip === "192.168.77.5")).toMatchObject({ kind: "tv", via: "click" });
    // answered already (on the mini, say): still the current list, connected
    expect(await answerHomeApproval(target, "192.168.77.5", true)).toMatchObject({ connected: true, pending: [] });
  });

  test("no Home Server set: nothing shows; an unreachable one is not connected", async () => {
    expect(await homeApprovals(homeServerFromEnv({}))).toEqual({ configured: false, connected: false, server: null, pending: [] });
    expect(homeServerFromEnv({ TUVA_HOME_SERVER: "http://h:4401/" })()).toBe("http://h:4401");
    const down = await homeApprovals(() => "http://127.0.0.1:1");
    expect(down).toMatchObject({ configured: true, connected: false });
    expect(homePromptText(down)).toBeNull();
  });
});
