// The TV shell (docs/tv-spec.md §4): registers the remote keys, finds the Library Servers (discovery.js), lets the
// user pick one when several answer, draws the offline states, then loads /tv.css and /tv.js live from the server. Plain ES2020; runs on Samsung (Tizen), on LG
// (webOS, packaged with appinfo.json) and in a desktop browser (neither there; add ?addr=<ip> to stand in for the
// stored address and ?ip=<ip> for the TV's own address).
(function () {
  "use strict"

  const D = window.TuvaDiscovery
  const K = window.TuvaKeys
  const el = document.getElementById("shell")
  const params = new URLSearchParams(location.search)
  const tizenApi = typeof window.tizen !== "undefined" ? window.tizen : null
  const webapi = typeof window.webapis !== "undefined" ? window.webapis : null
  // webOS: the native bridge its own webOSTV.js wraps; luna calls go through it.
  const palm = typeof window.PalmServiceBridge !== "undefined" ? window.PalmServiceBridge : null

  function exitApp() {
    try {
      tizenApi.application.getCurrentApplication().exit()
    } catch {
      try {
        window.close()
      } catch {}
    }
  }

  function registerKeys() {
    const tv = tizenApi && tizenApi.tvinputdevice
    if (!tv) return
    const names = K.table.filter((k) => k.registered).map((k) => k.name)
    try {
      tv.registerKeyBatch(names)
    } catch {
      for (const n of names) {
        try {
          tv.registerKey(n)
        } catch {} // one unknown name must not cost the others
      }
    }
  }

  function model() {
    try {
      const m = webapi.productinfo.getModel()
      if (m) return String(m)
    } catch {}
    return navigator.userAgent.replace(/[^\x20-\x7e]/g, "")
  }

  // webOS has no sync IP call: ask the connection manager once, and start looking when it answers (or after 1.5 s).
  let webosIp = null
  function askWebosIp(then) {
    if (!palm) return then()
    let started = false
    const go = () => {
      if (started) return
      started = true
      then()
    }
    window.setTimeout(go, 1500)
    try {
      const bridge = new palm()
      bridge.onservicecallback = (msg) => {
        try {
          const r = JSON.parse(msg)
          const net = (r.wired && r.wired.state === "connected" && r.wired) || (r.wifi && r.wifi.state === "connected" && r.wifi)
          if (net && net.ipAddress) webosIp = net.ipAddress
        } catch {}
        go()
      }
      bridge.call("luna://com.palm.connectionmanager/getStatus", "{}")
      window.__tuvaBridge = bridge // keep it alive until it answers
    } catch {
      go()
    }
  }

  function localIp() {
    if (webosIp) return webosIp
    if (params.get("ip")) return params.get("ip") // desktop testing: stands in for the TV's own address (its /24 is swept)
    try {
      return webapi.network.getIp() || null
    } catch {
      return null
    }
  }

  // ---- screens -------------------------------------------------------------------------------------------------

  let typed = ""
  // The on-screen number pad of the typing screen: the remote's arrows and Enter type the address, so a remote whose
  // digits hide behind a 123 panel never needs it. Three columns of keys, then Connect across the bottom row.
  const PAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫", "Connect"]
  let pad = 0
  function padMove(dir) {
    const connect = PAD.length - 1
    if (pad === connect) {
      if (dir === "up") pad = 10
      return
    }
    const r = Math.floor(pad / 3)
    const c = pad % 3
    if (dir === "left" && c > 0) pad--
    else if (dir === "right" && c < 2) pad++
    else if (dir === "up" && r > 0) pad -= 3
    else if (dir === "down") pad = r < 3 ? pad + 3 : connect
  }
  function padHtml() {
    return (
      `<div class="pad">` +
      PAD.map((k, i) => `<span class="${i === pad ? "f" : ""}${k === "Connect" ? " go" : ""}">${k}</span>`).join("") +
      `</div>`
    )
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
  const key = (label) => `<b>${label}</b>`

  const STEP_TEXT = {
    pinned: (s) => `Trying ${esc(s.detail)}`,
    sweep: (s) =>
      s.found && s.found.length
        ? `Found ${esc(s.found.join(", "))}, checking for others on ${esc(s.detail)}`
        : `Looking across your network${s.detail ? `, ${esc(s.detail)}` : ""}`,
    typed: () => "Nothing answered yet. Is the Library Server switched on?",
    access: (s) => `Found ${s.name ? esc(s.name) : "the Mac"} at ${esc(s.detail)}, asking for the library`,
  }
  const serverName = (s) => (s && s.name) || "The Library Server"

  // The server picker (home-server-spec §4.2): several answered at startup. Up/Down choose, Enter connects.
  let pick = 0
  function pickerHtml(s) {
    const rows = s.servers
      .map(
        (v, i) =>
          `<div class="row${i === pick ? " f" : ""}"><span class="nm">${esc(v.name || v.address)}</span>` +
          (v.home ? `<span class="tag">Home Server</span>` : "") +
          `<span class="ad">${esc(v.address)}</span></div>`,
      )
      .join("")
    return (
      `<h1>Choose a Library Server</h1><div class="step">More than one Mac is serving TuvaVideos on this network.</div>` +
      `<div class="servers">${rows}</div>` +
      `<div class="hint">${key("▲ ▼")} choose &nbsp; ${key("Enter")} connect &nbsp; ${key("Back")} exit</div>`
    )
  }

  // The TV UI needs Chromium 94: its script uses ?? , ?. and ??= (85) and its stylesheet inset and aspect-ratio (88);
  // config.xml requires Tizen 7.0 (M94) to match, see the README.
  const MIN_CHROME = 94
  function chromeMajor() {
    const m = /Chrome\/(\d+)/.exec(navigator.userAgent)
    return m ? Number(m[1]) : null
  }

  function render(s) {
    el.hidden = false
    el.className = s.kind === "off" ? "over" : ""
    if (s.kind === "looking") {
      el.innerHTML =
        `<h1>Looking for TuvaVideos on the Mac…</h1><div class="step">${STEP_TEXT[s.step](s)}</div>` +
        `<div class="hint">${key("Enter")} type the Mac's address &nbsp; ${key("Back")} exit</div>`
    } else if (s.kind === "typing") {
      const where = s.prefix ? "The TV button on the Mac shows its address: type its last number" : "The TV button on the Mac shows its address"
      el.innerHTML =
        `<h1>The Mac's address</h1><div class="field">${esc(typed)}<i></i></div>` +
        (s.error ? `<div class="err">${esc(s.error)}</div>` : `<div class="step">${where}. Port 4401 is added for you.</div>`) +
        padHtml() +
        `<div class="hint">${key("◀ ▲ ▼ ▶")} choose &nbsp; ${key("Enter")} press &nbsp; ${key("Back")} delete &nbsp; still looking meanwhile</div>`
    } else if (s.kind === "denied") {
      el.innerHTML =
        `<h1>Approve this TV on the Mac</h1><div class="step">Click Allow in the TuvaVideos window on the Mac.</div>` +
        `<div class="hint">Trying again every 3 seconds &nbsp; ${key("Back")} exit</div>`
    } else if (s.kind === "picker") {
      el.innerHTML = pickerHtml(s)
    } else if (s.kind === "off") {
      el.innerHTML =
        `<h1>${esc(serverName(s))} stopped answering</h1><div class="step">Switch the Library Server back on in TuvaVideos on the Mac, or look for another one.</div>` +
        `<div class="hint">${key("Enter")} look again &nbsp; ${key("Back")} exit</div>`
    } else if (s.kind === "starting") {
      el.innerHTML = `<h1>Starting TuvaVideos…</h1><div class="step">Loading the app from ${esc(s.base)}</div><div class="hint">${key("Back")} exit</div>`
    } else if (s.kind === "failed") {
      const v = chromeMajor()
      const old =
        v != null && v < MIN_CHROME
          ? `<div class="step">This TV's browser is Chrome ${v}; TuvaVideos needs Chrome ${MIN_CHROME} or newer (Samsung 2023 / Tizen 7.0, LG webOS 23, or later).</div>`
          : ""
      el.innerHTML =
        `<h1>${esc(s.title)}</h1><div class="step">${esc(s.detail)}</div>${old}` +
        `<div class="hint">${key("Enter")} try again &nbsp; ${key("Back")} exit</div>`
    }
  }

  // ---- loading the UI from the server ----------------------------------------------------------------------------
  // The shell stays up ("Starting…") until the UI has run: /tv.js loaded, ran without throwing and drew into #tv (or
  // called tuvaTv.ready()). A load error, a parse or boot error, or nothing after BOOT_TIMEOUT_MS shows "failed"
  // with Enter to try again and Back to exit, instead of a black screen whose keys go nowhere.

  const BOOT_TIMEOUT_MS = 20000
  let loaded = false
  let uiUp = false
  let failure = null
  let bootTimer = null
  let bootPoll = null

  function uiStarted() {
    if (uiUp || failure) return
    uiUp = true
    window.clearTimeout(bootTimer)
    window.clearInterval(bootPoll)
    el.hidden = true
  }
  function bootFailed(title, detail) {
    if (uiUp || failure) return
    window.clearTimeout(bootTimer)
    window.clearInterval(bootPoll)
    failure = { kind: "failed", title, detail }
    render(failure)
  }
  const drewSomething = () => {
    const tv = document.getElementById("tv")
    return !!tv && tv.childNodes.length > 0
  }

  function loadUi(base) {
    if (loaded) return
    loaded = true
    window.tuvaTv = {
      base,
      keys: K,
      exit: exitApp,
      // The UI calls this when a request comes back 403 or the stream dies: the shell reloads and finds its way
      // again, to the same server first (no picker unless it is gone).
      restart: () => {
        const c = disc.connected()
        if (c) disc.pin(c.address)
        location.reload()
      },
      // The server the UI runs from, for the side pane's "Server: ‹name›" (home-server-spec §4.2).
      server: (() => {
        const c = disc.connected()
        return c ? { address: c.address, name: c.name || c.address, home: !!c.home } : null
      })(),
      // A fresh sweep for the side pane: [{ address, name, home, current }].
      servers: () =>
        disc.listServers().then((list) => list.map((v) => ({ address: v.address, name: v.name || v.address, home: v.home, current: v.current }))),
      // Switch by hand: the UI has written Resume already; the shell reloads and loads the UI from that server.
      switchTo: (address) => {
        disc.pin(address)
        location.reload()
      },
      // The UI calls this once it has drawn its first screen.
      ready: uiStarted,
    }
    render({ kind: "starting", base })
    // A parse error or a throw while /tv.js boots arrives here (a cross-origin script may only say "Script error.").
    window.addEventListener("error", (e) => {
      if (uiUp || failure) return
      const msg = (e && e.message) || ""
      const where = e.filename ? ` (${String(e.filename).replace(/^.*\//, "")}${e.lineno ? `:${e.lineno}` : ""})` : ""
      // A script from another origin only reports "Script error.": say what that means instead.
      const detail = !msg || /^Script error\.?$/i.test(msg) ? "Its script from the Mac failed to run on this TV." : `${msg}${where}`
      bootFailed("The TV app could not start", detail)
    })
    bootTimer = window.setTimeout(() => bootFailed("The TV app did not start", `Nothing was drawn ${BOOT_TIMEOUT_MS / 1000} s after loading ${base}/tv.js`), BOOT_TIMEOUT_MS)
    const css = document.createElement("link")
    css.rel = "stylesheet"
    css.href = base + "/tv.css"
    document.head.appendChild(css)
    const js = document.createElement("script")
    js.src = base + "/tv.js"
    js.onerror = () => bootFailed("Could not load the TV app", `Nothing came back for ${base}/tv.js`)
    js.onload = () => {
      if (failure) return
      if (drewSomething()) return uiStarted()
      bootPoll = window.setInterval(() => drewSomething() && uiStarted(), 250)
    }
    document.body.appendChild(js)
  }

  let prevKind = null
  let prevPicker = null
  const disc = D.create({
    fetch: (url, init) => window.fetch(url, init),
    clock: { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) },
    storage: window.localStorage,
    localIp,
    model,
    seedAddress: params.get("addr") || undefined,
    onState(s) {
      const entering = s.kind === "typing" && prevKind !== "typing"
      prevKind = s.kind
      if (s.kind === "ready") return loadUi(s.base)
      if (s.kind === "picker" && prevPicker !== s) {
        prevPicker = s
        pick = s.focus || 0
      }
      if (entering) {
        typed = s.prefix || ""
        pad = 0
      }
      render(s)
    },
  })

  // ---- keys ----------------------------------------------------------------------------------------------------

  document.addEventListener(
    "keydown",
    (e) => {
      const s = disc.state()
      if (!s || (s.kind === "ready" && el.hidden)) return // the loaded UI owns the keys
      const name = K.keyName(e.keyCode) || e.key
      const eat = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      if (s.kind === "ready") {
        // "Starting…" or "failed": the shell is on screen, so it owns every key; the UI under it gets none.
        eat()
        if (name === "Back" || name === "Exit" || e.key === "Backspace") exitApp()
        else if (name === "Enter" && failure) location.reload()
        return
      }
      if (s.kind === "typing") {
        eat()
        const del = () => {
          if (typed) typed = typed.slice(0, -1)
          else disc.closeTyped()
        }
        const arrow = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[name]
        if (/^[0-9]$/.test(name)) typed += name
        else if (e.key === "." || e.keyCode === 190 || e.keyCode === 110) typed += "."
        else if (arrow) padMove(arrow)
        else if (name === "Back" || e.key === "Backspace") del()
        else if (name === "Enter") {
          const k = PAD[pad]
          if (k === "Connect") return disc.submitTyped(typed)
          if (k === "⌫") del()
          else typed += k
        }
        if (disc.state() && disc.state().kind === "typing") render({ kind: "typing", prefix: s.prefix })
        return
      }
      if (s.kind === "picker") {
        eat()
        if (name === "Back" || name === "Exit" || e.key === "Backspace") return exitApp()
        if (name === "ArrowUp" && pick > 0) pick--
        else if (name === "ArrowDown" && pick < s.servers.length - 1) pick++
        else if (name === "Enter") return disc.choose(s.servers[pick].address)
        render(s)
        return
      }
      if (name === "Back" || name === "Exit") {
        eat()
        exitApp()
      } else if (name === "Enter") {
        eat()
        if (s.kind === "looking") disc.openTyped()
        else if (s.kind === "off") location.reload()
      }
    },
    true,
  )

  registerKeys()
  askWebosIp(() => disc.start())
})()
