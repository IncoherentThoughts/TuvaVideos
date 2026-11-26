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
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    localIp: () => (opts.ip === undefined ? "192.168.4.56" : opts.ip),
    model: () => "MRN85R85HAFXZA",
    onState: (s: any) => states.push(s),
  }
  const disc = D().create(env)
  // consecutive repeats folded: the sweep reports again each time it finds a server
  const kinds = () =>
    states.map((s) => (s.kind === "looking" ? `looking:${s.step}` : s.kind)).filter((k, i, a) => i === 0 || a[i - 1] !== k)
  return { disc, clock, calls, states, store, kinds, maxInFlight: () => maxInFlight }
}

const MAC = "192.168.4.83"
const BASE = `http://${MAC}:4401`
const macServer = (videos: () => Resp = () => resp(200, "[]")): Handler => (addr, p) =>
  addr !== MAC ? "refuse" : p === "/api/health" ? resp(200, HEALTH) : videos()

describe("discovery order", () => {
  test("the last address and the sweep run together; the only answer connects straight away", async () => {
    const t = setup(macServer(), { last: MAC })
    t.disc.start()
    await t.clock.advance(100)
    expect(t.kinds()).toEqual(["looking:sweep", "looking:access", "ready"])
    expect(t.states.at(-1)).toEqual({ kind: "ready", base: BASE, address: MAC, name: null })
    const health = t.calls.filter((c) => c.url.endsWith("/api/health"))
    expect(health[0].url).toBe(`${BASE}/api/health`) // the last address first
    expect(health.length).toBe(1 + 252) // and the rest of the /24, minus the TV and the last address
    const videos = t.calls.filter((c) => c.url.endsWith("/api/videos"))
    expect(videos.map((c) => c.url)).toEqual([`${BASE}/api/videos`])
    expect(videos[0].headers).toEqual({ "X-Tuva-TV": "MRN85R85HAFXZA" })
  })

  test("the last address fails: the sweep of the TV's /24 finds the Mac and it is stored", async () => {
    const t = setup(macServer(), { last: "192.168.4.99" })
    t.disc.start()
    await t.clock.advance(100)
    expect(t.kinds()[0]).toBe("looking:sweep")
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

  test("hanging hosts time out after 2 s; the last address plus 32 sweep requests in flight; it waits for the whole sweep", async () => {
    const t = setup((addr, p) => (addr === MAC ? (p === "/api/health" ? resp(200, HEALTH) : resp(200, "[]")) : "hang"), {
      last: "192.168.4.99",
    })
    t.disc.start()
    await t.clock.advance(1)
    expect(t.kinds()).toEqual(["looking:sweep"])
    expect(t.maxInFlight()).toBe(1 + 32)
    expect(t.calls.length).toBe(1 + 32)
    await t.clock.advance(1990) // the first ones are still pending
    expect(t.calls.length).toBe(1 + 32)
    await t.clock.advance(20) // past 2 s: they timed out and the next 32 started
    expect(t.calls.length).toBe(1 + 64)
    await t.clock.advance(4100) // third round: .83 answered, but later hosts may still answer
    expect(t.states.at(-1)).toMatchObject({ kind: "looking", step: "sweep", found: [MAC] })
    await t.clock.advance(30000)
    expect(t.states.at(-1).kind).toBe("ready")
  })

  test("a health answer without the service name does not count", async () => {
    const t = setup((addr, p) => (addr === MAC && p === "/api/health" ? resp(200, "<html>router admin</html>") : "refuse"), { last: MAC })
    t.disc.start()
    await t.clock.advance(100)
    expect(t.states.at(-1)).toEqual({ kind: "typing", prefix: "192.168.4." })
  })

  test("nothing answers: last, sweep, then the typed field opens by itself; the sequence keeps retrying behind it", async () => {
    const t = setup(() => "hang", { last: "192.168.4.99" })
    t.disc.start()
    await t.clock.advance(2000)
    await t.clock.advance(20000) // 253 hosts / 32 in flight x 2 s
    expect(t.kinds()).toEqual(["looking:sweep", "typing"])
    expect(t.states.at(-1)).toEqual({ kind: "typing", prefix: "192.168.4." })
    const before = t.calls.length
    await t.clock.advance(5001)
    expect(t.calls.length).toBeGreaterThan(before) // retried
    expect(t.kinds()).toEqual(["looking:sweep", "typing"]) // without taking the field away
  })

  test("with no address at all there is nothing to sweep: straight to the typed field, empty", async () => {
    const t = setup(() => "refuse", { ip: null })
    t.disc.start()
    await t.clock.advance(10)
    expect(t.kinds()).toEqual(["typing"])
    expect(t.states.at(-1)).toEqual({ kind: "typing", prefix: "" })
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

  test("the field opens by itself, a wrong address says so, the right one connects", async () => {
    let up = false
    const t = setup((addr, p) => (up ? macServer()(addr, p) : "refuse"), { ip: "192.168.4.56" })
    t.disc.start()
    await t.clock.advance(10)
    expect(t.states.at(-1)).toEqual({ kind: "typing", prefix: "192.168.4." })
    await t.clock.advance(30000)
    expect(t.states.at(-1).kind).toBe("typing") // no retry noise while typing
    expect(await t.disc.submitTyped("12")).toBe(false)
    expect(t.states.at(-1).error).toContain("192.168.4.12")
    up = true
    expect(await t.disc.submitTyped("83")).toBe(true)
    await t.clock.advance(10)
    expect(t.states.at(-1)).toMatchObject({ kind: "ready", base: BASE })
    expect(t.store.get("tuva.tv.last")).toBe(MAC)
  })

  test("a server switched on while the field is open is found by the retries and takes the screen", async () => {
    let up = false
    const t = setup((addr, p) => (up ? macServer()(addr, p) : "refuse"), { ip: "192.168.4.56" })
    t.disc.start()
    await t.clock.advance(10)
    expect(t.states.at(-1).kind).toBe("typing")
    up = true
    await t.clock.advance(5100)
    expect(t.states.at(-1)).toMatchObject({ kind: "ready", base: BASE })
  })

  test("Back on an empty field returns to the looking screen, and the retries do not reopen it", async () => {
    const t = setup(() => "refuse", { ip: null })
    t.disc.start()
    await t.clock.advance(10)
    t.disc.closeTyped()
    expect(t.kinds()).toEqual(["typing", "looking:typed"])
    await t.clock.advance(15100)
    expect(t.kinds().filter((k) => k === "typing").length).toBe(1)
    expect(t.states.at(-1)).toEqual({ kind: "looking", step: "typed", detail: "" })
    t.disc.openTyped() // Enter opens it again
    expect(t.states.at(-1).kind).toBe("typing")
  })

  test("TV-9: Enter during the access step: the approve screen still takes over and the retries never stop", async () => {
    let videos: () => Resp | "hang" = () => "hang"
    let healthUp = true
    const t = setup((addr, p) => (addr !== MAC ? "refuse" : p === "/api/health" ? (healthUp ? resp(200, HEALTH) : "refuse") : videos()), { last: MAC })
    t.disc.start()
    await t.clock.advance(10)
    expect(t.states.at(-1)).toMatchObject({ kind: "looking", step: "access", detail: MAC })
    videos = () => resp(403)
    t.disc.openTyped() // Enter while asking for the library
    expect(t.states.at(-1).kind).toBe("typing")
    await t.clock.advance(10_001) // the hanging /api/videos times out ("down"): the search goes round again
    await t.clock.advance(5_100)
    expect(t.states.at(-1)).toEqual({ kind: "denied", base: BASE }) // not stuck on the field
    // the server then stops answering: the approve loop gives up and the search keeps going
    healthUp = false
    videos = () => "refuse" as any
    await t.clock.advance(3_100)
    const n = t.calls.length
    await t.clock.advance(30_000)
    expect(t.calls.length).toBeGreaterThan(n + 3) // still retrying
    expect(t.states.at(-1)).toEqual({ kind: "typing", prefix: "192.168.4." }) // nothing answers now: the field, as at launch
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

describe("Library Server stopped answering", () => {
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
    expect(t.states.at(-1)).toEqual({ kind: "off", base: BASE, address: MAC, name: null })

    on = true
    t.disc.lookAgain()
    await t.clock.advance(100)
    expect(t.states.at(-1).kind).toBe("ready")
    expect(t.kinds().slice(-4, -1)).toEqual(["off", "looking:sweep", "looking:access"])
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

describe("several Library Servers (home-server-spec §4.2)", () => {
  const health = (name: string, home = false) => JSON.stringify({ app: "TuvaVideos TV Server", name, home, drive: "mounted", version: "abc1234" })
  const LAPTOP = "192.168.4.20"
  const MINI = "192.168.4.83"
  /** Each address -> its health name; /api/videos answers 200. */
  const servers = (names: Record<string, string>, home: string | null = null): Handler => (addr, p) =>
    !(addr in names) ? "refuse" : p === "/api/health" ? resp(200, health(names[addr], addr === home)) : resp(200, "[]")

  test("parseHealth: the mark is required; name and home come from the JSON", () => {
    expect(D().parseHealth(health("mac-mini", true))).toEqual({ name: "mac-mini", home: true })
    expect(D().parseHealth('{"app":"TuvaVideos TV Server"}')).toEqual({ name: null, home: false })
    expect(D().parseHealth("TuvaVideos TV Server")).toEqual({ name: null, home: false })
    expect(D().parseHealth('{"app":"Something else","name":"x"}')).toBeNull()
  })

  test("orderServers: Home Server first, then by name, unnamed last by address; the last used is focused", () => {
    const list = [
      { address: "192.168.4.30", name: null, home: false },
      { address: LAPTOP, name: "Zed's MacBook", home: false },
      { address: "192.168.4.9", name: null, home: false },
      { address: MINI, name: "mac-mini", home: true },
      { address: "192.168.4.40", name: "anna-air", home: false },
      { address: LAPTOP, name: "dup", home: false },
    ]
    const o = D().orderServers(list, LAPTOP)
    expect(o.servers.map((s: any) => s.address)).toEqual([MINI, "192.168.4.40", LAPTOP, "192.168.4.9", "192.168.4.30"])
    expect(o.focus).toBe(2)
    expect(D().orderServers(list, "10.0.0.1").focus).toBe(0) // last used not among them: the first
  })

  test("orderServers with home false everywhere (before #240): by name, the last used focused", () => {
    const o = D().orderServers(
      [
        { address: LAPTOP, name: "MacBook Pro", home: false },
        { address: MINI, name: "mac-mini", home: false },
      ],
      LAPTOP,
    )
    expect(o.servers.map((s: any) => s.name)).toEqual(["mac-mini", "MacBook Pro"])
    expect(o.focus).toBe(1)
  })

  test("two answer at startup: the picker lists both, nothing connects until one is chosen", async () => {
    const t = setup(servers({ [MINI]: "mac-mini", [LAPTOP]: "MacBook Pro" }, MINI), { last: LAPTOP })
    t.disc.start()
    await t.clock.advance(100)
    expect(t.kinds()).toEqual(["looking:sweep", "picker"])
    expect(t.states.at(-1)).toEqual({
      kind: "picker",
      servers: [
        { address: MINI, name: "mac-mini", home: true },
        { address: LAPTOP, name: "MacBook Pro", home: false },
      ],
      focus: 1, // the last used one
    })
    expect(t.calls.some((c) => c.url.endsWith("/api/videos"))).toBe(false)
    await t.clock.advance(30000)
    expect(t.states.at(-1).kind).toBe("picker") // it waits for the user
    await t.disc.choose(MINI)
    await t.clock.advance(10)
    expect(t.states.at(-1)).toEqual({ kind: "ready", base: `http://${MINI}:4401`, address: MINI, name: "mac-mini" })
    expect(t.store.get("tuva.tv.last")).toBe(MINI)
    expect(t.disc.connected()).toEqual({ address: MINI, name: "mac-mini", home: true })
  })

  test("the sweep finds every answer, not just the first", async () => {
    const t = setup(servers({ "192.168.4.2": "a", "192.168.4.200": "b", "192.168.4.254": "c" }))
    t.disc.start()
    await t.clock.advance(100)
    expect(t.states.at(-1).servers.map((s: any) => s.name)).toEqual(["a", "b", "c"])
  })

  test("a pinned server (switch by hand, then reload) is connected straight away: no sweep, no picker; the pin is used once", async () => {
    const t = setup(servers({ [MINI]: "mac-mini", [LAPTOP]: "MacBook Pro" }), { last: LAPTOP })
    t.disc.pin(MINI)
    t.disc.start()
    await t.clock.advance(100)
    expect(t.kinds()).toEqual(["looking:pinned", "looking:access", "ready"])
    expect(t.calls.filter((c) => c.url.endsWith("/api/health")).length).toBe(1)
    expect(t.store.has("tuva.tv.pin")).toBe(false)
    expect(t.store.get("tuva.tv.last")).toBe(MINI)
  })

  test("a pinned server that is gone: the sweep and the picker as usual", async () => {
    const t = setup(servers({ [MINI]: "mac-mini", [LAPTOP]: "MacBook Pro" }))
    t.disc.pin("192.168.4.77")
    t.disc.start()
    await t.clock.advance(1500)
    expect(t.kinds()).toEqual(["looking:pinned"]) // asked again a moment later: a picked server gets a few tries
    await t.clock.advance(1000)
    expect(t.kinds()).toEqual(["looking:pinned", "looking:sweep", "picker"])
    expect(t.calls.filter((c) => c.url.includes("192.168.4.77:")).length).toBe(3 + 1) // three tries, then the sweep
  })

  test("listServers: a fresh sweep for the side pane that leaves the session running; the current one is marked", async () => {
    const names: Record<string, string> = { [MINI]: "mac-mini" }
    const t = setup(servers(names), { last: MINI })
    t.disc.start()
    await t.clock.advance(100)
    expect(t.states.at(-1).kind).toBe("ready")
    names[LAPTOP] = "MacBook Pro" // the laptop starts serving mid-session
    const p = t.disc.listServers()
    await t.clock.advance(100)
    expect(await p).toEqual([
      { address: MINI, name: "mac-mini", home: false, current: true },
      { address: LAPTOP, name: "MacBook Pro", home: false, current: false },
    ])
    await t.clock.advance(20000)
    expect(t.states.at(-1).kind).toBe("ready") // the watch still runs, nothing else took the screen
  })

  test("listServers asks again a server that answered earlier off the swept /24", async () => {
    const OTHER = "10.0.0.5"
    const t = setup(servers({ [MINI]: "mac-mini", [OTHER]: "office" }), { last: OTHER })
    t.disc.start()
    await t.clock.advance(100)
    expect(t.states.at(-1).kind).toBe("picker")
    await t.disc.choose(MINI)
    await t.clock.advance(10)
    expect(t.store.get("tuva.tv.last")).toBe(MINI) // OTHER is no longer the last address
    const p = t.disc.listServers()
    await t.clock.advance(100)
    expect((await p).map((s: any) => s.name)).toEqual(["mac-mini", "office"])
  })

  test("the server drops: off names it; Look again sweeps and shows the picker when several answer", async () => {
    const names: Record<string, string> = { [MINI]: "mac-mini", [LAPTOP]: "MacBook Pro" }
    const t = setup(servers(names), { last: MINI })
    t.disc.pin(MINI)
    t.disc.start()
    await t.clock.advance(100)
    expect(t.states.at(-1).kind).toBe("ready")
    delete names[MINI]
    await t.clock.advance(20000)
    expect(t.states.at(-1)).toEqual({ kind: "off", base: `http://${MINI}:4401`, address: MINI, name: "mac-mini" })
    names[MINI] = "mac-mini"
    t.disc.lookAgain()
    await t.clock.advance(100)
    expect(t.states.at(-1).kind).toBe("picker")
    expect(t.states.at(-1).focus).toBe(0) // mac-mini, the last used
  })
})
