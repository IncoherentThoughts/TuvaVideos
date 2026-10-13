// Audio settings (spec 4.7): what the Player does to a Video's sound: channels, clean up (cutoffs, notches, denoise),
// EQ and level. Pure data and rules; the Web Audio chain that applies them is src/web/audioEngine.ts, and the Auto
// wand's decisions are audioAuto.ts. Settings are per Video and persist (video_audio); EQ presets are shared.

export type Routing = "stereo" | "mono" | "left" | "right" | "swap";

export interface AudioState {
  routing: Routing;
  /** -1 (all left) … 0 (centre) … +1 (all right) */
  balance: number;
  /** per-channel volume 0…2 */
  volL: number;
  volR: number;
  /** dB, -12…18 */
  preamp: number;
  /** dB per band, -12…12, same order as BANDS */
  eq: number[];
  /** the loudness leveler (a compressor) */
  compress: boolean;
  /** 0 (gentle) … 1 (hard) */
  compressAmount: number;
  /** the leveler works in three bands (below 200 Hz, 200 Hz to 3 kHz, above) instead of on the whole mix */
  multiband: boolean;
  /** Clean up: cutoffs in Hz (null = off), up to NOTCH_MAX notches, and the spectral denoise with its strength 0…1 */
  highpass: number | null;
  lowpass: number | null;
  notches: Notch[];
  denoise: boolean;
  denoiseAmount: number;
}

/** A notch: a peaking cut of `depth` dB at `hz`, `q` wide; `harmonics` also cuts 2× and 3× (hum has harmonics). */
export interface Notch {
  hz: number;
  q: number;
  depth: number;
  harmonics: boolean;
}

export const BANDS: { hz: number; label: string; type: "lowshelf" | "peaking" | "highshelf" }[] = [
  { hz: 60, label: "60", type: "lowshelf" },
  { hz: 150, label: "150", type: "peaking" },
  { hz: 400, label: "400", type: "peaking" },
  { hz: 1000, label: "1k", type: "peaking" },
  { hz: 2500, label: "2.5k", type: "peaking" },
  { hz: 6000, label: "6k", type: "peaking" },
  { hz: 12000, label: "12k", type: "highshelf" },
];

export const ROUTINGS: { key: Routing; label: string; hint: string }[] = [
  { key: "stereo", label: "Stereo", hint: "as recorded" },
  { key: "mono", label: "Mono", hint: "both channels mixed, in both ears" },
  { key: "left", label: "Left", hint: "the left channel in both ears" },
  { key: "right", label: "Right", hint: "the right channel in both ears" },
  { key: "swap", label: "Swap", hint: "left and right exchanged" },
];

/** An EQ preset: the seven band gains. Built-in ones ship here; custom ones live in audio_preset. */
export interface AudioPreset {
  name: string;
  eq: number[];
  /** a one-line description (built-ins only) */
  blurb?: string;
  builtIn: boolean;
}

export const BUILT_IN_PRESETS: AudioPreset[] = [
  { name: "Flat", eq: [0, 0, 0, 0, 0, 0, 0], blurb: "no change", builtIn: true },
  { name: "Voice", eq: [-3, -4, -2, 3, 5, 3, 0], blurb: "throat and melody forward, mud cut", builtIn: true },
  { name: "Instruments", eq: [4, 2, -1, -2, 1, 3, 4], blurb: "igil and doshpuluur body and bite", builtIn: true },
  { name: "Old recording", eq: [-6, -2, 1, 2, 4, 5, 6], blurb: "rumble out, dull top brightened", builtIn: true },
  { name: "Bright", eq: [0, 0, 0, 1, 3, 5, 6], blurb: "air and presence", builtIn: true },
  { name: "Warm", eq: [3, 4, 2, 0, -1, -2, -3], blurb: "soften a harsh phone recording", builtIn: true },
];

export const DEFAULT_AUDIO: AudioState = {
  routing: "stereo",
  balance: 0,
  volL: 1,
  volR: 1,
  preamp: 0,
  eq: [0, 0, 0, 0, 0, 0, 0],
  compress: false,
  compressAmount: 0.5,
  multiband: false,
  highpass: null,
  lowpass: null,
  notches: [],
  denoise: false,
  denoiseAmount: 0.5,
};

export const EQ_MIN = -12, EQ_MAX = 12, PREAMP_MIN = -12, PREAMP_MAX = 18, VOL_MAX = 2;
export const PRESET_NAME_MAX = 40;
/** Clean up ranges: the high-pass (rumble) and low-pass (hiss) sliders, and a notch's place, width and depth. */
export const HP_MIN = 20, HP_MAX = 400, LP_MIN = 2000, LP_MAX = 16000;
export const NOTCH_MAX = 3, NOTCH_HZ_MIN = 30, NOTCH_HZ_MAX = 16000, NOTCH_Q_MIN = 2, NOTCH_Q_MAX = 60, NOTCH_DEPTH_MAX = 40;

