// Finding the Library Servers (docs/tv-spec.md §4.2, §4.3; docs/home-server-spec.md §4.2). No DOM, no Tizen: every outside thing is injected, so bun tests
// drive it with a fake fetch and a fake clock. Plain ES2020 in a classic script (the packaged shell has no bundler);
// it publishes `TuvaDiscovery` on the global object.
//
// env = {
//   fetch(url, { signal, headers }) -> Promise<Response-like { status, ok, text() }>,
//   clock: { setTimeout, clearTimeout },
//   storage: { getItem, setItem },            // localStorage
//   localIp(): string | null,                 // webapis.network.getIp() on the TV
//   model(): string,                          // X-Tuva-TV header value
//   onState(state),
//   seedAddress?: string                      // desktop testing: stands in for a stored last address
// }
//
// States passed to onState:
//   { kind: "looking", step: "pinned" | "sweep" | "typed" | "access", detail, found? }
//                                              sweep = the last address and the /24 together (found: names so far);
//                                              pinned = the server chosen by hand before a reload;
//                                              typed = nothing answered; Enter opens the field
//   { kind: "typing", prefix, error? }         the typed field; opened by itself the first time nothing answers. The
//                                              search keeps retrying behind it and a server it finds takes the screen.
//   { kind: "denied", base }                  403 from /api/videos: approve this TV on the Mac
//   { kind: "picker", servers: [{ address, name, home }], focus }   several answered: the user picks (choose(address))
//   { kind: "ready", base, address, name }
//   { kind: "off", base, address, name }      health stopped answering after a success
(function (root) {
  "use strict"

  const PORT = 4401
  const HEALTH_MARK = "TuvaVideos TV Server"
  const STORE_KEY = "tuva.tv.last"
  const PIN_KEY = "tuva.tv.pin" // the server picked by hand (side pane, or the UI's restart): one reload goes straight to it
  const PROBE_TIMEOUT_MS = 2000
  const ACCESS_TIMEOUT_MS = 10000
  const SWEEP_IN_FLIGHT = 32
  const RETRY_MS = 5000
  const DENIED_RETRY_MS = 3000
  const WATCH_MS = 5000
  const WATCH_MISSES = 2
  const PIN_TRIES = 3

  const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

  function isAddress(s) {
    const m = IPV4.exec(s)
    return !!m && m.slice(1).every((o) => Number(o) <= 255)
  }

  /** "192.168.4." from "192.168.4.83", or null. */
  function subnetPrefix(addr) {
    const m = addr ? IPV4.exec(addr) : null
    return m ? `${m[1]}.${m[2]}.${m[3]}.` : null
  }

  /** What the typed field holds -> an address, or null. A bare 1-3 digit number means the last octet in `prefix`. */
  function normalizeTyped(text, prefix) {
    const t = String(text).trim()
    if (/^\d{1,3}$/.test(t) && prefix) return isAddress(prefix + t) ? prefix + t : null
    return isAddress(t) ? t : null
  }

  const baseOf = (addr) => `http://${addr}:${PORT}`

  /** A health body -> { name, home }, or null when it is not a Library Server's. Older servers have no name. */
  function parseHealth(text) {
    const t = String(text)
    if (!t.includes(HEALTH_MARK)) return null
    try {
      const j = JSON.parse(t)
      return { name: typeof j.name === "string" && j.name.trim() ? j.name.trim() : null, home: j.home === true }
    } catch {
      return { name: null, home: false }
    }
  }

  const octets = (a) => a.split(".").map(Number)
  function compareAddr(a, b) {
    const x = octets(a)
    const y = octets(b)
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
  }

  /**
   * The picker's list: one entry per address, the Home Server first, then by name (a server without a name sorts by
   * its address after the named ones), and the focus on the last used one (else the first).
   */
  function orderServers(list, lastAddr) {
    const seen = {}
    const servers = []
    for (const s of list) {
      if (!s || seen[s.address]) continue
      seen[s.address] = true
      servers.push({ address: s.address, name: s.name || null, home: s.home === true })
    }
    servers.sort((a, b) => {
      if (a.home !== b.home) return a.home ? -1 : 1
      if (!a.name !== !b.name) return a.name ? -1 : 1
      if (a.name && b.name) {
        const x = a.name.toLowerCase()
        const y = b.name.toLowerCase()
        if (x !== y) return x < y ? -1 : 1
      }
      return compareAddr(a.address, b.address)
    })
    const i = servers.findIndex((s) => s.address === lastAddr)
    return { servers, focus: i < 0 ? 0 : i }
  }

  function create(env) {
    const clock = env.clock
    let gen = 0 // bumping it cancels every loop of the previous run
    const known = {} // every address that answered health in this run (lost on reload)
    let typing = false
    let autoOpened = false // the typed field opens by itself once per start(), the first time nothing answers
    let current = null

    const emit = (s) => {
      if (typing && s.kind === "looking") return // the typed field owns the screen while the search retries behind it
      if (s.kind !== "typing") typing = false // anything else (approve, ready, off) replaces the field: never stuck on
      current = s
      env.onState(s)
    }
    const typedPrefix = () => subnetPrefix(lastAddress()) || subnetPrefix(safe(env.localIp)) || ""
    function openTyped() {
      typing = true
      emit({ kind: "typing", prefix: typedPrefix() })
    }
    const sleep = (ms) => new Promise((res) => clock.setTimeout(res, ms))

    // Runs fn(signal) with a deadline; the deadline wins even against a fetch that ignores the signal.
    function timed(ms, fn) {
      return new Promise((resolve, reject) => {
        const ctl = typeof AbortController === "function" ? new AbortController() : null
        const t = clock.setTimeout(() => {
          if (ctl) ctl.abort()
          reject(new Error("timeout"))
        }, ms)
        Promise.resolve()
          .then(() => fn(ctl ? ctl.signal : undefined))
          .then(
            (v) => {
              clock.clearTimeout(t)
              resolve(v)
            },
            (e) => {
              clock.clearTimeout(t)
              reject(e)
            },
          )
      })
    }

    /** { address, name, home } when a Library Server answers on addr:4401, else null. */
    async function probeInfo(addr) {
      try {
        return await timed(PROBE_TIMEOUT_MS, async (signal) => {
          const res = await env.fetch(`${baseOf(addr)}/api/health`, { signal })
          if (!res.ok) return null
          const h = parseHealth(await res.text())
          return h ? { address: addr, name: h.name, home: h.home } : null
        })
      } catch {
        return null
      }
    }
    const probe = async (addr) => !!(await probeInfo(addr))

    /** Every address on prefix.1-254 (minus skip) whose health answers, 32 requests in flight. */
    async function sweep(prefix, skip, alive, onFound) {
      const hosts = []
      for (let i = 1; i <= 254; i++) if (!skip.includes(prefix + i)) hosts.push(prefix + i)
      let next = 0
      const worker = async () => {
        while (alive()) {
          const i = next++
          if (i >= hosts.length) return
          const info = await probeInfo(hosts[i])
          if (info && alive()) onFound(info)
        }
      }
      await Promise.all(Array.from({ length: SWEEP_IN_FLIGHT }, worker))
    }

    /**
     * The last address and the sweep of the TV's /24, together, collecting every answer (home-server-spec §4.2).
     * Servers that answered earlier in this run (a typed address on another subnet, say) are asked again too.
     * onStep(names) reports progress. Resolves to the answers in the order they came.
     */
    async function collect(alive, onStep) {
      const last = lastAddress()
      const found = []
      const add = (info) => {
        known[info.address] = true
        if (found.some((f) => f.address === info.address)) return
        found.push(info)
        if (onStep) onStep(found.map((f) => f.name || f.address))
      }
      const ownIp = safe(env.localIp)
      const prefix = subnetPrefix(ownIp) || subnetPrefix(last)
      const jobs = []
      const direct = []
      if (last && isAddress(last)) direct.push(last)
      for (const a in known) if (direct.indexOf(a) < 0 && (!prefix || a.indexOf(prefix) !== 0)) direct.push(a)
      if (onStep && (prefix || direct.length)) onStep([])
      for (const a of direct) jobs.push(probeInfo(a).then((info) => info && alive() && add(info)))
      if (prefix) {
        const skip = direct.slice()
        if (ownIp) skip.push(ownIp)
        jobs.push(sweep(prefix, skip, alive, add))
      }
      await Promise.all(jobs)
      return found
    }
    const sweepDetail = () => {
      const p = subnetPrefix(safe(env.localIp)) || subnetPrefix(lastAddress())
      return p ? `${p}1–254` : ""
    }

    /** "ok" | "denied" | "down": GET /api/videos with this TV's name. */
    async function checkAccess(base) {
      try {
        return await timed(ACCESS_TIMEOUT_MS, async (signal) => {
          const res = await env.fetch(`${base}/api/videos`, { signal, headers: { "X-Tuva-TV": env.model() } })
          if (res.status === 403) return "denied"
          return res.ok ? "ok" : "down"
        })
      } catch {
        return "down"
      }
    }

    function remember(addr) {
      try {
        env.storage.setItem(STORE_KEY, addr)
      } catch {}
    }
    function takePin() {
      try {
        const p = env.storage.getItem(PIN_KEY)
        if (p) env.storage.removeItem(PIN_KEY)
        return p && isAddress(p) ? p : null
      } catch {
        return null
      }
    }
    function lastAddress() {
      try {
        return env.storage.getItem(STORE_KEY) || env.seedAddress || null
      } catch {
        return env.seedAddress || null
      }
    }

    // Server found: keep asking /api/videos until the Mac approves this TV, then watch its health.
    let connected = null // { address, name, home } of the server the UI runs from
    async function connect(info, myGen) {
      const addr = info.address
      const base = baseOf(addr)
      for (;;) {
        emit({ kind: "looking", step: "access", detail: addr, name: info.name })
        const r = await checkAccess(base)
        if (myGen !== gen) return false
        if (r === "ok") {
          remember(addr)
          known[addr] = true
          connected = info
          emit({ kind: "ready", base, address: addr, name: info.name })
          watch(info, base, myGen)
          return true
        }
        if (r === "down") return false
        emit({ kind: "denied", base })
        await sleep(DENIED_RETRY_MS)
        if (myGen !== gen) return false
      }
    }

    // After a success: two health misses in a row (each its own 2 s timeout) is "turned off".
    async function watch(info, base, myGen) {
      let misses = 0
      while (myGen === gen) {
        await sleep(WATCH_MS)
        if (myGen !== gen) return
        misses = (await probe(info.address)) ? 0 : misses + 1
        if (misses >= WATCH_MISSES) {
          if (myGen === gen) emit({ kind: "off", base, address: info.address, name: info.name })
          return
        }
      }
    }

    async function search(myGen, pin) {
      const alive = () => myGen === gen
      if (pin) {
        // Picked by hand before this reload: straight to it, no picker. Gone meanwhile: look for all as usual.
        // A few tries: it answered a moment ago, and a picked server must not lose to whichever answers the sweep.
        emit({ kind: "looking", step: "pinned", detail: pin })
        let info = null
        for (let i = 0; i < PIN_TRIES && !info; i++) {
          if (i) await sleep(RETRY_MS / 5)
          if (!alive()) return
          info = await probeInfo(pin)
        }
        if (!alive()) return
        if (info && (await connect(info, myGen))) return
        if (!alive()) return
      }
      for (;;) {
        const found = await collect(alive, (names) => emit({ kind: "looking", step: "sweep", detail: sweepDetail(), found: names }))
        if (!alive()) return
        if (found.length > 1) {
          const o = orderServers(found, lastAddress())
          emit({ kind: "picker", servers: o.servers, focus: o.focus })
          return // the user picks: choose()
        }
        if (found.length === 1) {
          if (await connect(found[0], myGen)) return
          if (!alive()) return
          // the server stopped answering between health and /api/videos: look again
        } else if (!autoOpened && !typing) {
          // Nothing answered: open the field (and its number pad) at once, so no remote menu is needed to get there.
          autoOpened = true
          openTyped()
        } else {
          emit({ kind: "looking", step: "typed", detail: "" })
        }
        await sleep(RETRY_MS) // keeps retrying behind an open field: a server switched on meanwhile is still found
        if (!alive()) return
      }
    }

    function start() {
      const myGen = ++gen
      typing = false
      autoOpened = false
      connected = null
      search(myGen, takePin())
    }

    return {
      start,
      /** Enter on the looking screen (the first time nothing answers it opens by itself). */
      openTyped,
      /** Back on an empty field. */
      closeTyped() {
        typing = false
        emit({ kind: "looking", step: "typed", detail: "" })
      },
      /** Enter in the field. Returns true when it was an address that answered. */
      async submitTyped(text) {
        const prefix = typedPrefix()
        const addr = normalizeTyped(text, prefix)
        if (!addr) {
          if (typing) emit({ kind: "typing", prefix, error: "That is not an address" })
          return false
        }
        if (!(await probe(addr))) {
          if (typing) emit({ kind: "typing", prefix, error: `Nothing answered at ${addr}` })
          return false
        }
        const myGen = ++gen
        typing = false
        const info = (await probeInfo(addr)) || { address: addr, name: null, home: false }
        if (myGen !== gen) return true
        if (!(await connect(info, myGen)) && myGen === gen) search(myGen)
        return true
      },
      /** Enter on a picker row. */
      async choose(address) {
        const row = current && current.kind === "picker" ? current.servers.find((s) => s.address === address) : null
        const myGen = ++gen
        const info = row || (await probeInfo(address)) || { address, name: null, home: false }
        if (myGen !== gen) return
        if (!(await connect(info, myGen)) && myGen === gen) search(myGen)
      },
      /**
       * The side pane's Server list: a fresh collection, without touching the running session. Each entry says
       * whether it is the server the UI runs from (listed even when its health missed this once).
       */
      async listServers() {
        const found = await collect(() => true)
        if (connected && !found.some((f) => f.address === connected.address)) found.push(connected)
        const o = orderServers(found, connected ? connected.address : lastAddress())
        return o.servers.map((s) => ({ address: s.address, name: s.name, home: s.home, current: !!connected && s.address === connected.address }))
      },
      /** The next start() goes straight to this address (the shell reloads right after). */
      pin(address) {
        try {
          if (isAddress(address)) env.storage.setItem(PIN_KEY, address)
        } catch {}
      },
      /** The server the UI runs from, or null. */
      connected: () => connected,
      /** Look again on "‹name› stopped answering": sweep and picker. */
      lookAgain: start,
      stop() {
        gen++
      },
      state: () => current,
    }
  }

  function safe(fn) {
    try {
      return fn()
    } catch {
      return null
    }
  }

  root.TuvaDiscovery = {
    create,
    isAddress,
    subnetPrefix,
    normalizeTyped,
    parseHealth,
    orderServers,
    constants: { PORT, HEALTH_MARK, PROBE_TIMEOUT_MS, SWEEP_IN_FLIGHT, RETRY_MS, DENIED_RETRY_MS, WATCH_MS, STORE_KEY, PIN_KEY },
  }
})(typeof globalThis !== "undefined" ? globalThis : window)
