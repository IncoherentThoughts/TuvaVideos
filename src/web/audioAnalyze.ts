// Two ways to measure a recording for the Auto wand (spec 4.7); both produce a Measure for shared/audioAuto.ts:
//   analyzeFull    streams the Copy's whole audio track (GET /copy/:id/pcm) and folds it as it arrives: per-second
//                  channel levels, a Welch spectrum, and how persistently each bin is a peak. Nothing is held in memory.
//   analyzeSampled seeks the Player to a few spread-out places and listens through the live analysers.
import { findPeak, localPeaks, type Measure } from "../shared/audioAuto";
import type { AudioEngine } from "./audioEngine";

const median = (xs: number[]) => {
  if (!xs.length) return -120;
  const a = [...xs].sort((p, q) => p - q);
  return a[a.length >> 1]!;
};

// ---- a plain radix-2 FFT, real input, N = 8192 ----
const N = 8192;
const hann = new Float32Array(N);
for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
const hannGain = hann.reduce((a, b) => a + b, 0) / N; // coherent gain, to keep the dB scale like the Analyser's
const rev = new Uint16Array(N);
for (let i = 0, bits = Math.log2(N); i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
const cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2);
for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos((2 * Math.PI * i) / N); sinT[i] = -Math.sin((2 * Math.PI * i) / N); }
const re = new Float32Array(N), im = new Float32Array(N);

/** dB per bin (N/2 bins) of one windowed frame. */
function spectrumDb(frame: Float32Array, out: Float32Array) {
  for (let i = 0; i < N; i++) { re[rev[i]!] = frame[i]! * hann[i]!; im[rev[i]!] = 0; }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const i = start + k, j = i + half;
        const tr = re[j]! * cosT[t]! - im[j]! * sinT[t]!, ti = re[j]! * sinT[t]! + im[j]! * cosT[t]!;
        re[j] = re[i]! - tr; im[j] = im[i]! - ti; re[i]! += tr; im[i]! += ti;
      }
    }
  }
  const norm = 2 / (N * hannGain); // a full-scale sine → 0 dB
  for (let i = 0; i < N / 2; i++) out[i] = 20 * Math.log10(Math.hypot(re[i]!, im[i]!) * norm + 1e-12);
}

// ---- full file ----
export async function analyzeFull(copyId: number, onProgress: (frac: number) => void, durationS: number | null, signal?: AbortSignal): Promise<Measure> {
  const res = await fetch(`/copy/${copyId}/pcm`, { signal });
  if (!res.ok || !res.body) throw new Error(`pcm: ${res.status}`);
  const rate = Number(res.headers.get("x-sample-rate") ?? 32000);
  const hzPerBin = rate / N;
  const bins = N / 2;
  const sum = new Float64Array(bins), frameDb = new Float32Array(bins), peakCount = new Float64Array(bins), peakProm = new Float64Array(bins);
  let frames = 0;
  const secL: number[] = [], secR: number[] = [];
  // per-second RMS accumulators
  let sL = 0, sR = 0, sn = 0;
  // the mono frame being filled for the FFT (hop = N, no overlap: plenty of frames in a whole file)
  const monoFrame = new Float32Array(N);
  let fill = 0;
  let carry = new Uint8Array(0);
  let samples = 0;
  const reader = res.body.getReader();
  const foldFrame = () => {
    spectrumDb(monoFrame, frameDb);
    for (let i = 0; i < bins; i++) sum[i]! += frameDb[i]!;
    // persistent-peak bookkeeping: which bins stand ≥ 10 dB over their ±120 Hz neighbourhood in this frame
    const peaks = localPeaks(frameDb, hzPerBin, 10);
    for (const p of peaks) { peakCount[p.bin]! += 1; peakProm[p.bin]! += p.prominence; }
    frames++;
    fill = 0;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let buf = value;
    if (carry.length) { const j = new Uint8Array(carry.length + value.length); j.set(carry); j.set(value, carry.length); buf = j; carry = new Uint8Array(0); }
    const usable = buf.length - (buf.length % 4);
    if (usable < buf.length) carry = buf.slice(usable);
    const view = new DataView(buf.buffer, buf.byteOffset, usable);
    for (let o = 0; o < usable; o += 4) {
      const l = view.getInt16(o, true) / 32768, r = view.getInt16(o + 2, true) / 32768;
      sL += l * l; sR += r * r; sn++;
      if (sn === rate) { secL.push(10 * Math.log10(sL / sn + 1e-12)); secR.push(10 * Math.log10(sR / sn + 1e-12)); sL = sR = 0; sn = 0; }
      monoFrame[fill++] = (l + r) / 2;
      if (fill === N) foldFrame();
      samples++;
    }
    if (durationS) onProgress(Math.min(1, samples / rate / durationS));
  }
  if (!frames) throw new Error("no audio");
  const spectrum = new Float32Array(bins);
  for (let i = 0; i < bins; i++) spectrum[i] = sum[i]! / frames;
  const active = (xs: number[]) => xs.filter((d) => d > -50);
  const chDb: [number, number] = [median(active(secL).length ? active(secL) : secL), median(active(secR).length ? active(secR) : secR)];
  // the tone: the bin that was a peak in the largest share of frames (≥ 50 %), ±1 bin pooled
  let tone: Measure["tone"] = null;
  for (let i = 1; i < bins - 1; i++) {
    const c = peakCount[i - 1]! + peakCount[i]! + peakCount[i + 1]!;
    const persistence = c / frames;
    if (persistence >= 0.5) {
      const prom = (peakProm[i - 1]! + peakProm[i]! + peakProm[i + 1]!) / c;
      if (!tone || persistence * prom > tone.persistence * tone.prominence) tone = { hz: i * hzPerBin, prominence: prom, persistence };
    }
  }
  const mono = secL.map((l, i) => Math.max(l, secR[i] ?? -120)).sort((a, b) => a - b);
  const floorDb = mono[Math.floor(mono.length * 0.1)] ?? -120, typicalDb = mono[mono.length >> 1] ?? -120;
  return { chDb, spectrum, hzPerBin, tone, how: `whole file, ${Math.round(samples / rate)} s`, floorDb, typicalDb };
}

