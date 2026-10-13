// The Clean up section of the Audio panel (spec 4.7): a live spectrum (log frequency; click to place a notch), the
// rumble and hiss cutoffs, Find tone and the hum shortcuts, the notch cards and the denoise. Controlled like the rest
// of the panel: the settings come in, edits go out through onChange.
import { useEffect, useRef, useState } from "preact/hooks";
import { AudioEngine } from "./audioEngine";
import { HP_MAX, HP_MIN, LP_MAX, LP_MIN, NOTCH_DEPTH_MAX, NOTCH_HZ_MAX, NOTCH_HZ_MIN, NOTCH_MAX, NOTCH_Q_MAX, NOTCH_Q_MIN, fmtHz, hzToPos, posToHz, type AudioState, type Notch } from "../shared/audio";

const SPEC_LO = NOTCH_HZ_MIN, SPEC_HI = NOTCH_HZ_MAX;
const xOf = (hz: number, w: number) => hzToPos(hz, SPEC_LO, SPEC_HI) * w;
const hzAt = (x: number, w: number) => posToHz(x / w, SPEC_LO, SPEC_HI);

interface Props {
  vid: { current: HTMLVideoElement | null };
  state: AudioState;
  onChange(patch: Partial<AudioState>): void;
}

export function CleanupSection({ vid, state: c, onChange }: Props) {
  const [finding, setFinding] = useState(false);
  const [dnMode, setDnMode] = useState<"auto" | "learning" | "learned">("auto");
  useEffect(() => {
    const e = engine();
    if (!e) return;
    setDnMode(e.denoiseMode);
    e.onDenoiseMode = setDnMode;
    return () => { e.onDenoiseMode = null; };
  }, [vid.current]);
  const [msg, setMsg] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = () => (vid.current ? AudioEngine.for(vid.current).cleanup : null);
  const patch = onChange;
  const setNotch = (i: number, p: Partial<Notch>) => onChange({ notches: c.notches.map((n, j) => (j === i ? { ...n, ...p } : n)) });
  const addNotch = (hz: number) => { if (c.notches.length < NOTCH_MAX) onChange({ notches: [...c.notches, { hz: Math.round(hz), q: 30, depth: 30, harmonics: false }] }); };
  const dropNotch = (i: number) => onChange({ notches: c.notches.filter((_, j) => j !== i) });

  // the spectrum, capped at 25 fps: an 8192-point FFT and a full redraw per frame is wasted at the display's 60–120 Hz
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 40) return;
      last = now;
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
    draw(0);
    return () => cancelAnimationFrame(raf);
  }, [c.highpass, c.lowpass, c.notches]);

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
      <h5>Clean up</h5>
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
            <input type="range" min={NOTCH_Q_MIN} max={NOTCH_Q_MAX} step={1} value={n.q} onInput={(e) => setNotch(i, { q: +e.currentTarget.value })} />
            <b class="mono">Q {n.q}</b>
          </label>
          <label class="au-row">
            <span>Depth</span>
            <input type="range" min={0} max={NOTCH_DEPTH_MAX} step={1} value={n.depth} onInput={(e) => setNotch(i, { depth: +e.currentTarget.value })} />
            <b class="mono">−{n.depth} dB</b>
          </label>
        </div>
      ))}
      <label class="au-row au-check" title="Spectral denoise: subtracts the noise floor per frequency band. Auto tracks the floor from gaps and pauses; Learn takes the next second as the profile">
        <input type="checkbox" checked={c.denoise} onChange={(e) => patch({ denoise: e.currentTarget.checked })} />
        <span>Denoise</span>
        <input type="range" min={0} max={1} step={0.05} value={c.denoiseAmount} disabled={!c.denoise} aria-label="Denoise amount" onInput={(e) => patch({ denoiseAmount: +e.currentTarget.value })} />
      </label>
      {c.denoise && (
        <div class="au-chips au-dn">
          <span class="dim">profile: <b class={`mono dn-${dnMode}`}>{dnMode === "learning" ? "listening…" : dnMode}</b></span>
          <button class="tag save" disabled={dnMode === "learning"} title="Seek to a gap or a pause first, then press: the next second becomes the noise profile" onClick={() => engine()?.learnNoise()}>Learn noise now</button>
          {dnMode === "learned" && <button class="tag save" title="Back to the tracked floor" onClick={() => engine()?.autoNoise()}>Auto</button>}
        </div>
      )}
    </>
  );
}
