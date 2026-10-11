// PROTOTYPE — throwaway. Three variants of the Audio panel, rendered in the Now playing drawer slot on the real
// /play/:id route and switched with `?variant=A|B|C` (PrototypeSwitcher.tsx). Question answered: what should the
// audio-fixing panel look like — a mixer console (A), a problem-first fix list (B), or a draggable EQ curve (C)?
// The chain itself (engine.ts) is real so the variants can be judged by ear.
import { useEffect, useRef, useState } from "preact/hooks";
import { AudioEngine, BANDS, DEFAULT, PRESETS, diagnose, type AudioState, type Routing } from "./engine";

export const VARIANTS = [
  { key: "A", name: "Console" },
  { key: "B", name: "Fix list" },
  { key: "C", name: "Curve" },
];

const ROUTES: { key: Routing; label: string; hint: string }[] = [
  { key: "stereo", label: "Stereo", hint: "as recorded" },
  { key: "mono", label: "Mono", hint: "both channels mixed to both ears" },
  { key: "left", label: "L → both", hint: "left channel in both ears" },
  { key: "right", label: "R → both", hint: "right channel in both ears" },
  { key: "swap", label: "Swap", hint: "left and right exchanged" },
];

function useEngine() {
  const [eng, setEng] = useState<AudioEngine | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const video = document.querySelector<HTMLVideoElement>("video.vid");
    if (!video) return;
    const e = AudioEngine.for(video);
    setEng(e);
    return e.subscribe(() => tick((n) => n + 1));
  }, []);
  return eng;
}

function useLevels(eng: AudioEngine | null) {
  const [lv, setLv] = useState<{ in: [number, number]; out: [number, number] }>({ in: [0, 0], out: [0, 0] });
  const hist = useRef<{ in: [number, number] }[]>([]);
  useEffect(() => {
    if (!eng) return;
    const timer = setInterval(() => {
      const l = eng.levels();
      setLv(l);
      hist.current.push({ in: l.in });
      if (hist.current.length > 40) hist.current.shift();
    }, 70);
    return () => clearInterval(timer);
  }, [eng]);
  return { lv, hist: hist.current };
}

const Meter = ({ v, label }: { v: number; label: string }) => (
  <div class="ap-meter" title={`${label}: ${Math.round(v * 100)}`}>
    <span class="lbl">{label}</span>
    <div class="bar"><i style={{ width: `${Math.round(v * 100)}%` }} class={v < 0.02 ? "dead" : ""} /></div>
  </div>
);

const Head = ({ title, sub, onClose, onReset, dirty }: { title: string; sub?: string; onClose: () => void; onReset: () => void; dirty: boolean }) => (
  <div class="hd">
    <div class="row">
      <span class="ttl">{title} {sub && <span class="en">{sub}</span>}</span>
      {dirty && <button class="btn small" onClick={onReset} title="Back to the untouched sound">Reset</button>}
      <button class="ib" aria-label="Close audio" onClick={onClose}>×</button>
    </div>
  </div>
);

/** The full chain, spelled out — so what changed is always visible (prototype rule 5). */
const StateDump = ({ s }: { s: AudioState }) => (
  <pre class="ap-state mono dim">
    {`route ${s.routing}  bal ${s.balance >= 0 ? "+" : ""}${s.balance.toFixed(2)}  L ${s.volL.toFixed(2)} R ${s.volR.toFixed(2)}  pre ${s.preamp >= 0 ? "+" : ""}${s.preamp} dB
eq [${s.eq.map((v) => (v >= 0 ? "+" : "") + v).join(" ")}] ${s.preset ?? "custom"}
level ${s.compress ? `on ${Math.round(s.compressAmount * 100)}%` : "off"}`}
  </pre>
);

const isDirty = (s: AudioState) => JSON.stringify(s) !== JSON.stringify(DEFAULT);

