// The Studio bar (spec 7.4): a slim bar under the Video while Music.app plays a Studio track of the Song. It shows track,
// album, position / duration and a scrubbable progress bar; lists each Track of the Song with its match state; and holds
// the miss UI (a search box over the Music.app dump: "match this Track" or "add to Song").
// The Player owns the keys and pauses the Video; this component owns the Music.app session and the polling.
import { useEffect, useRef, useState } from "preact/hooks";
import { AB_OFF, abLoopTarget, abToggle, fmtClock, type AbLoop } from "../shared/playerMath";
import { SeekThrottle } from "../shared/seekThrottle";
import { clampStudioSeek, type DumpHitDto, type SongStudioDto, type StudioEntryDto, type StudioStateDto } from "../shared/studio";
import { api, apiError } from "./data";

export const REFUSED = "Music.app refused — check System Settings › Automation";

/** What the Player can ask of a mounted bar. */
export interface StudioCtl {
  /** A retargeted key: toggle pause, seek by seconds, or the A-B loop. */
  key(op: "toggle" | "loop" | { seek: number }): void;
  /** Stops Music.app if our track is playing there. */
  stop(): Promise<void>;
}

interface Props {
  songId: string;
  /** The Song's Studio tracks as the Player already fetched them to choose the Song. */
  initial: SongStudioDto;
  say(text: string, ms?: number): void;
  /** Studio playback is over (the bar goes away, the Video stays paused). */
  onClose(): void;
  ctl: { current: StudioCtl | null };
}

const POLL_SLOW = 1000;
const POLL_FAST = 250;

/** The default track `t` starts: `studio_last`, else the first with a match (spec 7.3). */
export function defaultTrack(d: SongStudioDto): StudioEntryDto | null {
  const last = d.lastId != null ? d.tracks.find((t) => t.id === d.lastId && t.state !== "missing") : null;
  return last ?? d.tracks.find((t) => t.state !== "missing") ?? null;
}

function Scrub({ pos, dur, ab, onSeek }: { pos: number; dur: number | null; ab: AbLoop; onSeek(t: number, throttled: boolean): void }) {
  const bar = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const dragging = useRef(false);
  const moved = useRef(false);
  const d = dur && dur > 0 ? dur : null;
  const at = (e: PointerEvent) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (d ?? 0);
  };
  const pct = (t: number) => (d ? `${Math.min(100, Math.max(0, (t / d) * 100))}%` : "0%");
  const shown = drag ?? pos;
  return (
    <div
      class="tl st-scrub"
      ref={bar}
      role="slider"
      aria-label="Studio position"
      aria-valuemin={0}
      aria-valuemax={d ?? 0}
      aria-valuenow={Math.round(shown)}
      onPointerDown={(e) => {
        if (!d || e.button !== 0) return;
        try {
          bar.current!.setPointerCapture(e.pointerId);
        } catch {}
        dragging.current = true;
        moved.current = false;
        const t = at(e);
        setDrag(t);
        onSeek(t, false); // a click is never throttled
      }}
      onPointerMove={(e) => {
        if (!dragging.current || !d) return;
        moved.current = true;
        const t = at(e);
        setDrag(t);
        onSeek(t, true); // one seek in flight, the latest target wins
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        setDrag(null);
        if (moved.current) onSeek(at(e), false);
      }}
      onPointerCancel={() => {
        dragging.current = false;
        setDrag(null);
      }}
    >
      <div class="tl-track">
        <i class="tl-done" style={{ width: pct(shown) }} />
        {ab.a != null && ab.b != null && <i class="tl-ab" style={{ left: pct(ab.a), width: `calc(${pct(ab.b)} - ${pct(ab.a)})` }} />}
        {ab.a != null && <i class="tl-abm" style={{ left: pct(ab.a) }} title={`A ${fmtClock(ab.a)}`} />}
        {ab.b != null && <i class="tl-abm" style={{ left: pct(ab.b) }} title={`B ${fmtClock(ab.b)}`} />}
        <b class="tl-head" style={{ left: pct(shown) }} />
      </div>
    </div>
  );
}

const subtitle = (h: { album: string; artist: string }) => [h.album, h.artist].filter(Boolean).join(" · ");

