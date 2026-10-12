// The Audio panel (spec 4.7, `a` or the Audio button): the Video's Audio settings in the drawer slot. Channels (live
// meters, routing, balance, per-channel volume), the equalizer (presets, built-in and custom, over seven faders) and
// level (preamp, leveler). Controlled: the page owns the settings and persists them; this only renders and edits.
import { useEffect, useRef, useState } from "preact/hooks";
import {
  BANDS, EQ_MAX, EQ_MIN, PREAMP_MAX, PREAMP_MIN, PRESET_NAME_MAX, ROUTINGS, VOL_MAX, isDefaultAudio, presetFor, presetNameError,
  type AudioPreset, type AudioState,
} from "../shared/audio";
import { AudioEngine, type Levels } from "./audioEngine";

interface Props {
  vid: { current: HTMLVideoElement | null };
  state: AudioState;
  onChange(patch: Partial<AudioState>): void;
  onReset(): void;
  presets: AudioPreset[];
  onSavePreset(name: string, eq: number[]): Promise<void>;
  onDeletePreset(name: string): Promise<void>;
  onClose(): void;
}

const METER_MS = 70;

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

/** One gruvbox slot per band, low to high: red, orange, yellow, green, aqua, blue, purple. */
const BAND_COLORS = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];

const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;

export function AudioPanel({ vid, state: s, onChange, onReset, presets, onSavePreset, onDeletePreset, onClose }: Props) {
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
  const nameExists = !!name.trim() && presets.some((p) => !p.builtIn && p.name.toLowerCase() === name.trim().toLowerCase());

  return (
    <aside class="drawer audio" tabIndex={-1} data-keep-focus="" role="region" aria-label="Audio settings" onKeyDown={(e) => e.key === "Escape" && !naming && (e.preventDefault(), onClose())}>
      <div class="hd">
        <div class="row">
          <span class="ttl">Audio</span>
          {!isDefaultAudio(s) && <button class="btn small" onClick={onReset} title="Back to the sound as recorded">Reset</button>}
          <button class="ib" aria-label="Close audio" title="Close (a while the Player has focus)" onClick={onClose}>×</button>
        </div>
      </div>
      <div class="body">
        <section class="au-sec" style={{ "--c": "var(--t6)" }}>
        <h5><span class="cm">{"// "}channels</span></h5>
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
        </section>

        <section class="au-sec" style={{ "--c": "var(--t7)" }}>
        <h5><span class="cm">{"// "}equalizer</span> <span class="dim">{preset?.name ?? "custom"}</span></h5>
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
            <label key={b.hz} class={`au-fader${s.eq[i] ? " set" : ""}`} style={{ "--c": `var(--${BAND_COLORS[i]})` }} title={`${b.hz} Hz · double-click to zero`}>
              <b class="mono">{signed(s.eq[i]!)}</b>
              <input type="range" min={EQ_MIN} max={EQ_MAX} step={1} value={s.eq[i]} aria-label={`${b.hz} Hz`} onInput={(e) => setBand(i, +e.currentTarget.value)} onDblClick={() => setBand(i, 0)} />
              <span class="mono">{b.label}</span>
            </label>
          ))}
        </div>
        </section>

        <section class="au-sec" style={{ "--c": "var(--t2)" }}>
        <h5><span class="cm">{"// "}level</span></h5>
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
        </section>
        <p class="note dim mono">{"// "}saved for this Video · <kbd>Esc</kbd> returns to the Player</p>
      </div>
    </aside>
  );
}
