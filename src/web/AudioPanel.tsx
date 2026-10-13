// The Audio panel (spec 4.7, `a` or the Audio button): the Video's Audio settings in the drawer slot. Channels (live
// meters, routing, balance, per-channel volume), the equalizer (presets, built-in and custom, over seven faders) and
// level (preamp, leveler). Controlled: the page owns the settings and persists them; this only renders and edits.
import { useEffect, useRef, useState } from "preact/hooks";
import {
  BANDS, EQ_MAX, EQ_MIN, PREAMP_MAX, PREAMP_MIN, PRESET_NAME_MAX, ROUTINGS, VOL_MAX, isDefaultAudio, presetFor, presetNameError,
  type AudioPreset, type AudioState,
} from "../shared/audio";
import { AudioEngine, type Levels } from "./audioEngine";
import { CleanupSection } from "./prototype/CleanupSection"; // PROTOTYPE
import { DEFAULT_CLEANUP, type Cleanup } from "./prototype/cleanup"; // PROTOTYPE
import { autoSettings, type ReportRow } from "./prototype/auto"; // PROTOTYPE
import { analyzeFull, analyzeSampled, type Measure } from "./prototype/analyze"; // PROTOTYPE
import type { CopyDto } from "../shared/types";

interface Props {
  vid: { current: HTMLVideoElement | null };
  state: AudioState;
  onChange(patch: Partial<AudioState>): void;
  onReset(): void;
  presets: AudioPreset[];
  onSavePreset(name: string, eq: number[]): Promise<void>;
  onDeletePreset(name: string): Promise<void>;
  onClose(): void;
  /** PROTOTYPE: the Video's Copies, to size the one playing for the Auto wand */
  copies?: CopyDto[];
}

const METER_MS = 70;

// PROTOTYPE: the "did" half of an Auto report row, coloured like the State panel: numbers pink, words green
const Did = ({ s }: { s: string }) => (
  <>
    {s.split(" ").map((w, i) => (
      <span key={i} class={/^[+-]?\d/.test(w) ? "n" : "s"}>{i ? " " : ""}{w}</span>
    ))}
  </>
);

// PROTOTYPE: Lucide "audio-lines" (ISC, lucide.dev), same stroke style as the icons in ui.tsx
const WandIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3" />
  </svg>
);

function useLevels(vid: Props["vid"]) {
  const [lv, setLv] = useState<Levels>({ in: [0, 0], out: [0, 0] });
  useEffect(() => {
    const timer = setInterval(() => {
      const v = vid.current;
      if (v) setLv(AudioEngine.for(v).levels());
    }, METER_MS);
    return () => clearInterval(timer);
  }, [vid]);
  return lv;
}

// A segmented LED meter: the bar holds a green→yellow→red gradient, `--v` (0–100) uncovers it from the left.
const Meter = ({ v, label }: { v: number; label: string }) => (
  <>
    <span class="lbl mono">{label}</span>
    <div class={`bar${v < 0.02 ? " dead" : ""}`} title={`${label}: ${Math.round(v * 100)}`} style={{ "--v": Math.round(v * 100) }} />
  </>
);

const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;

