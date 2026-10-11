// PROTOTYPE — throwaway. The Web Audio chain behind the Audio panel variants (AudioPanelPrototype.tsx).
//   <video> → preamp → channel matrix (L/R routing, balance, per-channel volume) → 7-band EQ → compressor → out
// One chain per <video> element (createMediaElementSource is one-shot), kept on the element itself.

export type Routing = "stereo" | "mono" | "left" | "right" | "swap";

export interface AudioState {
  routing: Routing;
  /** -1 (all left) … 0 … +1 (all right) */
  balance: number;
  /** per-channel volume 0…2 */
  volL: number;
  volR: number;
  /** dB */
  preamp: number;
  /** dB per band, same order as BANDS */
  eq: number[];
  /** "level out" the loudness */
  compress: boolean;
  compressAmount: number; // 0…1
  preset: string | null;
}

export const BANDS: { hz: number; label: string; type: BiquadFilterType }[] = [
  { hz: 60, label: "60", type: "lowshelf" },
  { hz: 150, label: "150", type: "peaking" },
  { hz: 400, label: "400", type: "peaking" },
  { hz: 1000, label: "1k", type: "peaking" },
  { hz: 2500, label: "2.5k", type: "peaking" },
  { hz: 6000, label: "6k", type: "peaking" },
  { hz: 12000, label: "12k", type: "highshelf" },
];

export const PRESETS: Record<string, { eq: number[]; blurb: string }> = {
  Flat: { eq: [0, 0, 0, 0, 0, 0, 0], blurb: "no change" },
  Voice: { eq: [-3, -4, -2, 3, 5, 3, 0], blurb: "throat and melody forward, mud cut" },
  Instruments: { eq: [4, 2, -1, -2, 1, 3, 4], blurb: "igil and doshpuluur body and bite" },
  "Old recording": { eq: [-6, -2, 1, 2, 4, 5, 6], blurb: "rumble out, dull top brightened" },
  Bright: { eq: [0, 0, 0, 1, 3, 5, 6], blurb: "air and presence" },
  Warm: { eq: [3, 4, 2, 0, -1, -2, -3], blurb: "soften a harsh phone recording" },
};

export const DEFAULT: AudioState = {
  routing: "stereo",
  balance: 0,
  volL: 1,
  volR: 1,
  preamp: 0,
  eq: [0, 0, 0, 0, 0, 0, 0],
  compress: false,
  compressAmount: 0.5,
  preset: "Flat",
};

const dbToGain = (db: number) => Math.pow(10, db / 20);

export class AudioEngine {
  readonly ctx: AudioContext;
  private pre: GainNode;
  private matrix: { LL: GainNode; LR: GainNode; RL: GainNode; RR: GainNode };
  private filters: BiquadFilterNode[];
  private comp: DynamicsCompressorNode;
  private compBypass: GainNode;
  private compWet: GainNode;
  private anaIn: [AnalyserNode, AnalyserNode];
  private anaOut: [AnalyserNode, AnalyserNode];
  state: AudioState = structuredClone(DEFAULT);
  private subs = new Set<() => void>();

  constructor(video: HTMLMediaElement) {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const src = ctx.createMediaElementSource(video);
    this.pre = ctx.createGain();
    src.connect(this.pre);

    // input meters
    const splitIn = ctx.createChannelSplitter(2);
    this.pre.connect(splitIn);
    this.anaIn = [ctx.createAnalyser(), ctx.createAnalyser()];
    splitIn.connect(this.anaIn[0], 0);
    splitIn.connect(this.anaIn[1], 1);

    // channel matrix: input channel → output channel gains
    const merge = ctx.createChannelMerger(2);
    const g = () => ctx.createGain();
    this.matrix = { LL: g(), LR: g(), RL: g(), RR: g() };
    splitIn.connect(this.matrix.LL, 0); this.matrix.LL.connect(merge, 0, 0);
    splitIn.connect(this.matrix.LR, 0); this.matrix.LR.connect(merge, 0, 1);
    splitIn.connect(this.matrix.RL, 1); this.matrix.RL.connect(merge, 0, 0);
    splitIn.connect(this.matrix.RR, 1); this.matrix.RR.connect(merge, 0, 1);

    // EQ
    this.filters = BANDS.map((b) => {
      const f = ctx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.hz;
      f.Q.value = 1;
      f.gain.value = 0;
      return f;
    });
    let node: AudioNode = merge;
    for (const f of this.filters) { node.connect(f); node = f; }

    // compressor with a dry/wet pair so it can be bypassed smoothly
    this.comp = ctx.createDynamicsCompressor();
    this.compBypass = g();
    this.compWet = g();
    node.connect(this.compBypass);
    node.connect(this.comp);
    this.comp.connect(this.compWet);
    const out = g();
    this.compBypass.connect(out);
    this.compWet.connect(out);

    // output meters
    const splitOut = ctx.createChannelSplitter(2);
    out.connect(splitOut);
    this.anaOut = [ctx.createAnalyser(), ctx.createAnalyser()];
    splitOut.connect(this.anaOut[0], 0);
    splitOut.connect(this.anaOut[1], 1);
    for (const a of [...this.anaIn, ...this.anaOut]) a.fftSize = 512;

    out.connect(ctx.destination);
    this.apply();
  }

