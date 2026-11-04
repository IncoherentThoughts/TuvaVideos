// The "preparing" wait ends (audit PLAY-11): a deleted Copy, a dead server, a Fallback that went back to `none` and an
// overall deadline all stop the poll instead of showing "preparing" forever.
import { describe, expect, test } from "bun:test";
import { awaitCopy } from "../src/shared/prepare";

type Reply = { status: number; body?: unknown };

/** /copy/:id and /api/copies/:id each answer from a script (the last reply repeats). */
function stub(copyReplies: Reply[], polls: Reply[]) {
  const calls: string[] = [];
  const res = (r: Reply) => ({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body, body: { cancel: () => {} } });
  const next = (q: Reply[]) => (q.length > 1 ? q.shift()! : q[0]!);
  const deps = {
    fetch: async (url: string) => {
      calls.push(url);
      return res(url.startsWith("/copy/") ? next(copyReplies) : next(polls));
    },
    sleep: async (_ms: number) => {},
    onProgress: () => {},
    cancelled: () => false,
  };
  return { deps, calls };
}
const preparing = { status: 503, body: { state: "queued", progress: 0 } };
const fb = (state: string) => ({ status: 200, body: { fallback: { state, progress: null } } });

describe("awaitCopy is bounded", () => {
  test("a Copy deleted while waiting (404) fails at once", async () => {
    expect(await awaitCopy(1, stub([preparing], [fb("preparing"), { status: 404 }]).deps)).toBe("failed");
  });

  test("the server failing every poll gives up after a few tries", async () => {
    const s = stub([preparing], [{ status: 500 }]);
    expect(await awaitCopy(1, s.deps)).toBe("failed");
    expect(s.calls.length).toBeLessThan(15);
  });

  test("a Fallback state of none asks /copy/:id again, which may serve it now", async () => {
    const s = stub([preparing, { status: 206 }], [fb("none")]);
    expect(await awaitCopy(1, s.deps)).toBe("ready");
    expect(s.calls).toEqual(["/copy/1", "/api/copies/1", "/copy/1"]);
  });

  test("a Fallback that keeps going back to none fails after a few re-requests", async () => {
    const s = stub([preparing], [fb("none")]);
    expect(await awaitCopy(1, s.deps)).toBe("failed");
    expect(s.calls.filter((c) => c.startsWith("/copy/")).length).toBe(4);
  });

  test("an endless 'preparing' ends at the deadline", async () => {
    const s = stub([preparing], [fb("preparing")]);
    expect(await awaitCopy(1, { ...s.deps, pollMs: 1000, maxWaitMs: 10_000 })).toBe("failed");
    expect(s.calls.length).toBe(1 + 10);
  });
});
