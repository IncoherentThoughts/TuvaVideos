// The Auto wand (spec 4.7): Audio settings proposed from a measurement of the recording. Pure decisions over a
// Measure; the measuring (a whole-file decode or a few places through the live chain) is src/web/audioAnalyze.ts.
import { BANDS, DEFAULT_AUDIO, EQ_MAX, EQ_MIN, PREAMP_MAX, PREAMP_MIN, fmtHz, type AudioState } from "./audio";

/** What was measured about a recording. */
export interface Measure {
  /** per-channel RMS in dBFS: median over the active (non-silent) seconds / windows */
  chDb: [number, number];
  /** averaged spectrum, dB per bin (Analyser-like scale: 0 dB = full-scale sine) */
  spectrum: Float32Array;
  hzPerBin: number;
  /** a tone that was there most of the time, or null */
  tone: { hz: number; prominence: number; persistence: number } | null;
  /** how this was measured, for the report */
  how: string;
  /** whole-file pass only: the quiet floor (10th percentile of per-second RMS) and the typical level (median) */
  floorDb?: number;
  typicalDb?: number;
}

/** Bins that are local maxima at least `minDb` over the median of their ±120 Hz neighbourhood, 40 Hz…16 kHz. */
export function localPeaks(db: Float32Array, hzPerBin: number, minDb: number): { bin: number; prominence: number }[] {
  const out: { bin: number; prominence: number }[] = [];
  const lo = Math.ceil(40 / hzPerBin), hi = Math.min(db.length - 2, Math.floor(16000 / hzPerBin));
  const W = Math.max(4, Math.round(120 / hzPerBin));
  for (let i = lo; i < hi; i++) {
    const v = db[i]!;
    if (v < -90 || v < db[i - 1]! || v < db[i + 1]!) continue;
    const nb: number[] = [];
    for (let j = Math.max(1, i - W); j <= Math.min(db.length - 1, i + W); j += 2) if (Math.abs(j - i) > 2) nb.push(db[j]!);
    nb.sort((a, b) => a - b);
    const prom = v - nb[nb.length >> 1]!;
    if (prom >= minDb) out.push({ bin: i, prominence: prom });
  }
  return out;
}

