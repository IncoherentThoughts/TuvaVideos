// The browser's write seam against a companion that refuses local edits of Shared Videos (SYNC-6) and a write the
// archive refuses as `forbidden` (SYNC-12): `writeLink` over a mocked fetch and a mocked session layer (no supabase-js).
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { SHARED_VIDEO_LOCAL_EDIT } from "../src/shared/share";

const calls = { rpc: [] as { fn: string; args: unknown }[], fetch: [] as string[], syncs: 0 };
let rpcAnswer: () => { data: unknown; error: unknown; status?: number } = () => ({ data: { tables: {}, tombstones: [] }, error: null, status: 200 });
mock.module(join(import.meta.dir, "..", "src", "web", "session.ts"), () => ({
  afterWrite: async () => null,
  requestSync: async () => {
    calls.syncs++;
    return null;
  },
  archiveRpc: () => ({ rpc: async (fn: string, args: unknown) => (calls.rpc.push({ fn, args }), rpcAnswer()) }),
}));

const VID = "aaaaaaaa-0000-4000-8000-000000000001";
const video = (shared: boolean) => ({ id: VID, shared, updatedAt: "2026-10-10T00:00:00.000Z", title: "Old", type: "song", artists: [] });
let sharedNow = true;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.fetch.push(`${method} ${url}`);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url === "/api/session") return json({ record: { userId: "u", grantLevel: "editor" }, archive: { url: "x", key: "k" }, syncing: false });
  if (url.startsWith("/api/kinds")) return json({ songs: {}, versions: {}, artists: {} });
  if (method === "PATCH" && url === `/api/videos/${VID}`) return json({ error: SHARED_VIDEO_LOCAL_EDIT }, 409);
  if (url === `/api/videos/${VID}`) return json(video(sharedNow));
  if (url === "/api/cache/apply") return json({});
  return json({ error: "unexpected" }, 404);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const { writeLink } = await import("../src/web/writeLink");

beforeEach(() => {
  calls.rpc = [];
  calls.fetch = [];
  calls.syncs = 0;
  sharedNow = true;
  rpcAnswer = () => ({ data: { tables: {}, tombstones: [] }, error: null, status: 200 });
});

describe("SYNC-6: a page holding a stale `shared: false` Video", () => {
  test("the companion's 409 makes writeLink re-read the Video and write through the archive", async () => {
    await writeLink(video(false) as never, { kind: "video.update", patch: { title: "New" } }, { quiet: true });
    expect(calls.fetch).toContain(`PATCH /api/videos/${VID}`);
    expect(calls.rpc.map((c) => c.fn)).toEqual(["write_videos"]);
    expect(calls.fetch).toContain("POST /api/cache/apply");
  });
  test("a re-read that still says Unshared keeps the refusal (no loop)", async () => {
    sharedNow = false;
    await expect(writeLink(video(false) as never, { kind: "video.update", patch: { title: "New" } }, { quiet: true })).rejects.toThrow(SHARED_VIDEO_LOCAL_EDIT);
    expect(calls.rpc).toEqual([]);
  });
});

describe("SYNC-12: a forbidden write re-reads the grant at once", () => {
  test("writeLink asks for a Sync (the companion's whoami re-read writes the record)", async () => {
    rpcAnswer = () => ({ data: null, error: { code: "42501", message: "permission denied" }, status: 403 });
    await expect(writeLink(video(true) as never, { kind: "video.update", patch: { title: "New" } }, { quiet: true })).rejects.toThrow();
    expect(calls.syncs).toBe(1);
  });
});
