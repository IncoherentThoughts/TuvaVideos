// The TV button of the top bar (docs/tv-spec.md 2.4): turns the TV Server on, shows what it is doing, raises the
// "Allow TV at ‹IP›?" prompt inline, and holds the menu (Turn off, Approved TVs with Remove).
import { useEffect, useRef, useState } from "preact/hooks";
import type { TvStateDto } from "../shared/types";
import { api, apiError } from "./data";

/** The indicator's text: one of the four states of the spec's table. */
export function tvLabel(s: TvStateDto): string {
  if (!s.on) return "TV";
  if (s.playing) return `TV · ${s.playing.model ?? s.playing.ip} · ${s.playing.title ? `playing ${s.playing.title}` : "browsing"}`;
  const addr = s.addresses[0];
  return `TV on · ${addr ?? "no network"}${addr ? `:${s.port}` : ""}`;
}

/** `192.168.4.83` -> { head: "192.168.4.", last: "83" }: the last number is what the TV's number pad needs (its field is pre-filled with the TV's subnet). */
export function splitAddress(a: string): { head: string; last: string } {
  const i = a.lastIndexOf(".");
  return i < 0 ? { head: "", last: a } : { head: a.slice(0, i + 1), last: a.slice(i + 1) };
}

export function TvButton() {
  const [tv, setTv] = useState<TvStateDto | null>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const on = tv?.on ?? false;

  // Poll GET /api/tv: every 2 s while the TV Server is on (the prompt must appear quickly), every 5 s while off.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await api.tv();
        if (alive) setTv(s);
      } catch {}
      if (alive) timer = setTimeout(tick, on ? 2000 : 5000);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [on]);

  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setMenu(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);

  if (!tv) return null;

  const act = async (fn: () => Promise<TvStateDto>): Promise<void> => {
    setBusy(true);
    try {
      setTv(await fn());
    } catch (e) {
      alert(`TV Server: ${apiError(e)}`);
    }
    setBusy(false);
  };
  const first = tv.pending[0];

  if (!tv.available) {
    return (
      <button class="btn" disabled title="A passive server never starts the TV Server">
        TV
      </button>
    );
  }

  return (
    <span class="tvwrap" ref={box}>
      {on && first ? (
        <span class="tvprompt" role="alert" title={first.model ?? undefined}>
          Allow TV at {first.ip}?{tv.pending.length > 1 ? ` (+${tv.pending.length - 1})` : ""}
          <button class="btn small primary" disabled={busy} onClick={() => act(() => api.tvApprove(first.ip))}>
            Allow
          </button>
          <button class="btn small" disabled={busy} onClick={() => act(() => api.tvDeny(first.ip))}>
            Deny
          </button>
        </span>
      ) : (
        <button
          class={`btn tv${on ? " on" : ""}${tv.playing ? " live" : ""}`}
          disabled={busy}
          title={on ? "TV Server: menu" : "Turn the TV Server on (the TV app reaches this Mac over the home network)"}
          aria-haspopup={on ? "menu" : undefined}
          aria-expanded={on ? menu : undefined}
          onClick={() => (on ? setMenu(!menu) : act(api.tvOn).then(() => setMenu(true)))}
        >
          {tvLabel(tv)}
        </button>
      )}
      {on && first && (
        <button class="btn small" aria-label="TV menu" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          ▾
        </button>
      )}
      {on && menu && (
        <div class="menu tvmenu" role="menu">
          <button role="menuitem" disabled={busy} onClick={() => { setMenu(false); void act(api.tvOff); }}>
            Turn off
          </button>
          <div class="tvhd">This Mac, for the TV</div>
          {tv.addresses.length === 0 && <div class="tvnone">no network address</div>}
          {tv.addresses.map((a) => {
            const { head, last } = splitAddress(a);
            return (
              <div class="tvaddr" key={a}>
                {head}
                <b>{last}</b>
                <span class="dim">:{tv.port}</span>
              </div>
            );
          })}
          {tv.addresses[0] && (
            <div class="tvtip">
              The TV app finds this Mac by itself. If it asks for the address, press <b>{splitAddress(tv.addresses[0]).last}</b> on its number pad and Connect (the whole
              address if the TV is on another network), then Allow it here.
            </div>
          )}
          {tv.pending.length > 0 && <div class="tvhd">Waiting for approval</div>}
          {tv.pending.map((t) => (
            <div class="tvrow" key={`p-${t.ip}`}>
              <span class="tvname" title={t.model ?? undefined}>
                {t.model ? t.model.slice(0, 32) : "TV"} <span class="dim">{t.ip}</span>
              </span>
              <span>
                <button class="btn small primary" disabled={busy} onClick={() => act(() => api.tvApprove(t.ip))}>
                  Allow
                </button>{" "}
                <button class="btn small" disabled={busy} onClick={() => act(() => api.tvDeny(t.ip))}>
                  Deny
                </button>
              </span>
            </div>
          ))}
          <div class="tvhd">Approved TVs</div>
          {tv.approved.length === 0 && <div class="tvnone">none yet</div>}
          {tv.approved.map((t) => (
            <div class="tvrow" key={t.ip}>
              <span class="tvname" title={t.lastSeenAt ? `last seen ${t.lastSeenAt}` : "not seen yet"}>
                {t.model ? t.model.slice(0, 32) : "TV"} <span class="dim">{t.ip}</span>
              </span>
              <button class="linkbtn" disabled={busy} onClick={() => act(() => api.tvRemove(t.ip))} title="Remove: its next request asks again">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