  static for(video: HTMLMediaElement): AudioEngine {
    const v = video as HTMLMediaElement & { __tuvaAudio?: AudioEngine };
    if (!v.__tuvaAudio) v.__tuvaAudio = new AudioEngine(video);
    void v.__tuvaAudio.ctx.resume();
    return v.__tuvaAudio;
  }

  subscribe(fn: () => void) {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  set(patch: Partial<AudioState>) {
    this.state = { ...this.state, ...patch };
    if (patch.eq && !("preset" in patch)) {
      const hit = Object.entries(PRESETS).find(([, p]) => p.eq.every((v, i) => v === patch.eq![i]));
      this.state.preset = hit ? hit[0] : null;
    }
    this.apply();
    for (const fn of this.subs) fn();
  }

  applyPreset(name: string) {
    this.set({ eq: [...PRESETS[name]!.eq], preset: name });
  }

  reset() {
    this.set(structuredClone(DEFAULT));
  }

  private apply() {
    const s = this.state;
    const t = this.ctx.currentTime;
    const ramp = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, 0.02);
    ramp(this.pre.gain, dbToGain(s.preamp));

    // routing
    let LL = 0, LR = 0, RL = 0, RR = 0;
    switch (s.routing) {
      case "stereo": LL = 1; RR = 1; break;
      case "mono": LL = LR = RL = RR = 0.5; break;
      case "left": LL = LR = 1; break;
      case "right": RL = RR = 1; break;
      case "swap": LR = 1; RL = 1; break;
    }
    // balance: constant-ish power-ish, simple linear is fine for a prototype
    const balL = s.balance > 0 ? 1 - s.balance : 1;
    const balR = s.balance < 0 ? 1 + s.balance : 1;
    const outL = balL * s.volL;
    const outR = balR * s.volR;
    ramp(this.matrix.LL.gain, LL * outL);
    ramp(this.matrix.RL.gain, RL * outL);
    ramp(this.matrix.LR.gain, LR * outR);
    ramp(this.matrix.RR.gain, RR * outR);

    s.eq.forEach((db, i) => ramp(this.filters[i]!.gain, db));

    const a = s.compressAmount;
    this.comp.threshold.value = -12 - 30 * a;
    this.comp.ratio.value = 2 + 10 * a;
    this.comp.knee.value = 20;
    this.comp.attack.value = 0.01;
    this.comp.release.value = 0.25;
    ramp(this.compWet.gain, s.compress ? dbToGain(6 * a) : 0);
    ramp(this.compBypass.gain, s.compress ? 0 : 1);
  }

  /** RMS level 0…1 of each channel, before and after the chain. */
  levels(): { in: [number, number]; out: [number, number] } {
    const rms = (a: AnalyserNode) => {
      const buf = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(buf);
      let s = 0;
      for (const x of buf) s += x * x;
      return Math.min(1, Math.sqrt(s / buf.length) * 3);
    };
    return { in: [rms(this.anaIn[0]), rms(this.anaIn[1])], out: [rms(this.anaOut[0]), rms(this.anaOut[1])] };
  }

  /** The EQ's magnitude response in dB at `n` log-spaced points 30 Hz … 18 kHz. */
  response(n = 96): { hz: number; db: number }[] {
    const hz = new Float32Array(n);
    for (let i = 0; i < n; i++) hz[i] = 30 * Math.pow(18000 / 30, i / (n - 1));
    const total = new Float32Array(n);
    const mag = new Float32Array(n);
    const ph = new Float32Array(n);
    for (const f of this.filters) {
      f.getFrequencyResponse(hz, mag, ph);
      for (let i = 0; i < n; i++) total[i] += 20 * Math.log10(mag[i]! || 1e-6);
    }
    return [...hz].map((h, i) => ({ hz: h, db: total[i]! }));
  }
}

/** A guess at what is wrong, from a few seconds of input meters. */
export function diagnose(hist: { in: [number, number] }[]): { title: string; detail: string; fix: Partial<AudioState> | null; severity: "ok" | "warn" | "bad" } {
  if (hist.length < 8) return { title: "Listening…", detail: "a few seconds of playback are needed", fix: null, severity: "ok" };
  const avg = (i: 0 | 1) => hist.reduce((s, h) => s + h.in[i], 0) / hist.length;
  const L = avg(0), R = avg(1);
  if (L < 0.01 && R < 0.01) return { title: "Silence", detail: "no signal on either channel: paused, or the Copy has no audio", fix: null, severity: "warn" };
  if (R < 0.02 && L > 0.05) return { title: "Right channel is silent", detail: "all of the sound is on the left", fix: { routing: "left" }, severity: "bad" };
  if (L < 0.02 && R > 0.05) return { title: "Left channel is silent", detail: "all of the sound is on the right", fix: { routing: "right" }, severity: "bad" };
  const ratio = Math.max(L, R) / Math.max(0.001, Math.min(L, R));
  if (ratio > 2.2) return { title: `${L > R ? "Left" : "Right"} is much louder`, detail: `about ${ratio.toFixed(1)}× the other channel`, fix: { balance: L > R ? Math.min(0.7, (ratio - 1) / 3) : -Math.min(0.7, (ratio - 1) / 3) }, severity: "warn" };
  const peak = Math.max(L, R);
  if (peak < 0.08) return { title: "Quiet recording", detail: "low level overall", fix: { preamp: 8, compress: true }, severity: "warn" };
  return { title: "Channels look balanced", detail: "stereo, similar level on both sides", fix: null, severity: "ok" };
}