// ---- sampled: a few spread-out places through the live chain ----
export interface SampleOpts { places?: number; perPlaceMs?: number }

export async function analyzeSampled(video: HTMLMediaElement, engine: AudioEngine, onProgress: (frac: number) => void, opts: SampleOpts = {}): Promise<Measure> {
  const places = opts.places ?? 5, perPlaceMs = opts.perPlaceMs ?? 1200;
  const dur = Number.isFinite(video.duration) ? video.duration : 0;
  const was = { t: video.currentTime, paused: video.paused };
  const margin = Math.min(20, Math.max(3, dur * 0.05));
  const span = Math.max(0, dur - 2 * margin);
  const positions = dur > 10
    ? Array.from({ length: places }, (_, i) => margin + (span * (i + 0.5)) / places + (Math.random() - 0.5) * (span / places) * 0.6)
    : [video.currentTime];
  engine.mute(true);
  engine.measuring = true; // the A-B loop would drag every seek back inside it
  if (video.paused) void video.play();
  const windows: { chDb: [number, number]; frames: Float32Array[] }[] = [];
  let hzPerBin = 0;
  try {
    for (let w = 0; w < positions.length; w++) {
      await seekAndSettle(video, positions[w]!);
      const sums: [number, number] = [0, 0];
      const frames: Float32Array[] = [];
      const n = Math.max(4, Math.round(perPlaceMs / 80));
      for (let i = 0; i < n; i++) {
        await new Promise((r) => setTimeout(r, 80));
        const [l, r] = engine.inputDb();
        sums[0] += l; sums[1] += r;
        const sp = engine.cleanup.read();
        frames.push(Float32Array.from(sp.db));
        hzPerBin = sp.hzPerBin;
      }
      windows.push({ chDb: [sums[0] / n, sums[1] / n], frames });
      onProgress((w + 1) / positions.length);
    }
  } finally {
    engine.measuring = false;
    video.currentTime = was.t;
    engine.mute(false);
    if (was.paused) video.pause();
  }
  const bins = windows[0]!.frames[0]!.length;
  const spectrum = new Float32Array(bins);
  let count = 0;
  for (const w of windows) for (const f of w.frames) { for (let i = 0; i < bins; i++) spectrum[i]! += f[i]!; count++; }
  for (let i = 0; i < bins; i++) spectrum[i]! /= count;
  // a place that was still seeking reads as silence on both sides; it says nothing about the channels
  const heard = windows.filter((w) => Math.max(...w.chDb) > -60);
  const lv = heard.length ? heard : windows;
  const chDb: [number, number] = [median(lv.map((w) => w.chDb[0])), median(lv.map((w) => w.chDb[1]))];
  // a tone must be the top peak, at the same frequency (±2 %), in at least half the places
  const tops = windows.map((w) => {
    const avg = new Float32Array(bins);
    for (const f of w.frames) for (let i = 0; i < bins; i++) avg[i]! += f[i]! / w.frames.length;
    return findPeak(avg, hzPerBin, 12);
  }).filter((t): t is { hz: number; prominence: number } => !!t);
  let tone: Measure["tone"] = null;
  for (const t of tops) {
    const group = tops.filter((u) => Math.abs(u.hz - t.hz) / t.hz < 0.02);
    const persistence = group.length / windows.length;
    if (persistence >= 0.5) {
      const prom = group.reduce((a, u) => a + u.prominence, 0) / group.length;
      if (!tone || persistence * prom > tone.persistence * tone.prominence) tone = { hz: t.hz, prominence: prom, persistence };
    }
  }
  return { chDb, spectrum, hzPerBin, tone, how: `${positions.length} places, ${fmtT(positions[0]!)}–${fmtT(positions[positions.length - 1]!)}` };
}

const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function seekAndSettle(video: HTMLMediaElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; video.removeEventListener("seeked", onSeeked); setTimeout(resolve, 300); } };
    const onSeeked = () => finish();
    video.addEventListener("seeked", onSeeked);
    video.currentTime = t;
    setTimeout(finish, 2000); // an unbuffered seek on a big file: give up waiting and use what plays
  });
}