export function AudioPanel({ vid, state: s, onChange, onReset, presets, onSavePreset, onDeletePreset, onClose, copies = [] }: Props) {
  const lv = useLevels(vid);
  const preset = presetFor(s.eq, presets);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const nameBox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (naming) nameBox.current?.focus(); }, [naming]);

  const setBand = (i: number, db: number) => {
    const eq = [...s.eq];
    eq[i] = db;
    onChange({ eq });
  };
  const save = async () => {
    const e = presetNameError(name);
    if (e) return setErr(e);
    try {
      await onSavePreset(name.trim(), s.eq);
      setNaming(false);
      setName("");
      setErr(null);
    } catch (x) {
      setErr(String((x as Error).message ?? x));
    }
  };
  // PROTOTYPE: Clean up state (in memory) and the Auto wand
  const [cleanup, setCleanup] = useState<Cleanup>(DEFAULT_CLEANUP);
  useEffect(() => { if (vid.current) AudioEngine.for(vid.current).setMultiband(cleanup.multiband); }, [cleanup.multiband]);
  const [auto, setAuto] = useState<{ phase: "idle" } | { phase: "ask"; copy: CopyDto } | { phase: "busy"; label: string }>({ phase: "idle" });
  const [autoReport, setAutoReport] = useState<ReportRow[] | null>(null);
  const abort = useRef<AbortController | null>(null);
  // the Copy the Player is on: its id is in the <video> src
  const playingCopy = (): CopyDto | null => {
    const m = vid.current?.src.match(/\/copy\/(\d+)/);
    return (m && copies.find((c) => c.id === Number(m[1]))) ?? null;
  };
  const BIG_BYTES = 1e9, BIG_SECS = 20 * 60;
  const isBig = (c: CopyDto) => c.size > BIG_BYTES || (c.durationS ?? 0) > BIG_SECS;

  const startAuto = () => {
    const c = playingCopy();
    if (c && isBig(c)) setAuto({ phase: "ask", copy: c });
    else void runAuto(c ? "full" : "sampled");
  };
  const cancelAuto = () => { abort.current?.abort(); setAuto({ phase: "idle" }); };
  const runAuto = async (how: "full" | "sampled") => {
    const v = vid.current;
    if (!v) return;
    const eng = AudioEngine.for(v);
    setAutoReport(null);
    const ac = new AbortController();
    abort.current = ac;
    try {
      let m: Measure;
      if (how === "full") {
        const c = playingCopy();
        if (!c) throw new Error("no Copy");
        setAuto({ phase: "busy", label: "decoding…" });
        m = await analyzeFull(c.id, (f) => setAuto({ phase: "busy", label: `decoding ${Math.round(f * 100)} %` }), c.durationS, ac.signal);
      } else {
        // measure through the live chain with the chain at its defaults
        onChange({ ...s, routing: "stereo", balance: 0, volL: 1, volR: 1, preamp: 0 });
        setCleanup(() => DEFAULT_CLEANUP);
        setAuto({ phase: "busy", label: "listening…" });
        await new Promise((r) => setTimeout(r, 300));
        m = await analyzeSampled(v, eng, (f) => setAuto({ phase: "busy", label: `listening ${Math.round(f * 100)} %` }));
      }
      if (ac.signal.aborted) return;
      const out = autoSettings(m);
      onChange(out.audio);
      setCleanup(() => out.cleanup);
      setAutoReport(out.report);
    } catch (e) {
      if (!ac.signal.aborted) setAutoReport([{ k: "error", heard: String((e as Error).message ?? e), did: "" }]);
    } finally {
      if (abort.current === ac) { abort.current = null; setAuto({ phase: "idle" }); }
    }
  };
  const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

  const nameExists = !!name.trim() && presets.some((p) => !p.builtIn && p.name.toLowerCase() === name.trim().toLowerCase());

  return (
    <aside class="drawer audio" tabIndex={-1} data-keep-focus="" role="region" aria-label="Audio settings" onKeyDown={(e) => e.key === "Escape" && !naming && (e.preventDefault(), onClose())}>
      <div class="hd">
        <div class="row">
          <span class="ttl">Audio</span>
          {auto.phase === "busy" ? (
            <button class="btn small wand" onClick={cancelAuto} title="Stop">
              <WandIcon /> {auto.label} <span class="dim">×</span>
            </button>
          ) : (
            <button class="btn small wand" disabled={auto.phase === "ask"} onClick={startAuto} title="Auto: analyse the recording, then balance channels, level, clean-up and EQ (prototype)">
              <WandIcon /> Auto
            </button>
          )}
          {!isDefaultAudio(s) && <button class="btn small" onClick={onReset} title="Back to the sound as recorded">Reset</button>}
          <button class="ib" aria-label="Close audio" title="Close (a while the Player has focus)" onClick={onClose}>×</button>
        </div>
      </div>
      <div class="body">
        {auto.phase === "ask" && (
          <div class="au-report stpanel au-ask">
            <div class="au-rhd"><span class="st-tag">auto</span><span class="dim">large Copy</span><button class="ib" aria-label="Cancel" onClick={cancelAuto}>×</button></div>
            <p>This Copy is <span class="n">{fmtBytes(auto.copy.size)}</span>{auto.copy.durationS ? <> · <span class="n">{Math.round(auto.copy.durationS / 60)}</span><span class="u"> min</span></> : null}. Decoding the whole file reads all of it, which can take a while.</p>
            <div class="au-chips">
              <button class="tag save" onClick={() => void runAuto("sampled")}>Sample 5 places <span class="dim">~8 s</span></button>
              <button class="tag save" onClick={() => void runAuto("full")}>Decode whole file</button>
            </div>
          </div>
        )}
        {autoReport && (
          <div class="au-report stpanel">
            <div class="au-rhd"><span class="st-tag">auto</span><span class="dim">{autoReport.length} change{autoReport.length === 1 ? "" : "s"}</span><button class="ib" aria-label="Dismiss" onClick={() => setAutoReport(null)}>×</button></div>
            <div class="kv">
              {autoReport.map((r) => (
                <>
                  <b>{r.k}</b>
                  <span><span class="u">{r.heard}</span>{r.did && <><span class="arrow">→</span><Did s={r.did} /></>}</span>
                </>
              ))}
            </div>
          </div>
        )}
        <h5>Channels</h5>
        <div class="au-meters">
          <Meter v={lv.in[0]} label="in L" /><Meter v={lv.in[1]} label="in R" />
          <Meter v={lv.out[0]} label="out L" /><Meter v={lv.out[1]} label="out R" />
        </div>
        <div class="seg au-routing" role="radiogroup" aria-label="Channel routing">
          {ROUTINGS.map((r) => (
            <button key={r.key} class={s.routing === r.key ? "on" : ""} role="radio" aria-checked={s.routing === r.key} title={r.hint} onClick={() => onChange({ routing: r.key })}>
              {r.label}
            </button>
          ))}
        </div>
        <label class="au-row">
          <span>Balance</span>
          <input type="range" min={-1} max={1} step={0.05} value={s.balance} onInput={(e) => onChange({ balance: +e.currentTarget.value })} onDblClick={() => onChange({ balance: 0 })} />
          <b class="mono">{s.balance === 0 ? "C" : s.balance < 0 ? `L ${Math.round(-s.balance * 100)}` : `R ${Math.round(s.balance * 100)}`}</b>
        </label>
        <label class="au-row">
          <span>Left</span>
          <input type="range" min={0} max={VOL_MAX} step={0.05} value={s.volL} onInput={(e) => onChange({ volL: +e.currentTarget.value })} onDblClick={() => onChange({ volL: 1 })} />
          <b class="mono">{Math.round(s.volL * 100)}</b>
        </label>
        <label class="au-row">
          <span>Right</span>
          <input type="range" min={0} max={VOL_MAX} step={0.05} value={s.volR} onInput={(e) => onChange({ volR: +e.currentTarget.value })} onDblClick={() => onChange({ volR: 1 })} />
          <b class="mono">{Math.round(s.volR * 100)}</b>
        </label>

        <CleanupSection vid={vid} c={cleanup} setC={setCleanup} />{/* PROTOTYPE */}

        <h5>Equalizer <span class="dim">{preset?.name ?? "custom"}</span></h5>
        <div class="au-chips">
          {presets.map((p) => (
            <span key={p.name} class={`tag${preset?.name === p.name ? " on" : ""}${p.builtIn ? "" : " custom"}`} title={p.blurb ?? `custom: ${p.eq.map(signed).join(" ")}`}>
              <button onClick={() => onChange({ eq: [...p.eq] })}>{p.name}</button>
              {!p.builtIn && <button class="x" aria-label={`Delete preset ${p.name}`} title="Delete this preset" onClick={() => void onDeletePreset(p.name)}>×</button>}
            </span>
          ))}
          {!naming && (
            <button class="tag save" title="Save these seven bands as a preset of your own" onClick={() => (setNaming(true), setName(preset && !preset.builtIn ? preset.name : ""), setErr(null))}>
              + Save…
            </button>
          )}
        </div>
        {naming && (
          <form class="au-name" onSubmit={(e) => (e.preventDefault(), void save())}>
            <input ref={nameBox} value={name} maxLength={PRESET_NAME_MAX} placeholder="Preset name" aria-label="Preset name" onInput={(e) => (setName(e.currentTarget.value), setErr(null))} onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), setNaming(false), setErr(null))} />
            <button type="submit" class="btn small">{nameExists ? "Overwrite" : "Save"}</button>
            <button type="button" class="btn small" onClick={() => (setNaming(false), setErr(null))}>Cancel</button>
            {err && <span class="err">{err}</span>}
          </form>
        )}
        <div class="au-faders">
          {BANDS.map((b, i) => (
            <label key={b.hz} class="au-fader" title={`${b.hz} Hz · double-click to zero`}>
              <b class="mono">{signed(s.eq[i]!)}</b>
              <input type="range" min={EQ_MIN} max={EQ_MAX} step={1} value={s.eq[i]} aria-label={`${b.hz} Hz`} onInput={(e) => setBand(i, +e.currentTarget.value)} onDblClick={() => setBand(i, 0)} />
              <span class="mono">{b.label}</span>
            </label>
          ))}
        </div>

        <h5>Level</h5>
        <label class="au-row">
          <span>Preamp</span>
          <input type="range" min={PREAMP_MIN} max={PREAMP_MAX} step={1} value={s.preamp} onInput={(e) => onChange({ preamp: +e.currentTarget.value })} onDblClick={() => onChange({ preamp: 0 })} />
          <b class="mono">{signed(s.preamp)} dB</b>
        </label>
        <label class="au-row au-check" title="A compressor: quiet parts up, loud parts down">
          <input type="checkbox" checked={s.compress} onChange={(e) => onChange({ compress: e.currentTarget.checked })} />
          <span>Even out loudness</span>
          <input type="range" min={0} max={1} step={0.05} value={s.compressAmount} disabled={!s.compress} aria-label="Leveler amount" onInput={(e) => onChange({ compressAmount: +e.currentTarget.value })} />
        </label>
        <label class="au-row au-check au-sub" title="PROTOTYPE: three bands (below 200 Hz, 200 Hz to 3 kHz, above) each levelled on their own, so a drum thump no longer ducks the voice">
          <input type="checkbox" checked={cleanup.multiband} disabled={!s.compress} onChange={(e) => setCleanup((c) => ({ ...c, multiband: e.currentTarget.checked }))} />
          <span>Per band <span class="dim">low · mid · high</span></span>
          <span />
        </label>
        <p class="note dim">Saved for this Video. <kbd>Esc</kbd> returns to the Player.</p>
      </div>
    </aside>
  );
}
