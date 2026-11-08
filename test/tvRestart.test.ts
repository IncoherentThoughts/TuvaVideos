// When a 403 reloads the TV app (src/tv/data.ts): only a confirmed "approve". A reload drops the Player and the screen
// the TV was on, so any other 403, or one the second ask does not repeat, fails just that request.
import { describe, expect, test } from "bun:test"
import { shouldRestart } from "../src/tv/data"

const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status })

describe("shouldRestart", () => {
  test("a 403 approve that the second ask repeats restarts", async () => {
    expect(await shouldRestart(res(403, { error: "approve" }), async () => res(403))).toBe(true)
  })
  test("a 403 approve that the second ask does not repeat stays put", async () => {
    expect(await shouldRestart(res(403, { error: "approve" }), async () => res(200))).toBe(false)
  })
  test("a second ask that gets no answer (an outage) stays put", async () => {
    expect(await shouldRestart(res(403, { error: "approve" }), async () => Promise.reject(new TypeError("Failed to fetch")))).toBe(false)
  })
  test("another 403, or one with no JSON body, never restarts and never asks again", async () => {
    let asked = 0
    const again = async () => (asked++, res(403))
    expect(await shouldRestart(res(403, { error: "Origin is not the TV app" }), again)).toBe(false)
    expect(await shouldRestart(res(403, { error: "this Video is Shared" }), again)).toBe(false)
    expect(await shouldRestart(new Response("nope", { status: 403 }), again)).toBe(false)
    expect(asked).toBe(0)
  })
})