export function StudioBar({ songId, initial, say, onClose, ctl }: Props) {
  const [data, setData] = useState<SongStudioDto>(initial);
  const [st, setSt] = useState<StudioStateDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const [ab, setAb] = useState<AbLoop>(AB_OFF);
  const [listOpen, setListOpen] = useState(false);
  const [sel, setSel] = useState<string | null>(null); // a Mirror Track chosen for "match this Track"
  const [q, setQ] = useState("");
  const [results, setResults] = useState<DumpHitDto[] | null>(null);

  const S = useRef({ st: null as StudioStateDto | null, rx: 0, ab: AB_OFF as AbLoop, seq: 0, seeking: false, error: null as string | null, loopSeekAt: 0, userPaused: false, resuming: false });
  S.current.ab = ab;
  const close = useRef(onClose);
  close.current = onClose;
  const sayRef = useRef(say);
  sayRef.current = say;

  const apply = (s: StudioStateDto, seq = ++S.current.seq) => {
    if (seq < S.current.seq) return;
    S.current.st = s;
    S.current.rx = performance.now();
    setSt(s);
    // Music.app quirk (smoke run): after a handful of backward seeks it pauses itself, loop or not. A pause that follows
    // our own loop seek (and still next to A), which nobody asked for, is undone here so the A-B loop keeps looping.
    if (s.active && s.state === "paused" && S.current.ab.b != null && !S.current.userPaused && !S.current.resuming && performance.now() - S.current.loopSeekAt < 2000 && (s.position ?? 0) <= (S.current.ab.a ?? 0) + 2) {
      S.current.resuming = true;
      api
        .studioResume()
        .then((r) => apply(r))
        .catch(fail)
        .finally(() => (S.current.resuming = false));
    }
    if (s.refused) {
      S.current.error = s.refused;
      setError(s.refused);
    }
  };
  const fail = (e: unknown) => {
    const m = apiError(e);
    if (m.startsWith("Music.app refused")) {
      S.current.error = REFUSED;
      setError(REFUSED);
      S.current.st = S.current.st ? { ...S.current.st, active: false } : null;
      setSt(S.current.st);
    } else sayRef.current(m, 2600);
  };

  /** Position now: the last reading plus the time since, while playing. */
  const position = (): number => {
    const s = S.current.st;
    if (!s || s.position == null) return 0;
    const run = s.state === "playing" ? (performance.now() - S.current.rx) / 1000 : 0;
    return clampStudioSeek(s.position + run, s.duration);
  };

  const reload = async () => {
    try {
      setData(await api.studio(songId));
    } catch {}
  };

  const play = async (id: number) => {
    setError(null);
    S.current.error = null;
    S.current.userPaused = false;
    const seq = ++S.current.seq;
    try {
      apply(await api.studioPlay(id), seq);
      setAb(AB_OFF);
      void reload(); // studio_last moved, and a stale id may have been re-matched
    } catch (e) {
      fail(e);
      void reload();
    }
  };

  const throttle = useRef(
    new SeekThrottle((t) => {
      const seq = ++S.current.seq;
      api
        .studioSeek(t)
        .then((s) => apply(s, seq))
        .catch(fail)
        .finally(() => throttle.current.landed());
    }),
  );
  const seekTo = (t: number, throttled = false) => {
    const s = S.current.st;
    if (!s?.active) return;
    const c = clampStudioSeek(t, s.duration);
    S.current.st = { ...s, position: c };
    S.current.rx = performance.now();
    throttle.current.request(c, throttled);
    tick((n) => n + 1);
  };

  // ---- mount: start the default track, or say there is nothing to play ----
  useEffect(() => {
    const first = defaultTrack(data);
    if (first) void play(first.id);
    else if (!data.tracks.length && !data.missing.length) {
      sayRef.current("no studio tracks", 2000);
      close.current();
    } else {
      setListOpen(true);
      sayRef.current("no matched studio track: search below", 2600);
    }
    return () => {
      // leaving the Player (route change, `<` `>`) must not leave Music.app playing
      if (S.current.st?.active) void fetch("/api/studio/stop", { method: "POST", keepalive: true }).catch(() => {});
    };
  }, []);

  // ---- polling (1 Hz, 4 Hz while an A-B loop is active) and the smooth position ----
  const active = !!st?.active;
  const looping = ab.a != null && ab.b != null;
  useEffect(() => {
    if (!active) return;
    void api.studioLoop(looping).catch(() => {});
    const timer = setInterval(() => {
      const seq = ++S.current.seq;
      api
        .studioState()
        .then((s) => {
          if (seq < S.current.seq) return;
          if (!s.active && !s.refused) return void close.current(); // another track, or the once-play ran out: silent end
          apply(s, seq);
        })
        .catch(() => {});
    }, looping ? POLL_FAST : POLL_SLOW);
    return () => clearInterval(timer);
  }, [active, looping]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      tick((n) => n + 1);
      const s = S.current;
      if (s.st?.state === "playing" && !throttle.current.busy) {
        const back = abLoopTarget(s.ab, position());
        if (back != null) {
          s.loopSeekAt = performance.now();
          seekTo(back);
        }
      }
    }, 100);
    return () => clearInterval(t);
  }, [active]);

  // ---- the Player's handle ----
  ctl.current = {
    key(op) {
      const s = S.current.st;
      if (!s?.active) return sayRef.current("nothing playing: pick a track", 1800);
      if (op === "toggle") {
        const seq = ++S.current.seq;
        S.current.userPaused = s.state === "playing";
        (s.state === "playing" ? api.studioPause() : api.studioResume()).then((r) => apply(r, seq)).catch(fail);
      } else if (op === "loop") {
        const r = abToggle(S.current.ab, position());
        setAb(r.ab);
        S.current.ab = r.ab;
        sayRef.current(r.label);
      } else seekTo(position() + op.seek);
    },
    async stop() {
      if (S.current.st?.active) {
        S.current.st = { ...S.current.st, active: false };
        await api.studioStop().catch(() => {});
      }
    },
  };

  // ---- the miss UI ----
  useEffect(() => {
    if (!q.trim()) return void setResults(null);
    let alive = true;
    const t = setTimeout(() => api.studioSearch(q).then((r) => alive && setResults(r.results)).catch(() => alive && setResults([])), 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      sayRef.current(apiError(e), 2600);
    }
    await reload();
  };
  const matchTo = (mirrorTrackId: string, pid: string) => act(() => api.matchTrack(mirrorTrackId, pid)).then(() => (setSel(null), setQ("")));
  const addToSong = (pid: string) => act(() => api.addLocal(songId, pid)).then(() => setQ(""));

  const pos = position();
  const dur = st?.duration ?? null;
  const cur = data.tracks.find((t) => t.id === st?.studioTrackId) ?? null;
  const mirrorRows = data.tracks.filter((t) => t.kind === "mirror");
  const selTrack = sel ? (data.missing.find((m) => m.mirrorTrackId === sel) ?? mirrorRows.find((m) => m.mirrorTrackId === sel)) : null;

  return (
    <div class="studio" data-studio="">
      <div class="st-head">
        <span class="st-tag mono">Studio</span>
        {error ? (
          <span class="st-err" role="alert">{error}</span>
        ) : active || cur ? (
          <>
            <span class="st-name">{st?.name || cur?.name || "…"}</span>
            <span class="st-album muted">{st?.album || cur?.album}</span>
          </>
        ) : (
          <span class="muted">nothing playing</span>
        )}
        <span class="grow" />
        {ab.a != null && (
          <span class="mono ablbl">
            A {fmtClock(ab.a)}
            {ab.b != null ? ` – B ${fmtClock(ab.b)}` : ""}
          </span>
        )}
        {active && (
          <span class="mono clock">
            {st?.state === "paused" ? "⏸ " : ""}
            {fmtClock(pos)} <span class="dim">/ {fmtClock(dur)}</span>
          </span>
        )}
        <button class={`btn small${listOpen ? " on" : ""}`} aria-pressed={listOpen} tabIndex={-1} onClick={() => setListOpen(!listOpen)}>
          Tracks{data.tracks.length + data.missing.length ? ` (${data.tracks.length}/${data.tracks.length + data.missing.length})` : ""}
        </button>
        <button class="ib" tabIndex={-1} title="Back to the Video (t, Esc)" aria-label="Close Studio" onClick={() => close.current()}>
          ×
        </button>
      </div>
      <Scrub pos={pos} dur={dur} ab={ab} onSeek={seekTo} />
      {listOpen && (
        <div class="st-list">
          {data.tracks.map((t) => (
            <div key={t.id} class={`st-row ${t.state}${t.id === st?.studioTrackId && active ? " cur" : ""}`}>
              <button class="st-main" tabIndex={-1} onClick={() => void play(t.id)} title="Play this one">
                <span class="st-mark" aria-hidden="true">{t.id === st?.studioTrackId && active ? "▶" : "♪"}</span>
                <span class="st-tn">{t.name}</span>
                <span class="muted st-ta">{subtitle(t)}</span>
                {t.durationS ? <span class="mono dim">{fmtClock(t.durationS)}</span> : null}
                {t.cloudStatus === "subscription" && <span class="st-badge" title="Streams from Apple Music">stream</span>}
              </button>
              <span class={`st-state ${t.state}`}>
                {t.state === "suggested" ? "suggested" : t.state === "missing" ? "not in Music.app" : t.kind === "local" ? "added" : "confirmed"}
              </span>
              {t.state === "suggested" && (
                <button class="ib" tabIndex={-1} title="Confirm this match" aria-label="Confirm match" onClick={() => void act(() => api.confirmStudio(t.id))}>
                  ✓
                </button>
              )}
              {t.mirrorTrackId && (
                <button class="btn small" tabIndex={-1} onClick={() => setSel(sel === t.mirrorTrackId ? null : t.mirrorTrackId)} title="Pick another Music.app track for this Track">
                  rematch
                </button>
              )}
              <button class="ib" tabIndex={-1} title={t.kind === "local" ? "Remove from the Song" : t.state === "suggested" ? "Reject this match" : "Remove this match"} aria-label="Remove" onClick={() => void act(() => api.removeStudio(t.id))}>
                ×
              </button>
            </div>
          ))}
          {data.missing.map((m) => (
            <div key={m.mirrorTrackId} class="st-row missing">
              <span class="st-main static">
                <span class="st-mark" aria-hidden="true">·</span>
                <span class="st-tn">{m.name}</span>
                <span class="muted st-ta">{m.album}</span>
                {m.durationS ? <span class="mono dim">{fmtClock(m.durationS)}</span> : null}
              </span>
              <span class="st-state missing">no match</span>
              <button class="btn small" tabIndex={-1} onClick={() => setSel(sel === m.mirrorTrackId ? null : m.mirrorTrackId)}>
                find…
              </button>
              {m.offers.length > 0 && (
                <div class="st-offers">
                  <span class="dim">offered, not matched:</span>
                  {m.offers.map((o) => (
                    <button key={o.persistentId} class="st-offer" tabIndex={-1} title="Use this one for the Track" onClick={() => void matchTo(m.mirrorTrackId, o.persistentId)}>
                      {o.name} <span class="muted">{subtitle(o)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {!data.tracks.length && !data.missing.length && <p class="muted st-empty">no studio tracks</p>}
          <div class="st-find" data-keep-focus="">
            <input
              type="search"
              placeholder={selTrack ? `Find the Music.app track for “${selTrack.name}”` : "Search the Music.app library to add a track to this Song"}
              value={q}
              onInput={(e) => setQ((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  e.preventDefault();
                  (e.target as HTMLElement).closest<HTMLElement>("[data-player]")?.focus({ preventScroll: true });
                }
              }}
              aria-label="Search the Music.app library"
            />
            {selTrack && (
              <span class="muted">
                matching Track “{selTrack.name}” <button class="btn small" onClick={() => setSel(null)}>cancel</button>
              </span>
            )}
            {results && (
              <div class="st-results">
                {results.length === 0 && <p class="muted st-empty">nothing in the Music.app library matches</p>}
                {results.map((r) => (
                  <div key={r.persistentId} class="st-res">
                    <span class="st-tn">{r.name}</span>
                    <span class="muted st-ta">{subtitle(r)}</span>
                    <span class="mono dim">{r.durationS ? fmtClock(r.durationS) : ""}</span>
                    {selTrack ? (
                      <button class="btn small" onClick={() => void matchTo(selTrack.mirrorTrackId!, r.persistentId)}>match this Track</button>
                    ) : (
                      <button class="btn small" onClick={() => void addToSong(r.persistentId)}>add to Song</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
