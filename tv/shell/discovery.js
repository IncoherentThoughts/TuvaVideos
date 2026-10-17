// Finding the TV Server (docs/tv-spec.md §4.2, §4.3). No DOM, no Tizen: every outside thing is injected, so bun tests
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
//   { kind: "looking", step: "last" | "sweep" | "typed" | "access", detail }   typed = nothing answered; Enter opens the field
//   { kind: "typing", prefix, error? }
//   { kind: "denied", base }                  403 from /api/videos: approve this TV on the Mac
//   { kind: "ready", base }
//   { kind: "off", base }                     health stopped answering after a success
(function (root) {
  "use strict"

  const PORT = 4401
  const HEALTH_MARK = "TuvaVideos TV Server"
  const STORE_KEY = "tuva.tv.last"
  const PROBE_TIMEOUT_MS = 2000
  const ACCESS_TIMEOUT_MS = 10000
  const SWEEP_IN_FLIGHT = 32
  const RETRY_MS = 5000
  const DENIED_RETRY_MS = 3000
  const WATCH_MS = 5000
  const WATCH_MISSES = 2

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

  function create(env) {
    const clock = env.clock
    let gen = 0 // bumping it cancels every loop of the previous run
    let typing = false
    let current = null

    const emit = (s) => {
      if (typing && s.kind === "looking") return // the typed field owns the screen
      current = s
      env.onState(s)
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

    /** Does a TuvaVideos TV Server answer on addr:4401? */
    async function probe(addr) {
      try {
        return await timed(PROBE_TIMEOUT_MS, async (signal) => {
          const res = await env.fetch(`${baseOf(addr)}/api/health`, { signal })
          if (!res.ok) return false
          return String(await res.text()).includes(HEALTH_MARK)
        })
      } catch {
        return false
      }
    }

    /** First address on prefix.1-254 whose health answers, 32 requests in flight. */
    async function sweep(prefix, skip, myGen) {
      const hosts = []
      for (let i = 1; i <= 254; i++) if (!skip.includes(prefix + i)) hosts.push(prefix + i)
      let next = 0
      let found = null
      const worker = async () => {
        while (found === null && myGen === gen) {
          const i = next++
          if (i >= hosts.length) return
          if (await probe(hosts[i])) found = found || hosts[i]
        }
      }
      await Promise.all(Array.from({ length: SWEEP_IN_FLIGHT }, worker))
      return found
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
    function lastAddress() {
      try {
        return env.storage.getItem(STORE_KEY) || env.seedAddress || null
      } catch {
        return env.seedAddress || null
      }
    }

    // Server found at addr: keep asking /api/videos until the Mac approves this TV, then watch its health.
    async function connect(addr, myGen) {
      const base = baseOf(addr)
      for (;;) {
        emit({ kind: "looking", step: "access", detail: addr })
        const r = await checkAccess(base)
        if (myGen !== gen) return false
        if (r === "ok") {
          remember(addr)
          emit({ kind: "ready", base })
          watch(addr, base, myGen)
          return true
        }
        if (r === "down") return false
        emit({ kind: "denied", base })
        await sleep(DENIED_RETRY_MS)
        if (myGen !== gen) return false
      }
    }

    // After a success: two health misses in a row (each its own 2 s timeout) is "turned off".
    async function watch(addr, base, myGen) {
      let misses = 0
      while (myGen === gen) {
        await sleep(WATCH_MS)
        if (myGen !== gen) return
        misses = (await probe(addr)) ? 0 : misses + 1
        if (misses >= WATCH_MISSES) {
          if (myGen === gen) emit({ kind: "off", base })
          return
        }
      }
    }

    async function search(myGen) {
      for (;;) {
        const last = lastAddress()
        const tried = []
        let addr = null
        if (last && isAddress(last)) {
          emit({ kind: "looking", step: "last", detail: last })
          tried.push(last)
          if (await probe(last)) addr = last
          if (myGen !== gen) return
        }
        if (!addr) {
          let ownIp = null
          try {
            ownIp = env.localIp()
          } catch {}
          const prefix = subnetPrefix(ownIp) || subnetPrefix(last)
          if (prefix) {
            emit({ kind: "looking", step: "sweep", detail: `${prefix}1–254` })
            addr = await sweep(prefix, ownIp ? tried.concat(ownIp) : tried, myGen)
            if (myGen !== gen) return
          }
        }
        if (addr) {
          if (await connect(addr, myGen)) return
          if (myGen !== gen) return
          // the server stopped answering between health and /api/videos: look again
        } else {
          emit({ kind: "looking", step: "typed", detail: "" })
        }
        await sleep(RETRY_MS)
        while (typing && myGen === gen) await sleep(RETRY_MS) // the typed field holds the retries
        if (myGen !== gen) return
      }
    }

    function start() {
      const myGen = ++gen
      typing = false
      search(myGen)
    }

    return {
      start,
      /** Enter on the looking screen. */
      openTyped() {
        typing = true
        emit({ kind: "typing", prefix: subnetPrefix(lastAddress()) || subnetPrefix(safe(env.localIp)) || "" })
      },
      /** Back on an empty field. */
      closeTyped() {
        typing = false
        emit({ kind: "looking", step: "typed", detail: "" })
      },
      /** Enter in the field. Returns true when it was an address that answered. */
      async submitTyped(text) {
        const prefix = subnetPrefix(lastAddress()) || subnetPrefix(safe(env.localIp)) || ""
        const addr = normalizeTyped(text, prefix)
        if (!addr) {
          emit({ kind: "typing", prefix, error: "That is not an address" })
          return false
        }
        if (!(await probe(addr))) {
          if (typing) emit({ kind: "typing", prefix, error: `Nothing answered at ${addr}` })
          return false
        }
        const myGen = ++gen
        typing = false
        if (!(await connect(addr, myGen)) && myGen === gen) search(myGen)
        return true
      },
      /** Enter on "TV Server turned off". */
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
    constants: { PORT, HEALTH_MARK, PROBE_TIMEOUT_MS, SWEEP_IN_FLIGHT, RETRY_MS, DENIED_RETRY_MS, WATCH_MS, STORE_KEY },
  }
})(typeof globalThis !== "undefined" ? globalThis : window)
