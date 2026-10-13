// PROTOTYPE — throwaway. The "Clean up" section of the Audio panel (see ./cleanup.ts). State lives in this
// component only (reset on remount; nothing is saved). Spectrum: a canvas, log-frequency, click to place a notch.
import { useEffect, useRef, useState } from "preact/hooks";
import { AudioEngine } from "../audioEngine";
import { DEFAULT_CLEANUP, HP_MAX, HP_MIN, LP_MAX, LP_MIN, NOTCH_MAX, fmtHz, hzToPos, posToHz, type Cleanup, type Notch } from "./cleanup";

const SPEC_LO = 30, SPEC_HI = 16000;
const xOf = (hz: number, w: number) => hzToPos(hz, SPEC_LO, SPEC_HI) * w;
const hzAt = (x: number, w: number) => posToHz(x / w, SPEC_LO, SPEC_HI);

export function CleanupSection({ vid }: { vid: { current: HTMLVideoElement | null } }) {
  const [c, setC] = useState<Cleanup>(DEFAULT_CLEANUP);
  const [finding, setFinding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = () => (vid.current ? AudioEngine.for(vid.current).cleanup : null);
  const patch = (p: Partial<Cleanup>) => setC((prev) => ({ ...prev, ...p }));
  const setNotch = (i: number, p: Partial<Notch>) => setC((prev) => ({ ...prev, notches: prev.notches.map((n, j) => (j === i ? { ...n, ...p } : n)) }));
  const addNotch = (hz: number) => setC((prev) => (prev.notches.length >= NOTCH_MAX ? prev : { ...prev, notches: [...prev.notches, { hz: Math.round(hz), q: 30, depth: 30, harmonics: false }] }));
  const dropNotch = (i: number) => setC((prev) => ({ ...prev, notches: prev.notches.filter((_, j) => j !== i) }));

  useEffect(() => { engine()?.set(c); }, [c]);

  // the spectrum, ~30 fps
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = canvas.current, e = engine();
      if (!cv || !e) return;
      const w = cv.width, h = cv.height, g = cv.getContext("2d")!;
      const { db, hzPerBin } = e.read();
      g.clearRect(0, 0, w, h);
      // bands shaded out by the cutoffs
      g.fillStyle = "rgba(255,255,255,.06)";
      if (c.highpass) g.fillRect(0, 0, xOf(c.highpass, w), h);
      if (c.lowpass) g.fillRect(xOf(c.lowpass, w), 0, w - xOf(c.lowpass, w), h);
      // the curve: for each pixel column take the max bin in its Hz span
      g.beginPath();
      g.moveTo(0, h);
      for (let x = 0; x < w; x++) {
        const a = hzAt(x, w) / hzPerBin, b = Math.max(a + 1, hzAt(x + 1, w) / hzPerBin);
        let m = -140;
        for (let i = Math.floor(a); i < Math.ceil(b) && i < db.length; i++) m = Math.max(m, db[i]!);
        const y = h - Math.max(0, Math.min(1, (m + 100) / 100)) * h;
        g.lineTo(x, y);
      }
      g.lineTo(w, h);
      g.closePath();
      g.fillStyle = "rgba(142, 192, 124, .35)";
      g.fill();
      g.strokeStyle = "#b8bb26";
      g.lineWidth = 1;
      g.stroke();
      // notch markers
      for (const n of c.notches) for (const k of n.harmonics ? [1, 2, 3] : [1]) {
        const x = xOf(n.hz * k, w);
        g.strokeStyle = k === 1 ? "#fb4934" : "rgba(251,73,52,.5)";
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      }
      // grid labels
      g.fillStyle = "rgba(255,255,255,.35)"; g.font = "9px ui-monospace, monospace";
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) g.fillText(fmtHz(f), xOf(f, w) + 2, h - 2);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [c]);

  const findTone = async () => {
    const e = engine();
    if (!e) return;
    setFinding(true); setMsg(null);
    const frames: Float32Array[] = [];
    let hzPerBin = 0;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 80));
      const r = e.read();
      frames.push(Float32Array.from(r.db));
      hzPerBin = r.hzPerBin;
    }
    const t = e.findTone(frames, hzPerBin);
    setFinding(false);
    if (!t) return setMsg("nothing stands out");
    setMsg(`${fmtHz(t.hz)} Hz, +${Math.round(t.prominence)} dB over its neighbours`);
    addNotch(t.hz);
  };

  const onCanvasClick = (ev: MouseEvent) => {
    const cv = canvas.current!;
    const r = cv.getBoundingClientRect();
    addNotch(hzAt(((ev.clientX - r.left) / r.width) * cv.width, cv.width));
  };

  const hpPos = c.highpass ? hzToPos(c.highpass, HP_MIN, HP_MAX) : 0;
  const lpPos = c.lowpass ? hzToPos(c.lowpass, LP_MIN, LP_MAX) : 1;

  return (
    <>
      <h5>Clean up <span class="dim">prototype</span></h5>
      <canvas ref={canvas} class="au-spec" width={320} height={70} title="Live spectrum · click to place a notch" onClick={onCanvasClick} />
      <label class="au-row" title="Cut below: a 24 dB/oct high-pass for rumble, handling noise, mains thump">
        <span>Rumble</span>
        <input type="range" min={0} max={1} step={0.005} value={hpPos} onInput={(e) => { const p = +e.currentTarget.value; patch({ highpass: p <= 0 ? null : posToHz(p, HP_MIN, HP_MAX) }); }} onDblClick={() => patch({ highpass: null })} />
        <b class="mono">{c.highpass ? `${fmtHz(c.highpass)} Hz` : "off"}</b>
      </label>
      <label class="au-row" title="Cut above: a 24 dB/oct low-pass for hiss, fizz, digital edge">
        <span>Hiss</span>
        <input type="range" min={0} max={1} step={0.005} value={lpPos} onInput={(e) => { const p = +e.currentTarget.value; patch({ lowpass: p >= 1 ? null : posToHz(p, LP_MIN, LP_MAX) }); }} onDblClick={() => patch({ lowpass: null })} />
        <b class="mono">{c.lowpass ? `${fmtHz(c.lowpass)} Hz` : "off"}</b>
      </label>
      <div class="au-chips">
        <button class="tag save" disabled={finding || c.notches.length >= NOTCH_MAX} onClick={() => void findTone()}>{finding ? "listening…" : "Find tone"}</button>
        <button class="tag save" disabled={c.notches.length >= NOTCH_MAX} onClick={() => addNotch(50)}>+ Hum 50</button>
        <button class="tag save" disabled={c.notches.length >= NOTCH_MAX} onClick={() => addNotch(60)}>+ Hum 60</button>
        {msg && <span class="dim" style={{ fontSize: ".8em", alignSelf: "center" }}>{msg}</span>}
      </div>
      {c.notches.map((n, i) => (
        <div class="au-notch" key={i}>
          <div class="row">
            <b class="mono">notch {i + 1}</b>
            <label class="au-mini" title="also cut 2× and 3× (hum has harmonics)"><input type="checkbox" checked={n.harmonics} onChange={(e) => setNotch(i, { harmonics: e.currentTarget.checked })} /> harmonics</label>
            <button class="ib" aria-label="Remove notch" onClick={() => dropNotch(i)}>×</button>
          </div>
          <label class="au-row">
            <span>Freq</span>
            <input type="range" min={0} max={1} step={0.0005} value={hzToPos(n.hz, SPEC_LO, SPEC_HI)} onInput={(e) => setNotch(i, { hz: posToHz(+e.currentTarget.value, SPEC_LO, SPEC_HI) })} />
            <b class="mono">{fmtHz(n.hz)} Hz</b>
          </label>
          <label class="au-row" title="narrow (high Q) takes only the tone; wide takes its neighbours too">
            <span>Width</span>
            <input type="range" min={2} max={60} step={1} value={n.q} onInput={(e) => setNotch(i, { q: +e.currentTarget.value })} />
            <b class="mono">Q {n.q}</b>
          </label>
          <label class="au-row">
            <span>Depth</span>
            <input type="range" min={0} max={40} step={1} value={n.depth} onInput={(e) => setNotch(i, { depth: +e.currentTarget.value })} />
            <b class="mono">−{n.depth} dB</b>
          </label>
        </div>
      ))}
      <p class="note dim">Prototype: not saved. Click the spectrum to place a notch; drag its Freq to tune.</p>
    </>
  );
}
