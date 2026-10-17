import { beforeAll, describe, expect, test } from "bun:test"

// tv/shell/discovery.js is a classic script that publishes TuvaDiscovery on the global object.
const path = "../tv/shell/discovery.js"
beforeAll(async () => {
  await import(path)
})
const D = () => (globalThis as any).TuvaDiscovery

type Resp = { ok: boolean; status: number; text(): Promise<string> }
const resp = (status: number, body = ""): Resp => ({ ok: status >= 200 && status < 300, status, text: async () => body })
const HEALTH = '{"service":"TuvaVideos TV Server"}'
const flush = () => new Promise<void>((r) => setImmediate(r))

type Timer = { at: number; fn: () => void }
/** A manual clock: timers only fire when advance() walks time forward. */
function fakeClock() {
  let now = 0
  let id = 0
  const timers = new Map<number, Timer>()
  return {
    setTimeout(fn: () => void, ms: number) {
      timers.set(++id, { at: now + ms, fn })
      return id
    },
    clearTimeout(i: number) {
      timers.delete(i)
    },
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        await flush()
        let next: [number, Timer] | undefined
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e
        if (!next) break
        timers.delete(next[0])
        now = Math.max(now, next[1].at)
        next[1].fn()
      }
      now = end
      await flush()
    },
  }
}

type Handler = (addr: string, path: string) => Resp | "hang" | "refuse"

function setup(handler: Handler, opts: { last?: string; ip?: string | null } = {}) {
  const clock = fakeClock()
  const calls: { url: string; headers?: Record<string, string> }[] = []
  let inFlight = 0
  let maxInFlight = 0
  const store = new Map<string, string>()
  if (opts.last) store.set("tuva.tv.last", opts.last)
  const states: any[] = []
  const env = {
    fetch(url: string, init: any) {
      const m = /^http:\/\/([\d.]+):4401(\/.*)$/.exec(url)!
      calls.push({ url, headers: init?.headers })
      const r = handler(m[1], m[2])
      if (r === "refuse") return Promise.reject(new TypeError("refused"))
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      if (r === "hang") {
        init?.signal?.addEventListener("abort", () => inFlight--) // in flight until the 2 s timeout aborts it
        return new Promise<Resp>(() => {})
      }
      inFlight--
      return Promise.resolve(r)
    },
    clock,
    storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    localIp: () => (opts.ip === undefined ? "192.168.4.56" : opts.ip),
    model: () => "MRN85R85HAFXZA",
    onState: (s: any) => states.push(s),
  }
  const disc = D().create(env)
  const kinds = () => states.map((s) => (s.kind === "looking" ? `looking:${s.step}` : s.kind))
  return { disc, clock, calls, states, store, kinds, maxInFlight: () => maxInFlight }
}

const MAC = "192.168.4.83"
const BASE = `http://${MAC}:4401`
const macServer = (videos: () => Resp = () => resp(200, "[]")): Handler => (addr, p) =>
  addr !== MAC ? "refuse" : p === "/api/health" ? resp(200, HEALTH) : videos()

describe("discovery order", () => {
  test("the last address answers: no sweep", async () => {
    const t = setup(macServer(), { last: MAC })
    t.disc.start()
    await t.clock.advance(100)
    expect(t.kinds()).toEqual(["looking:last", "looking:access", "ready"])
    expect(t.states.at(-1)).toEqual({ kind: "ready", base: BASE })
    expect(t.calls.map((c) => c.url)).toEqual([`${BASE}/api/health`, `${BASE}/api/videos`])
    expect(t.calls[1].headers).toEqual({ "X-Tuva-TV": "MRN85R85HAFXZA" })
  })

  test("the last address fails: the sweep of the TV's /24 finds the Mac and it is stored", async () => {
    const t = setup(macServer(), { last: "192.168.4.99" })
    t.disc.start()
    await t.clock.advance(100)
    expect(t.kinds().slice(0, 2)).toEqual(["looking:last", "looking:sweep"])
    expect(t.states.at(-1).kind).toBe("ready")
    expect(t.store.get("tuva.tv.last")).toBe(MAC)
    const probed = t.calls.filter((c) => c.url.endsWith("/api/health")).map((c) => c.url)
    expect(probed.some((u) => u.includes("192.168.4.56:"))).toBe(false) // the TV itself is skipped
    expect(probed.filter((u) => u.includes("192.168.4.99:")).length).toBe(1) // the last address is not asked twice
  })

  test("no stored address: the sweep uses the TV's own address", async () => {
    const t = setup(macServer())
    t.disc.start()
    await t.clock.advance(100)
    expect(t.kinds()[0]).toBe("looking:sweep")
    expect(t.states.at(-1).kind).toBe("ready")
  })

  test("a hanging last address times out after 2 s; the sweep keeps 32 requests in flight and also times out at 2 s", async () => {
    const t = setup((addr, p) => (addr === MAC ? (p === "/api/health" ? resp(200, HEALTH) : resp(200, "[]")) : "hang"), {
      last: "192.168.4.99",
    })
    t.disc.start()
    await t.clock.advance(1999)
    expect(t.kinds()).toEqual(["looking:last"])
    await t.clock.advance(2) // 2001 ms: the last address gave up
    expect(t.kinds()).toEqual(["looking:last", "looking:sweep"])
    expect(t.maxInFlight()).toBe(32)
    expect(t.calls.length).toBe(1 + 32)
    await t.clock.advance(1990) // 3991 ms: the first 32 are still pending
    expect(t.calls.length).toBe(1 + 32)
    await t.clock.advance(20) // past 4 s: they timed out and the next 32 started
    expect(t.calls.length).toBe(1 + 64)
    await t.clock.advance(30000)
    expect(t.states.at(-1).kind).toBe("ready")
  })

  test("a health answer without the service name does not count", async () => {
    const t = setup((addr, p) => (addr === MAC && p === "/api/health" ? resp(200, "<html>router admin</html>") : "refuse"), { last: MAC })
    t.disc.start()
    await t.clock.advance(100)
    expect(t.states.at(-1)).toEqual({ kind: "looking", step: "typed", detail: "" })
  })

  test("nothing answers: last, sweep, then the typed step; the whole sequence retries every 5 s", async () => {
    const t = setup(() => "hang", { last: "192.168.4.99" })
    t.disc.start()
    await t.clock.advance(2000)
    await t.clock.advance(20000) // 253 hosts / 32 in flight x 2 s
    expect(t.kinds()).toEqual(["looking:last", "looking:sweep", "looking:typed"])
    const before = t.calls.length
    await t.clock.advance(5001)
    expect(t.kinds().slice(3, 5)).toEqual(["looking:last", "looking:sweep"])
    expect(t.calls.length).toBeGreaterThan(before)
  })

  test("with no address at all there is nothing to sweep: straight to the typed step", async () => {
    const t = setup(() => "refuse", { ip: null })
    t.disc.start()
    await t.clock.advance(10)
    expect(t.kinds()).toEqual(["looking:typed"])
  })
})