// ---------------------------------------------------------------------------------------------- A: Console
// A mixer: channels strip on top, vertical EQ faders, level section. Everything is a fader.
export function VariantA({ onClose }: { onClose: () => void }) {
  const eng = useEngine();
  const { lv } = useLevels(eng);
  if (!eng) return <aside class="drawer ap"><Head title="Audio" onClose={onClose} onReset={() => {}} dirty={false} /><div class="body"><p class="empty">no video element yet</p></div></aside>;
  const s = eng.state;
  return (
    <aside class="drawer ap ap-a" tabIndex={-1} data-keep-focus="" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onClose())}>
      <Head title="Audio" sub="console" onClose={onClose} onReset={() => eng.reset()} dirty={isDirty(s)} />
      <div class="body">
        <h5>Channels</h5>
        <div class="ap-meters">
          <Meter v={lv.in[0]} label="in L" /><Meter v={lv.in[1]} label="in R" />
          <Meter v={lv.out[0]} label="out L" /><Meter v={lv.out[1]} label="out R" />
        </div>
        <div class="seg ap-seg">
          {ROUTES.map((r) => <button key={r.key} class={s.routing === r.key ? "on" : ""} title={r.hint} onClick={() => eng.set({ routing: r.key })}>{r.label}</button>)}
        </div>
        <label class="ap-row"><span>Balance</span><input type="range" min={-1} max={1} step={0.05} value={s.balance} onInput={(e) => eng.set({ balance: +e.currentTarget.value })} /><b class="mono">{s.balance === 0 ? "C" : s.balance < 0 ? `L${Math.round(-s.balance * 100)}` : `R${Math.round(s.balance * 100)}`}</b></label>
        <label class="ap-row"><span>Left</span><input type="range" min={0} max={2} step={0.05} value={s.volL} onInput={(e) => eng.set({ volL: +e.currentTarget.value })} /><b class="mono">{Math.round(s.volL * 100)}</b></label>
        <label class="ap-row"><span>Right</span><input type="range" min={0} max={2} step={0.05} value={s.volR} onInput={(e) => eng.set({ volR: +e.currentTarget.value })} /><b class="mono">{Math.round(s.volR * 100)}</b></label>

        <h5>Equalizer <span class="dim">{s.preset ?? "custom"}</span></h5>
        <div class="ap-chips">
          {Object.entries(PRESETS).map(([name, p]) => <button key={name} class={`tag${s.preset === name ? " on" : ""}`} title={p.blurb} onClick={() => eng.applyPreset(name)}>{name}</button>)}
        </div>
        <div class="ap-faders">
          {BANDS.map((b, i) => (
            <label key={b.hz} class="ap-fader">
              <b class="mono">{s.eq[i]! > 0 ? "+" : ""}{s.eq[i]}</b>
              <input type="range" min={-12} max={12} step={1} value={s.eq[i]} onInput={(e) => { const eq = [...s.eq]; eq[i] = +e.currentTarget.value; eng.set({ eq }); }} onDblClick={() => { const eq = [...s.eq]; eq[i] = 0; eng.set({ eq }); }} />
              <span class="mono">{b.label}</span>
            </label>
          ))}
        </div>

        <h5>Level</h5>
        <label class="ap-row"><span>Preamp</span><input type="range" min={-12} max={18} step={1} value={s.preamp} onInput={(e) => eng.set({ preamp: +e.currentTarget.value })} /><b class="mono">{s.preamp > 0 ? "+" : ""}{s.preamp} dB</b></label>
        <label class="ap-row ap-check"><input type="checkbox" checked={s.compress} onChange={(e) => eng.set({ compress: e.currentTarget.checked })} /><span>Even out loudness</span><input type="range" min={0} max={1} step={0.05} value={s.compressAmount} disabled={!s.compress} onInput={(e) => eng.set({ compressAmount: +e.currentTarget.value })} /></label>
        <StateDump s={s} />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------- B: Fix list
