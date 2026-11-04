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
  if (method === "POST" && url === `/api/videos/${VID}/chapters`) return json({ id: "ch-new", videoId: VID, startS: 12, title: "Kept", favoritedAt: null }, 201);
  if (method === "POST" && url === "/api/chapters/ch-new/favorite") return json({ id: "ch-new", favorite: true, favoritedAt: "2026-11-04T00:00:00.000Z" });
  return json({ error: "unexpected" }, 404);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const { writeLink } = await import("../src/web/writeLink");
const { copyBackOp } = await import("../src/web/writeOps");

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

describe("SYNC-11: copying back a starred Shelved Chapter re-stars it", () => {
  test("copyBackOp carries the star and writeLink puts it on the new Chapter", async () => {
    const op = copyBackOp({ kind: "chapter", payload: { startS: 12, title: "Kept", songId: null, versionId: null, favoritedAt: "2026-09-01T00:00:00Z" } });
    expect(op).toMatchObject({ kind: "chapter.add", favoritedAt: "2026-09-01T00:00:00Z" });
    const c = await writeLink(video(false) as never, op!, { quiet: true });
    expect(calls.fetch).toContain("POST /api/chapters/ch-new/favorite");
    expect((c as { favoritedAt: string | null }).favoritedAt).not.toBeNull();
  });
  test("an unstarred Shelved Chapter is not starred", async () => {
    const op = copyBackOp({ kind: "chapter", payload: { startS: 12, title: "Kept", favoritedAt: null } });
    expect(op && "favoritedAt" in op).toBe(false);
    await writeLink(video(false) as never, op!, { quiet: true });
    expect(calls.fetch.some((f) => f.includes("/favorite"))).toBe(false);
  });
});

describe("SYNC-12: a forbidden write re-reads the grant at once", () => {
  test("writeLink asks for a Sync (the companion's whoami re-read writes the record)", async () => {
    rpcAnswer = () => ({ data: null, error: { code: "42501", message: "permission denied" }, status: 403 });
    await expect(writeLink(video(true) as never, { kind: "video.update", patch: { title: "New" } }, { quiet: true })).rejects.toThrow();
    expect(calls.syncs).toBe(1);
  });
});