/** The sharpest narrow peak of a spectrum (see localPeaks), or null when nothing stands out by `minDb`. */
export function findPeak(db: Float32Array, hzPerBin: number, minDb = 12): { hz: number; prominence: number } | null {
  let best: { bin: number; prominence: number } | null = null;
  for (const p of localPeaks(db, hzPerBin, minDb)) if (!best || p.prominence > best.prominence) best = p;
  return best && { hz: best.bin * hzPerBin, prominence: best.prominence };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const TARGET_DB = -20; // where a healthy recording's RMS sits

/** mean dB over [lo, hi) Hz of the averaged spectrum */
function bandDb(avg: Float32Array, hzPerBin: number, lo: number, hi: number): number {
  const a = Math.max(1, Math.floor(lo / hzPerBin)), b = Math.min(avg.length, Math.ceil(hi / hzPerBin));
  let s = 0, n = 0;
  for (let i = a; i < b; i++) { s += avg[i]!; n++; }
  return n ? s / n : -120;
}

/** One line of the report: a key, what was heard, what was done. Values in `did` are "name value" pairs the panel colours. */
export interface ReportRow { k: string; heard: string; did: string }

export function autoSettings(m: Measure): { audio: AudioState; report: ReportRow[] } {
  const audio: AudioState = { ...DEFAULT_AUDIO, eq: [...DEFAULT_AUDIO.eq], notches: [] };
  const report: ReportRow[] = [];
  const avg = m.spectrum;

  // --- channels: one side dead or far behind → the other in both ears; a small lean → the loud side down ---
  const [L, R] = m.chDb;
  const diff = L - R;
  if (L < -60 && R < -60) report.push({ k: "input", heard: "silence", did: "nothing to measure" });
  else if (R < -55 && L > R + 20) { audio.routing = "left"; report.push({ k: "channels", heard: "right is dead", did: "routing left" }); }
  else if (L < -55 && R > L + 20) { audio.routing = "right"; report.push({ k: "channels", heard: "left is dead", did: "routing right" }); }
  else if (Math.abs(diff) >= 12) {
    // cutting the loud side by this much would leave only the quiet one; the loud side is the recording
    audio.routing = diff > 0 ? "left" : "right";
    report.push({ k: "channels", heard: `${diff > 0 ? "left" : "right"} ${Math.abs(diff).toFixed(0)} dB louder`, did: `routing ${audio.routing}` });
  } else if (Math.abs(diff) >= 2) {
    const g = Math.pow(10, -Math.abs(diff) / 20); // bring the loud side down to the quiet one
    if (diff > 0) audio.volL = Math.round(g * 20) / 20; else audio.volR = Math.round(g * 20) / 20;
    report.push({ k: "channels", heard: `${diff > 0 ? "left" : "right"} ${Math.abs(diff).toFixed(1)} dB louder`, did: `${diff > 0 ? "left" : "right"} ${Math.round((diff > 0 ? audio.volL : audio.volR) * 100)}` });
  }

  // --- level: preamp toward the target, leveler on when the recording is quiet or lumpy ---
  const loud = audio.routing === "left" ? L : audio.routing === "right" ? R : Math.max(L, R);
  if (loud > -60) {
    const pre = Math.round(clamp(TARGET_DB - loud, PREAMP_MIN, PREAMP_MAX));
    if (Math.abs(pre) >= 2) { audio.preamp = pre; report.push({ k: "level", heard: `${loud.toFixed(0)} dBFS`, did: `preamp ${pre > 0 ? "+" : ""}${pre} dB` }); }
    if (pre >= 6) { audio.compress = true; audio.compressAmount = 0.4; report.push({ k: "leveler", heard: "quiet recording", did: "on 0.4" }); }
  }

  // --- artifacts: a dominant tone → notch (hum below 200 Hz gets harmonics); rumble → high-pass; a flat noise floor on top → low-pass ---
  const tone = m.tone;
  if (tone) {
    const hum = tone.hz < 200;
    audio.notches.push({ hz: Math.round(tone.hz), q: hum ? 30 : 20, depth: 30, harmonics: hum });
    report.push({ k: "tone", heard: `${fmtHz(tone.hz)} Hz +${Math.round(tone.prominence)} dB`, did: `notch ${fmtHz(tone.hz)} Hz${hum ? " harmonics" : ""}` });
    if (tone.persistence < 1) report.push({ k: "", heard: `present ${Math.round(tone.persistence * 100)} % of the time`, did: "" });
  }
  const sub = bandDb(avg, m.hzPerBin, 20, 60), low = bandDb(avg, m.hzPerBin, 100, 300);
  if (sub > low - 3) { audio.highpass = 80; report.push({ k: "rumble", heard: "energy under 60 Hz", did: "cut below 80 Hz" }); }
  const top = bandDb(avg, m.hzPerBin, 10000, 16000), upper = bandDb(avg, m.hzPerBin, 4000, 8000);
  if (top > upper - 6 && top > -75) { audio.lowpass = 10000; report.push({ k: "hiss", heard: "flat floor over 10 kHz", did: "cut above 10k Hz" }); }

  // --- noise: a floor that never gets far below the music → denoise, harder the closer it sits ---
  // a floor is only a *noise* floor when the quiet seconds are quiet (−65…−35 dBFS) yet not silent; a dense mix that
  // never drops below −30 says nothing about noise and is left alone
  if (m.floorDb !== undefined && m.typicalDb !== undefined && m.floorDb > -65 && m.floorDb < -35) {
    const gap = m.typicalDb - m.floorDb;
    audio.denoise = true;
    audio.denoiseAmount = Math.round(clamp((m.floorDb + 65) / 30, 0.3, 0.8) * 20) / 20;
    report.push({ k: "noise", heard: `floor ${m.floorDb.toFixed(0)} dBFS, ${gap.toFixed(0)} dB under the music`, did: `denoise ${audio.denoiseAmount}` });
  }
  // the leveler splits into bands when the recording is lumpy enough to need it hard
  if (audio.compress && audio.compressAmount >= 0.4) { audio.multiband = true; report.push({ k: "leveler", heard: "working hard", did: "per band" }); }

  // --- EQ: nudge each band halfway toward a gentle reference tilt (−3 dB/oct from 400 Hz), capped at ±6 ---
  const ref = (hz: number) => -3 * Math.log2(hz / 400);
  const measured = BANDS.map((b) => bandDb(avg, m.hzPerBin, b.hz / 1.4, b.hz * 1.4));
  const mid = measured[3]!; // 1 kHz anchors the curve
  const eq = BANDS.map((b, i) => clamp(Math.round((ref(b.hz) - ref(1000) - (measured[i]! - mid)) * 0.5), -6, 6) || 0); // `|| 0`: no −0
  if (audio.highpass) eq[0] = Math.min(eq[0]!, 0);
  if (eq.some((g) => g !== 0)) { audio.eq = eq.map((g) => clamp(g, EQ_MIN, EQ_MAX)); report.push({ k: "eq", heard: "tonal tilt", did: eq.map((g) => (g > 0 ? "+" : "") + g).join(" ") }); }

  if (!report.length) report.push({ k: "result", heard: "balanced already", did: "no change" });
  report.unshift({ k: "measured", heard: m.how, did: "" });
  return { audio, report };
}