/** Log-scale sliders: a 0…1 position ↔ Hz over [lo, hi]. */
export const posToHz = (p: number, lo: number, hi: number) => Math.round(lo * Math.pow(hi / lo, p));
export const hzToPos = (hz: number, lo: number, hi: number) => Math.log(hz / lo) / Math.log(hi / lo);
/** "66", "2.5k", "10k" */
export const fmtHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2).replace(/\.?0+$/, "")}k` : `${Math.round(hz)}`);

const ROUTING_KEYS = new Set<string>(ROUTINGS.map((r) => r.key));
const num = (x: unknown, lo: number, hi: number, fallback: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback);

/** A valid EQ out of anything: seven finite numbers clamped to the band range, or null. */
export function normalizeEq(x: unknown): number[] | null {
  if (!Array.isArray(x) || x.length !== BANDS.length) return null;
  if (!x.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return x.map((v: number) => Math.round(Math.min(EQ_MAX, Math.max(EQ_MIN, v)) * 10) / 10);
}

/** A cutoff out of anything: a frequency inside its range, or null (off). */
const cutoff = (x: unknown, lo: number, hi: number): number | null => (typeof x === "number" && Number.isFinite(x) ? Math.round(Math.min(hi, Math.max(lo, x))) : null);

/** The notches out of anything: well-formed ones kept and clamped, the rest dropped, at most NOTCH_MAX. */
export function normalizeNotches(x: unknown): Notch[] {
  if (!Array.isArray(x)) return [];
  const out: Notch[] = [];
  for (const n of x) {
    if (!n || typeof n !== "object" || typeof (n as Notch).hz !== "number" || !Number.isFinite((n as Notch).hz)) continue;
    const o = n as Record<string, unknown>;
    out.push({ hz: Math.round(num(o.hz, NOTCH_HZ_MIN, NOTCH_HZ_MAX, NOTCH_HZ_MIN)), q: Math.round(num(o.q, NOTCH_Q_MIN, NOTCH_Q_MAX, 30)), depth: Math.round(num(o.depth, 0, NOTCH_DEPTH_MAX, 30)), harmonics: o.harmonics === true });
    if (out.length === NOTCH_MAX) break;
  }
  return out;
}

/**
 * Settings out of anything stored or posted: every field clamped, unknown fields dropped, bad input → null. Fields a
 * stored row predates (the Clean up ones) take their defaults, so older rows keep working.
 */
export function normalizeAudio(x: unknown): AudioState | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const eq = normalizeEq(o.eq);
  if (!eq) return null;
  return {
    routing: typeof o.routing === "string" && ROUTING_KEYS.has(o.routing) ? (o.routing as Routing) : "stereo",
    balance: num(o.balance, -1, 1, 0),
    volL: num(o.volL, 0, VOL_MAX, 1),
    volR: num(o.volR, 0, VOL_MAX, 1),
    preamp: num(o.preamp, PREAMP_MIN, PREAMP_MAX, 0),
    eq,
    compress: o.compress === true,
    compressAmount: num(o.compressAmount, 0, 1, 0.5),
    multiband: o.multiband === true,
    highpass: cutoff(o.highpass, HP_MIN, HP_MAX),
    lowpass: cutoff(o.lowpass, LP_MIN, LP_MAX),
    notches: normalizeNotches(o.notches),
    denoise: o.denoise === true,
    denoiseAmount: num(o.denoiseAmount, 0, 1, 0.5),
  };
}

export const isDefaultAudio = (s: AudioState): boolean => JSON.stringify(s) === JSON.stringify(DEFAULT_AUDIO);

/** The preset whose EQ matches `eq` exactly, custom ones first (a custom copy of a built-in shows its own name). */
export function presetFor(eq: number[], presets: AudioPreset[]): AudioPreset | null {
  const same = (p: AudioPreset) => p.eq.length === eq.length && p.eq.every((v, i) => v === eq[i]);
  return presets.find((p) => !p.builtIn && same(p)) ?? presets.find((p) => p.builtIn && same(p)) ?? null;
}

/** A preset name as typed: trimmed, bounded, not a built-in's. */
export function presetNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "a preset needs a name";
  if (n.length > PRESET_NAME_MAX) return `at most ${PRESET_NAME_MAX} characters`;
  if (BUILT_IN_PRESETS.some((p) => p.name.toLowerCase() === n.toLowerCase())) return `"${n}" is a built-in preset`;
  return null;
}
