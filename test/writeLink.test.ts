// writeLink's router (sharing-spec §4.9; audit BLD-7): which destination a write of link data takes. writeOps.ts's pure
// mapping is covered in writeSeam.test.ts; this drives the glue in src/web/writeLink.ts with a stubbed session (the
// archive RPC client), page caches and fetch. No DOM is needed for these paths.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let rpcCalls: { fn: string; args: unknown }[] = [];
let record: { grantLevel?: string } | null = null;
let rpcReply: { data: unknown; error: { code: string; message: string; details?: string } | null } = { data: { tables: {} }, error: null };
let signedIn = true;
let afterWrites = 0;
const replaced: unknown[] = [];

const VIDEO = { id: "11111111-1111-4111-8111-111111111111", shared: false, updatedAt: "2026-11-01T00:00:00.000Z", title: "Old title" };
const fresh = { ...VIDEO, title: "New title" };

mock.module("../src/web/session", () => ({
  archiveRpc: () => (signedIn ? { rpc: async (fn: string, args: unknown) => (rpcCalls.push({ fn, args }), rpcReply) } : null),
  afterWrite: async () => (afterWrites++, null),
  requestSync: async () => null,
}));
mock.module("../src/web/data", () => ({
  api: { video: async () => fresh, chapters: async () => [] },
  forgetSong: () => {},
  loadArtists: async () => {},
  loadVideos: async () => {},
  removeVideo: () => {},
  replaceVideo: (v: unknown) => replaced.push(v),
}));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url === "/api/session") return json({ record });
  if (url === "/api/cache/apply") return json({ ok: true });
  if (url.startsWith("/api/videos/") && method === "PATCH") return json(fresh);
  return json({ error: "unexpected" }, 500);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

const { writeLink, WriteLinkError } = await import("../src/web/writeLink");
const writes = () => calls.filter((c) => c.url !== "/api/session");

beforeEach(() => {
  calls = [];
  rpcCalls = [];
  replaced.length = 0;
  afterWrites = 0;
  signedIn = true;
  rpcReply = { data: { tables: {} }, error: null };
});

describe("writeLink routing", () => {
  test("an Unshared Video takes the companion's own route, on any machine; nothing goes to the archive", async () => {
    for (const r of [null, { grantLevel: "member" }, { grantLevel: "editor" }]) {
      record = r;
      calls = [];
      const v = await writeLink(VIDEO, { kind: "video.update", patch: { title: "New title" } });
      expect(v).toEqual(fresh as never);
      expect(writes()).toEqual([{ method: "PATCH", url: `/api/videos/${VIDEO.id}`, body: { title: "New title" } }]);
    }
    expect(rpcCalls).toEqual([]);
    expect(replaced).toHaveLength(3);
  });

  test("a Shared Video on a Video Editor's machine goes to the archive, then its bundle to /api/cache/apply, then a Sync", async () => {
    record = { grantLevel: "editor" };
    const bundle = { tables: { videos: [{ id: VIDEO.id, title: "New title" }] } };
    rpcReply = { data: bundle, error: null };
    const v = await writeLink({ ...VIDEO, shared: true }, { kind: "video.update", patch: { title: "New title" } });
    expect(v).toEqual(fresh as never);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.fn).toBe("write_videos");
    expect(rpcCalls[0]!.args).toMatchObject({ p_target: VIDEO.id, p_expected_updated_at: VIDEO.updatedAt, p_payload: { title: "New title" } });
    expect(writes()).toEqual([{ method: "POST", url: "/api/cache/apply", body: bundle }]);
    expect(afterWrites).toBe(1);
  });

  test("a Shared Video is refused for a Member and on a machine with no grant; nothing is written", async () => {
    for (const r of [{ grantLevel: "member" }, { grantLevel: "no-grant" }, null]) {
      record = r;
      const e = await writeLink({ ...VIDEO, shared: true }, { kind: "video.update", patch: { title: "x" } }).catch((x) => x);
      expect(e).toBeInstanceOf(WriteLinkError);
      expect(e.word).toBe("refused");
    }
    expect(rpcCalls).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("a Video Editor whose session dropped is refused before any write", async () => {
    record = { grantLevel: "editor" };
    signedIn = false;
    const e = await writeLink({ ...VIDEO, shared: true }, { kind: "video.update", patch: { title: "x" } }).catch((x) => x);
    expect(e).toBeInstanceOf(WriteLinkError);
    expect(e.word).toBe("refused");
    expect(writes()).toEqual([]);
  });

  test("an archive conflict throws a conflict WriteLinkError and the Local copy is not written", async () => {
    record = { grantLevel: "editor" };
    rpcReply = { data: null, error: { code: "VD409", message: "stale", details: JSON.stringify({ table: "videos", id: VIDEO.id, updated_at: "2026-11-02T00:00:00.000Z", last_edit: null }) } };
    const e = await writeLink({ ...VIDEO, shared: true }, { kind: "video.update", patch: { title: "New title" } }, { quietConflict: true }).catch((x) => x);
    expect(e).toBeInstanceOf(WriteLinkError);
    expect(e.word).toBe("conflict");
    expect(writes()).toEqual([]);
    expect(afterWrites).toBe(0);
  });

  test("delete and restore of an Unshared Video are refused here (the companion's own delete is not a link write)", async () => {
    record = { grantLevel: "editor" };
    for (const op of [{ kind: "video.delete", reason: "dup" }, { kind: "video.restore" }] as const) {
      const e = await writeLink(VIDEO, op).catch((x) => x);
      expect(e.word).toBe("refused");
    }
    expect(writes()).toEqual([]);
  });
});
