import { describe, expect, test } from "bun:test";
import { awaitCopy } from "../src/shared/prepare";

// The "preparing" overlay is hard to trigger for real (no remux Copy in the library), so the contract of spec 3.3/3.4
// is exercised here against a stub of the two endpoints.
type Reply = { status: number; body?: unknown };

/** /copy/:id answers once; /api/copies/:id answers from a script (the last reply repeats). */
function stub(copyReply: Reply | null, polls: Reply[]) {
  const calls: string[] = [];
  const progress: (number | null)[] = [];
  let cancelled = false;
  const res = (r: Reply) => ({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body, body: { cancel: () => {} } });
  const deps = {
    fetch: async (url: string) => {
      calls.push(url);
      if (url.startsWith("/copy/")) {
        if (!copyReply) throw new Error("network down");
        return res(copyReply);
      }
      return res(polls.length > 1 ? polls.shift()! : (polls[0] ?? { status: 404 }));
    },
    sleep: async (_ms: number) => {},
    onProgress: (p: number | null) => void progress.push(p),
    cancelled: () => cancelled,
  };
  return { deps, calls, progress, cancel: () => (cancelled = true) };
}
const copy = (state: string, p: number | null = null, error?: string) => ({ status: 200, body: { fallback: { state, progress: p, error } } });

describe("preparing contract against a stub server", () => {
  test("503 with a state: shows progress, polls /api/copies/:id, resolves ready", async () => {
    const s = stub({ status: 503, body: { state: "queued", progress: 0 } }, [copy("preparing", 0.25), copy("preparing", 0.7), copy("ready", 1)]);
    expect(await awaitCopy(7, s.deps)).toBe("ready");
    expect(s.progress).toEqual([0, 0.25, 0.7]);
    expect(s.calls).toEqual(["/copy/7", "/api/copies/7", "/api/copies/7", "/api/copies/7"]);
  });
  test("progress may be unknown (no duration): the overlay gets null", async () => {
    const s = stub({ status: 503, body: { state: "preparing", progress: null } }, [copy("preparing", null), copy("ready")]);
    expect(await awaitCopy(1, s.deps)).toBe("ready");
    expect(s.progress).toEqual([null, null]);
  });
  test("a failed Fallback resolves failed", async () => {
    const s = stub({ status: 503, body: { state: "preparing", progress: 0.1 } }, [copy("failed", null, "ffmpeg exited 1")]);
    expect(await awaitCopy(2, s.deps)).toBe("failed");
  });
  test("a Copy that is already servable (206) needs no polling", async () => {
    const s = stub({ status: 206 }, []);
    expect(await awaitCopy(3, s.deps)).toBe("ready");
    expect(s.calls).toEqual(["/copy/3"]);
  });
  test("a gone Copy (404), a dead server and a 503 with no Fallback state (drive hiccup) fail", async () => {
    expect(await awaitCopy(4, stub({ status: 404, body: { error: "copy is missing" } }, []).deps)).toBe("failed");
    expect(await awaitCopy(4, stub(null, []).deps)).toBe("failed");
    expect(await awaitCopy(4, stub({ status: 503, body: { error: "file temporarily unreadable", retryable: true } }, []).deps)).toBe("failed");
  });
  test("poll hiccups are ridden out; leaving the page cancels", async () => {
    const s = stub({ status: 503, body: { state: "queued", progress: 0 } }, [{ status: 500 }, copy("ready")]);
    expect(await awaitCopy(5, s.deps)).toBe("ready");
    const c = stub({ status: 503, body: { state: "queued", progress: 0 } }, [copy("preparing", 0.5)]);
    c.deps.sleep = async () => {
      c.cancel();
    };
    expect(await awaitCopy(6, c.deps)).toBe("cancelled");
  });
});