describe("typed address", () => {
  test("normalizeTyped: a bare number is the last octet of the subnet", () => {
    expect(D().normalizeTyped("83", "192.168.4.")).toBe(MAC)
    expect(D().normalizeTyped("192.168.1.20", "192.168.4.")).toBe("192.168.1.20")
    expect(D().normalizeTyped("192.168.4.", "192.168.4.")).toBeNull()
    expect(D().normalizeTyped("300", "192.168.4.")).toBeNull()
    expect(D().normalizeTyped("1.2.3.256", "")).toBeNull()
  })

  test("Enter opens the field (retries pause), a wrong address says so, the right one connects", async () => {
    let up = false
    const t = setup((addr, p) => (up ? macServer()(addr, p) : "refuse"), { ip: "192.168.4.56" })
    t.disc.start()
    await t.clock.advance(10)
    expect(t.states.at(-1).step).toBe("typed")
    t.disc.openTyped()
    expect(t.states.at(-1)).toEqual({ kind: "typing", prefix: "192.168.4." })
    await t.clock.advance(30000)
    expect(t.states.at(-1).kind).toBe("typing") // no retry noise while typing
    expect(await t.disc.submitTyped("12")).toBe(false)
    expect(t.states.at(-1).error).toContain("192.168.4.12")
    up = true
    expect(await t.disc.submitTyped("83")).toBe(true)
    await t.clock.advance(10)
    expect(t.states.at(-1)).toEqual({ kind: "ready", base: BASE })
    expect(t.store.get("tuva.tv.last")).toBe(MAC)
  })

  test("Back on an empty field returns to the looking screen", async () => {
    const t = setup(() => "refuse", { ip: null })
    t.disc.start()
    await t.clock.advance(10)
    t.disc.openTyped()
    t.disc.closeTyped()
    expect(t.kinds()).toEqual(["looking:typed", "typing", "looking:typed"])
  })
})

describe("approval", () => {
  test("403 shows the approve screen and retries every 3 s until the Mac allows it", async () => {
    let videosCalls = 0
    const t = setup(macServer(() => (++videosCalls <= 3 ? resp(403) : resp(200, "[]"))), { last: MAC })
    t.disc.start()
    await t.clock.advance(10)
    expect(t.states.at(-1)).toEqual({ kind: "denied", base: BASE })
    expect(videosCalls).toBe(1)
    await t.clock.advance(2980)
    expect(videosCalls).toBe(1)
    await t.clock.advance(30)
    expect(videosCalls).toBe(2)
    await t.clock.advance(3000)
    expect(videosCalls).toBe(3)
    await t.clock.advance(3000)
    expect(videosCalls).toBe(4)
    expect(t.states.at(-1).kind).toBe("ready")
    expect(t.kinds().filter((k) => k === "denied").length).toBe(3)
  })
})

describe("TV Server turned off", () => {
  test("health stops answering after a success: off after two misses, and Enter looks again", async () => {
    let on = true
    const t = setup((addr, p) => (on ? macServer()(addr, p) : "hang"), { last: MAC })
    t.disc.start()
    await t.clock.advance(10)
    expect(t.states.at(-1).kind).toBe("ready")

    await t.clock.advance(5000) // a healthy check changes nothing
    expect(t.states.at(-1).kind).toBe("ready")

    on = false
    await t.clock.advance(5000 + 2000) // first miss
    expect(t.states.at(-1).kind).toBe("ready")
    await t.clock.advance(5000 + 2000) // second miss
    expect(t.states.at(-1)).toEqual({ kind: "off", base: BASE })

    on = true
    t.disc.lookAgain()
    await t.clock.advance(100)
    expect(t.states.at(-1).kind).toBe("ready")
    expect(t.kinds().slice(-4, -1)).toEqual(["off", "looking:last", "looking:access"])
  })

  test("one missed check followed by an answer does not turn it off", async () => {
    let n = 0
    const t = setup((addr, p) => (p === "/api/health" && addr === MAC && ++n === 3 ? "hang" : macServer()(addr, p)), { last: MAC })
    t.disc.start()
    await t.clock.advance(60000)
    expect(n).toBeGreaterThan(5)
    expect(t.states.at(-1).kind).toBe("ready")
  })
})
