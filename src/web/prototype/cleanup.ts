// PROTOTYPE — throwaway. "Clean up" tools for the Audio panel: cutoffs (high/low-pass), notches for a dominant tone,
// a live spectrum with a tone finder. Lives in memory per page, never persisted. Question being answered: does this
// set of controls actually rescue the bad recordings (e.g. /play/975, /play/682), and does the spectrum + Find tone
// make the notch findable by a non-engineer? Wired into AudioEngine via `CleanupEngine.attach`.
export interface Notch { hz: number; q: number; depth: number; harmonics: boolean }
export interface Cleanup {
  highpass: number | null; // Hz, off when null
  lowpass: number | null;
  notches: Notch[];
}
export const DEFAULT_CLEANUP: Cleanup = { highpass: null, lowpass: null, notches: [] };
export const HP_MIN = 20, HP_MAX = 400, LP_MIN = 2000, LP_MAX = 16000, NOTCH_MAX = 3;

/** log-scale slider helpers: a 0…1 position ↔ Hz over [lo, hi] */
export const posToHz = (p: number, lo: number, hi: number) => Math.round(lo * Math.pow(hi / lo, p));
export const hzToPos = (hz: number, lo: number, hi: number) => Math.log(hz / lo) / Math.log(hi / lo);
export const fmtHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2).replace(/\.?0+$/, "")}k` : `${Math.round(hz)}`);

/** The Web Audio part. Sits between the channel matrix and the EQ; rebuilt in place when the settings change. */
export class CleanupEngine {
  private hp: BiquadFilterNode[];
  private lp: BiquadFilterNode[];
  private notch: BiquadFilterNode[] = [];
  private inNode: GainNode;
  private outNode: GainNode;
  private ana: AnalyserNode;
  private spectrum: Float32Array<ArrayBuffer>;
  cleanup: Cleanup = DEFAULT_CLEANUP;

  constructor(private ctx: AudioContext) {
    this.inNode = ctx.createGain();
    this.outNode = ctx.createGain();
    const mk = (type: BiquadFilterType) => { const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = 0.7071; return f; };
    this.hp = [mk("highpass"), mk("highpass")];
    this.lp = [mk("lowpass"), mk("lowpass")];
    // spectrum of the signal *before* the cleanup, so a notched tone still shows where it was (as a dip after)
    this.ana = ctx.createAnalyser();
    this.ana.fftSize = 8192;
    this.ana.smoothingTimeConstant = 0.6;
    this.spectrum = new Float32Array(this.ana.frequencyBinCount);
    this.inNode.connect(this.ana);
    this.rebuild();
  }

  get input(): AudioNode { return this.inNode; }
  get output(): AudioNode { return this.outNode; }

  private rebuild() {
    this.inNode.disconnect();
    this.inNode.connect(this.ana);
    for (const f of [...this.hp, ...this.lp, ...this.notch]) f.disconnect();
    this.notch = this.cleanup.notches.flatMap((n) => {
      const hs = n.harmonics ? [1, 2, 3] : [1];
      return hs.map((h) => {
        const f = this.ctx.createBiquadFilter();
        f.type = "peaking";
        f.frequency.value = Math.min(n.hz * h, this.ctx.sampleRate / 2 - 100);
        f.Q.value = n.q;
        f.gain.value = -n.depth;
        return f;
      });
    });
    let node: AudioNode = this.inNode;
    const chain = [...(this.cleanup.highpass ? this.hp : []), ...(this.cleanup.lowpass ? this.lp : []), ...this.notch];
    for (const f of chain) { node.connect(f); node = f; }
    node.connect(this.outNode);
  }

  set(c: Cleanup) {
    const structural = c.notches.length !== this.cleanup.notches.length
      || c.notches.some((n, i) => n.harmonics !== this.cleanup.notches[i]!.harmonics)
      || !!c.highpass !== !!this.cleanup.highpass || !!c.lowpass !== !!this.cleanup.lowpass;
    this.cleanup = c;
    if (structural) this.rebuild();
    const t = this.ctx.currentTime;
    const ramp = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, 0.02);
    if (c.highpass) for (const f of this.hp) ramp(f.frequency, c.highpass);
    if (c.lowpass) for (const f of this.lp) ramp(f.frequency, c.lowpass);
    let k = 0;
    for (const n of c.notches) for (const h of n.harmonics ? [1, 2, 3] : [1]) {
      const f = this.notch[k++]!;
      ramp(f.frequency, Math.min(n.hz * h, this.ctx.sampleRate / 2 - 100));
      ramp(f.Q, n.q);
      ramp(f.gain, -n.depth);
    }
  }

  /** dB per bin (−∞…0), plus the Hz per bin. */
  read(): { db: Float32Array; hzPerBin: number } {
    this.ana.getFloatFrequencyData(this.spectrum);
    return { db: this.spectrum, hzPerBin: this.ctx.sampleRate / this.ana.fftSize };
  }

  /**
   * The sharpest narrow peak: the bin that stands furthest above the median of its ±N neighbours, over `frames`
   * reads. Returns null when nothing stands out by `minDb`.
   */
  findTone(frames: Float32Array[], hzPerBin: number, minDb = 12): { hz: number; prominence: number } | null {
    const n = frames[0]!.length;
    const avg = new Float32Array(n);
    for (const f of frames) for (let i = 0; i < n; i++) avg[i]! += f[i]! / frames.length;
    const lo = Math.ceil(40 / hzPerBin), hi = Math.min(n - 1, Math.floor(16000 / hzPerBin));
    let best: { hz: number; prominence: number } | null = null;
    const W = Math.max(4, Math.round(120 / hzPerBin)); // neighbourhood ±120 Hz
    for (let i = lo; i < hi; i++) {
      const v = avg[i]!;
      if (v < -90 || v < avg[i - 1]! || v < avg[i + 1]!) continue;
      const nb: number[] = [];
      for (let j = Math.max(1, i - W); j <= Math.min(n - 1, i + W); j++) if (Math.abs(j - i) > 2) nb.push(avg[j]!);
      nb.sort((a, b) => a - b);
      const med = nb[nb.length >> 1]!;
      const prom = v - med;
      if (prom >= minDb && (!best || prom > best.prominence)) best = { hz: i * hzPerBin, prominence: prom };
    }
    return best;
  }
}
