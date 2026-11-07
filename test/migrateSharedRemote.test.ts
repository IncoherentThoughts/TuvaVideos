// The migration's archive client (src/server/migrateShared/remote.ts): signInAs, over a stubbed fetch.
import { afterEach, describe, expect, test } from "bun:test";
import { Archive } from "../src/server/migrateShared/remote";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Stubs fetch with one JSON body per path prefix; records each path called and whether it carried a signal. */
function stub(bodies: Record<string, unknown>): { path: string; signal: boolean }[] {
  const calls: { path: string; signal: boolean }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace("https://archive.test", "");
    calls.push({ path, signal: init?.signal instanceof AbortSignal });
    const key = Object.keys(bodies).find((k) => path.startsWith(k));
    if (!key) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(bodies[key]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

const env = { url: "https://archive.test", publishableKey: "pub", serviceKey: "service" };

describe("signInAs", () => {
  test("an email no archive account has stops before generate_link (which would create the account)", async () => {
    const calls = stub({ "/rest/v1/profiles": [] });
    await expect(new Archive(env).signInAs("nobody@example.com")).rejects.toThrow("no archive account has the email nobody@example.com");
    expect(calls.map((c) => c.path)).toEqual(["/rest/v1/profiles?email=eq.nobody%40example.com&select=id"]);
  });

  test("a known email mints a session through generate_link and verify, every call with a timeout", async () => {
    const calls = stub({
      "/rest/v1/profiles": [{ id: "u1" }],
      "/auth/v1/admin/generate_link": { hashed_token: "h" },
      "/auth/v1/verify": { access_token: "a", refresh_token: "r" },
    });
    await new Archive(env).signInAs("owner@example.com");
    expect(calls.map((c) => c.path.split("?")[0])).toEqual(["/rest/v1/profiles", "/auth/v1/admin/generate_link", "/auth/v1/verify"]);
    expect(calls.every((c) => c.signal)).toBe(true);
  });
});