// Problem-first: a live diagnosis card, then one-click fixes phrased as the problems they solve. Raw EQ hidden.
export function VariantB({ onClose }: { onClose: () => void }) {
  const eng = useEngine();
  const { lv, hist } = useLevels(eng);
  const [adv, setAdv] = useState(false);
  if (!eng) return <aside class="drawer ap"><Head title="Audio" onClose={onClose} onReset={() => {}} dirty={false} /><div class="body"><p class="empty">no video element yet</p></div></aside>;
  const s = eng.state;
  const d = diagnose(hist);
  const voice = s.preset === "Voice", instr = s.preset === "Instruments", old = s.preset === "Old recording";
  const Fix = ({ on, title, why, onToggle, children }: { on: boolean; title: string; why: string; onToggle: () => void; children?: preact.ComponentChildren }) => (
    <div class={`ap-fix${on ? " on" : ""}`}>
      <button class="ap-fixbtn" aria-pressed={on} onClick={onToggle}>
        <i class="dot" /><span><b>{title}</b><small>{why}</small></span>
      </button>
      {on && children && <div class="ap-fixbody">{children}</div>}
    </div>
  );
  return (
    <aside class="drawer ap ap-b" tabIndex={-1} data-keep-focus="" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onClose())}>
      <Head title="Audio" sub="fix list" onClose={onClose} onReset={() => eng.reset()} dirty={isDirty(s)} />
      <div class="body">
        <div class={`ap-diag ${d.severity}`}>
          <div class="ap-meters tight"><Meter v={lv.in[0]} label="L" /><Meter v={lv.in[1]} label="R" /></div>
          <b>{d.title}</b>
          <span class="dim">{d.detail}</span>
          {d.fix && <button class="btn small" onClick={() => eng.set(d.fix!)}>Fix it</button>}
        </div>

        <h5>Channels</h5>
        <Fix on={s.routing === "left"} title="Only the left channel has sound" why="play the left channel in both ears" onToggle={() => eng.set({ routing: s.routing === "left" ? "stereo" : "left" })} />
        <Fix on={s.routing === "right"} title="Only the right channel has sound" why="play the right channel in both ears" onToggle={() => eng.set({ routing: s.routing === "right" ? "stereo" : "right" })} />
        <Fix on={s.routing === "mono"} title="Stereo is lopsided or odd" why="fold both channels to mono" onToggle={() => eng.set({ routing: s.routing === "mono" ? "stereo" : "mono" })} />
        <Fix on={s.balance !== 0} title="One side is louder" why="shift the balance" onToggle={() => eng.set({ balance: s.balance !== 0 ? 0 : 0.3 })}>
          <label class="ap-row"><span>L</span><input type="range" min={-1} max={1} step={0.05} value={s.balance} onInput={(e) => eng.set({ balance: +e.currentTarget.value })} /><span>R</span></label>
        </Fix>

        <h5>Mix</h5>
        <Fix on={voice} title="Can't hear the singer" why="voice forward, low mud cut" onToggle={() => eng.applyPreset(voice ? "Flat" : "Voice")} />
        <Fix on={instr} title="Instruments are buried" why="body and bite for igil and doshpuluur" onToggle={() => eng.applyPreset(instr ? "Flat" : "Instruments")} />
        <Fix on={old} title="Dull, muffled old recording" why="rumble out, top brightened" onToggle={() => eng.applyPreset(old ? "Flat" : "Old recording")} />
        <Fix on={s.compress} title="Too quiet, or loud then quiet" why="even out loudness and lift the level" onToggle={() => eng.set({ compress: !s.compress, preamp: s.compress ? 0 : 6 })}>
          <label class="ap-row"><span>gentle</span><input type="range" min={0} max={1} step={0.05} value={s.compressAmount} onInput={(e) => eng.set({ compressAmount: +e.currentTarget.value })} /><span>hard</span></label>
        </Fix>

        <button class="ap-adv dim" onClick={() => setAdv(!adv)}>{adv ? "▾" : "▸"} fine tune</button>
        {adv && (
          <div class="ap-faders small">
            {BANDS.map((b, i) => (
              <label key={b.hz} class="ap-fader">
                <b class="mono">{s.eq[i]! > 0 ? "+" : ""}{s.eq[i]}</b>
                <input type="range" min={-12} max={12} step={1} value={s.eq[i]} onInput={(e) => { const eq = [...s.eq]; eq[i] = +e.currentTarget.value; eng.set({ eq }); }} />
                <span class="mono">{b.label}</span>
              </label>
            ))}
          </div>
        )}
        <StateDump s={s} />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------- C: Curve
