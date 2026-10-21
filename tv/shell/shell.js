// The TV shell (docs/tv-spec.md §4): registers the remote keys, finds the TV Server (discovery.js), draws the
// offline states, then loads /tv.css and /tv.js live from the server. Plain ES2020; also runs in a desktop browser
// (no `tizen`/`webapis` there; add ?addr=<ip> to stand in for the stored address).
(function () {
  "use strict"

  const D = window.TuvaDiscovery
  const K = window.TuvaKeys
  const el = document.getElementById("shell")
  const params = new URLSearchParams(location.search)
  const tizenApi = typeof window.tizen !== "undefined" ? window.tizen : null
  const webapi = typeof window.webapis !== "undefined" ? window.webapis : null

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

  function localIp() {
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
    last: (s) => `Trying the last address, ${esc(s.detail)}`,
    sweep: (s) => `Looking across your network, ${esc(s.detail)}`,
    typed: () => "Nothing answered yet. Is the TV Server switched on?",
    access: (s) => `Found the Mac at ${esc(s.detail)}, asking for the library`,
  }

  function render(s) {
    el.hidden = false
    el.className = s.kind === "off" ? "over" : ""
    if (s.kind === "looking") {
      el.innerHTML =
        `<h1>Looking for TuvaVideos on the Mac…</h1><div class="step">${STEP_TEXT[s.step](s)}</div>` +
        `<div class="hint">${key("Enter")} type the Mac's address &nbsp; ${key("Back")} exit</div>`
    } else if (s.kind === "typing") {
      el.innerHTML =
        `<h1>The Mac's address</h1><div class="field">${esc(typed)}<i></i></div>` +
        (s.error ? `<div class="err">${esc(s.error)}</div>` : `<div class="step">Port 4401 is added for you</div>`) +
        padHtml() +
        `<div class="hint">${key("◀ ▲ ▼ ▶")} choose &nbsp; ${key("Enter")} press &nbsp; ${key("Back")} delete</div>`
    } else if (s.kind === "denied") {
      el.innerHTML =
        `<h1>Approve this TV on the Mac</h1><div class="step">Click Allow in the TuvaVideos window on the Mac.</div>` +
        `<div class="hint">Trying again every 3 seconds &nbsp; ${key("Back")} exit</div>`
    } else if (s.kind === "off") {
      el.innerHTML =
        `<h1>TV Server turned off</h1><div class="step">Switch it back on in TuvaVideos on the Mac.</div>` +
        `<div class="hint">${key("Enter")} look again &nbsp; ${key("Back")} exit</div>`
    }
  }

  // ---- loading the UI from the server ----------------------------------------------------------------------------

  let loaded = false
  function loadUi(base) {
    if (loaded) return
    loaded = true
    window.tuvaTv = {
      base,
      keys: K,
      exit: exitApp,
      // The UI calls this when a request comes back 403 or the stream dies: the shell reloads and finds its way again.
      restart: () => location.reload(),
    }
    const css = document.createElement("link")
    css.rel = "stylesheet"
    css.href = base + "/tv.css"
    document.head.appendChild(css)
    const js = document.createElement("script")
    js.src = base + "/tv.js"
    js.onerror = () => render({ kind: "off", base })
    document.body.appendChild(js)
    el.hidden = true
  }

  let prevKind = null
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
  disc.start()
})()
