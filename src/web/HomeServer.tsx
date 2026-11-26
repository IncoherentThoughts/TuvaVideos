// This Mac's Home Server (docs/home-server-spec.md §4.1, §5.1): the top bar's connection state ("Home · mac-mini",
// "Home · unreachable") and its menu, which holds the Home Server field with Test, the "This Mac is the Home Server"
// toggle, and the home index's refresh button. The index is fetched at connect (this tab opening, a saved field), on
// window focus once it is older than 10 minutes, and from the button; never on a timer.
import { useEffect, useRef, useState } from "preact/hooks";
import type { HomeStatusDto, HomeTestDto } from "../shared/types";
import { homeLabel } from "../shared/homeIndex";
import { api, apiError, loadVideos } from "./data";

/** What the grid shows depends on these: a change reloads the Videos. */
const gridKey = (s: HomeStatusDto | null) => (s ? `${s.connected}|${s.index?.at ?? ""}|${s.base ?? ""}` : "");

export function testText(t: HomeTestDto): string {
  if (!t.ok) return t.error;
  return [t.name ?? "unnamed", t.version && `version ${t.version}`, t.drive === "mounted" ? "drive connected" : "drive not connected", t.home && "set as the Home Server there"].filter(Boolean).join(" · ");
}

export function HomeServer() {
  const [s, setS] = useState<HomeStatusDto | null>(null);
  const [open, setOpen] = useState(false);
  const [field, setField] = useState("");
  const [test, setTest] = useState<HomeTestDto | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useRef("");

  const take = (next: HomeStatusDto | null) => {
    setS(next);
    const k = gridKey(next);
    if (k !== shown.current) {
      const first = shown.current === "";
      shown.current = k;
      if (!first || next?.connected) void loadVideos();
    }
  };

  useEffect(() => {
    let alive = true;
    // at connect: this tab opening asks for a fresh check and index
    api
      .home()
      .then((h) => {
        if (!alive || !h) return;
        setField(h.address ?? "");
        take(h);
        if (h.configured) return api.refreshHome(true).then((r) => alive && take(r));
      })
      .catch(() => {});
    const onFocus = () => void api.refreshHome(false).then((r) => alive && take(r), () => {});
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!s) return null;
  const run = async (f: () => Promise<HomeStatusDto>) => {
    setBusy(true);
    try {
      take(await f());
    } catch (e) {
      alert(`Home Server: ${apiError(e)}`);
    }
    setBusy(false);
  };
  const label = homeLabel(s) ?? "Home Server";
  return (
    <span class="home-status">
      <button class={`btn small${s.configured || s.self ? "" : " dim"}`} aria-haspopup="menu" aria-expanded={open} title={s.error ?? (s.configured ? s.base ?? undefined : "Set this Mac's Home Server")} onClick={() => setOpen(!open)}>
        {(s.configured || s.self) && <span class={`dot${s.connected || s.self ? " on" : ""}`} />}
        {label}
      </button>
      {open && (
        <div class="menu" role="menu">
          <div class="tvhd">Home Server</div>
          <label class="row">
            <input type="checkbox" checked={s.self} disabled={busy} onChange={(e) => void run(() => api.setHome({ self: e.currentTarget.checked }))} /> This Mac is the Home Server
          </label>
          {s.self ? (
            <div class="tvtip">Your other Macs stream from this one. It never connects to itself; turn the Library Server on (Serve on launch keeps it on).</div>
          ) : (
            <>
              <input
                type="text"
                placeholder="Tailscale name or address (mac-mini)"
                value={field}
                disabled={busy || s.override}
                onInput={(e) => (setField(e.currentTarget.value), setTest(null))}
                onKeyDown={(e) => e.key === "Enter" && void run(() => api.setHome({ address: field }))}
              />
              <div class="row">
                <button class="btn small" disabled={busy || !field.trim()} onClick={async () => (setBusy(true), setTest(await api.testHome(field).catch((e) => ({ ok: false as const, base: null, error: apiError(e) }))), setBusy(false))}>
                  Test
                </button>
                <button class="btn small primary" disabled={busy || s.override || field.trim() === (s.address ?? "")} onClick={() => void run(() => api.setHome({ address: field }))}>
                  Save
                </button>
                {s.address && (
                  <button class="linkbtn" disabled={busy || s.override} onClick={() => (setField(""), void run(() => api.setHome({ address: null })))}>
                    Clear
                  </button>
                )}
              </div>
              {test && <div class={test.ok ? "tvtip" : "tvtip err"}>{testText(test)}</div>}
              {s.override && <div class="tvtip">Set by TUVA_HOME_SERVER for this run: {s.base}</div>}
              {s.configured && (
                <>
                  <div class={s.connected ? "tvtip" : "tvtip err"}>
                    {s.connected ? `Connected to ${s.server ?? s.base}${s.drive === "unmounted" ? " (its drive is not connected)" : ""}` : `Unreachable: ${s.error ?? "no answer"}`}
                  </div>
                  <div class="row">
                    <span class="dim">{s.index ? `${s.index.videos} Videos there, ${s.index.homeOnly} not on this Mac · ${new Date(s.index.at).toLocaleTimeString()}` : "No home index yet"}</span>
                    <button class="btn small" disabled={busy} onClick={() => void run(() => api.refreshHome(true))}>
                      Refresh
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </span>
  );
}