// One big draggable EQ curve, presets as a segmented row, stereo as a compact field widget. No faders.
export function VariantC({ onClose }: { onClose: () => void }) {
  const eng = useEngine();
  const { lv } = useLevels(eng);
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  if (!eng) return <aside class="drawer ap"><Head title="Audio" onClose={onClose} onReset={() => {}} dirty={false} /><div class="body"><p class="empty">no video element yet</p></div></aside>;
  const s = eng.state;
  const W = 340, H = 170, PAD = 10;
  const fx = (hz: number) => PAD + ((Math.log(hz / 30) / Math.log(18000 / 30)) * (W - 2 * PAD));
  const fy = (db: number) => H / 2 - (db / 14) * (H / 2 - PAD);
  const resp = eng.response();
  const path = resp.map((p, i) => `${i ? "L" : "M"}${fx(p.hz).toFixed(1)},${fy(p.db).toFixed(1)}`).join(" ");
  const yToDb = (clientY: number) => {
    const r = svg.current!.getBoundingClientRect();
    const y = ((clientY - r.top) / r.height) * H;
    return Math.max(-12, Math.min(12, Math.round(((H / 2 - y) / (H / 2 - PAD)) * 14)));
  };
  const setBand = (i: number, db: number) => { const eq = [...s.eq]; if (eq[i] !== db) { eq[i] = db; eng.set({ eq }); } };
  return (
    <aside class="drawer ap ap-c" tabIndex={-1} data-keep-focus="" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onClose())}>
      <Head title="Audio" sub="curve" onClose={onClose} onReset={() => eng.reset()} dirty={isDirty(s)} />
      <div class="body">
        <div class="seg ap-seg wrap">
          {Object.keys(PRESETS).map((name) => <button key={name} class={s.preset === name ? "on" : ""} title={PRESETS[name]!.blurb} onClick={() => eng.applyPreset(name)}>{name}</button>)}
        </div>
        <svg ref={svg} class="ap-curve" viewBox={`0 0 ${W} ${H}`}
          onPointerMove={(e) => drag != null && setBand(drag, yToDb(e.clientY))}
          onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
          <line x1={0} x2={W} y1={H / 2} y2={H / 2} class="zero" />
          {[-6, 6].map((db) => <line key={db} x1={0} x2={W} y1={fy(db)} y2={fy(db)} class="grid" />)}
          {BANDS.map((b) => <line key={b.hz} x1={fx(b.hz)} x2={fx(b.hz)} y1={0} y2={H} class="grid" />)}
          <path d={`${path} L${W - PAD},${H / 2} L${PAD},${H / 2} Z`} class="fill" />
          <path d={path} class="line" />
          {BANDS.map((b, i) => (
            <g key={b.hz} class={`pt${drag === i ? " on" : ""}`} onPointerDown={(e) => { (e.currentTarget as Element).closest("svg")!.setPointerCapture(e.pointerId); setDrag(i); }} onDblClick={() => setBand(i, 0)}>
              <circle cx={fx(b.hz)} cy={fy(s.eq[i]!)} r={9} class="hit" />
              <circle cx={fx(b.hz)} cy={fy(s.eq[i]!)} r={5} />
              <text x={fx(b.hz)} y={H - 2} text-anchor="middle">{b.label}</text>
              {(drag === i || s.eq[i] !== 0) && <text x={fx(b.hz)} y={fy(s.eq[i]!) - 10} text-anchor="middle" class="val">{s.eq[i]! > 0 ? "+" : ""}{s.eq[i]}</text>}
            </g>
          ))}
        </svg>
        <p class="dim ap-hint">drag a point · double-click to zero it · <span class="mono">{s.preset ?? "custom"}</span></p>

        <h5>Stereo field</h5>
        <div class="ap-field">
          <div class="ap-fieldbox" title="where the sound sits between your ears">
            <Meter v={lv.out[0]} label="L" /><Meter v={lv.out[1]} label="R" />
            <input type="range" class="pan" min={-1} max={1} step={0.05} value={s.balance} onInput={(e) => eng.set({ balance: +e.currentTarget.value })} title="balance" />
          </div>
          <select class="ap-select" value={s.routing} onChange={(e) => eng.set({ routing: e.currentTarget.value as Routing })} title="which recorded channel goes where">
            {ROUTES.map((r) => <option key={r.key} value={r.key}>{r.label} — {r.hint}</option>)}
          </select>
        </div>
        <div class="ap-twocol">
          <label class="ap-row"><span>Gain</span><input type="range" min={-12} max={18} step={1} value={s.preamp} onInput={(e) => eng.set({ preamp: +e.currentTarget.value })} /><b class="mono">{s.preamp > 0 ? "+" : ""}{s.preamp}</b></label>
          <button class={`tag${s.compress ? " on" : ""}`} onClick={() => eng.set({ compress: !s.compress })} title="dynamics compressor">Level out</button>
        </div>
        <StateDump s={s} />
      </div>
    </aside>
  );
}

export function AudioPanelPrototype({ variant, onClose }: { variant: string; onClose: () => void }) {
  if (variant === "B") return <VariantB onClose={onClose} />;
  if (variant === "C") return <VariantC onClose={onClose} />;
  return <VariantA onClose={onClose} />;
}
