// The Clean up part of the Web Audio chain (spec 4.7): cutoffs (two cascaded biquads each, 24 dB/oct), up to three
// notches (peaking cuts, with 2× and 3× harmonics for hum) and the spectral denoise worklet on a dry/wet pair, between
// the channel matrix and the EQ. Also the spectrum the panel draws and the tone finder behind "Find tone".
import { DEFAULT_AUDIO, type AudioState } from "../shared/audio";
import { findPeak } from "../shared/audioAuto";
import { DENOISE_WORKLET_SRC } from "./denoiseWorklet";

const workletReady = new WeakMap<AudioContext, Promise<void>>();
const loadWorklet = (ctx: AudioContext) => {
  let p = workletReady.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([DENOISE_WORKLET_SRC], { type: "application/javascript" }));
    p = ctx.audioWorklet.addModule(url);
    workletReady.set(ctx, p);
  }
  return p;
};

export class CleanupEngine {
  private hp: BiquadFilterNode[];
  private lp: BiquadFilterNode[];
  private notch: BiquadFilterNode[] = [];
  private inNode: GainNode;
  private outNode: GainNode;
  private ana: AnalyserNode;
  private spectrum: Float32Array<ArrayBuffer>;
  private tail: GainNode;
  private dnDry: GainNode;
  private dnWet: GainNode;
  private dn: AudioWorkletNode | null = null;
  /** "auto" (tracked floor), "learning", or "learned"; the panel shows it */
  denoiseMode: "auto" | "learning" | "learned" = "auto";
  onDenoiseMode: ((m: CleanupEngine["denoiseMode"]) => void) | null = null;
  private state: AudioState = DEFAULT_AUDIO;

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
    // the denoise sits at the end of the chain on a dry/wet pair; the worklet joins when its module has loaded
    this.tail = ctx.createGain();
    this.dnDry = ctx.createGain();
    this.dnWet = ctx.createGain();
    this.dnWet.gain.value = 0;
    this.tail.connect(this.dnDry); this.dnDry.connect(this.outNode);
    this.dnWet.connect(this.outNode);
    this.rebuild();
  }

  /** The worklet, made the first time the denoise is switched on (it costs an FFT per block while it exists). */
  private dnLoading: Promise<void> | null = null;
  private ensureDenoise() {
    this.dnLoading ??= loadWorklet(this.ctx).then(() => {
      this.dn = new AudioWorkletNode(this.ctx, "tuva-denoise", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.dn.port.onmessage = (e) => { if (e.data?.type === "learned") { this.denoiseMode = "learned"; this.onDenoiseMode?.("learned"); } };
      this.tail.connect(this.dn); this.dn.connect(this.dnWet);
      this.set(this.state);
    }).catch((e) => console.warn("denoise worklet failed", e));
  }

  /** Learn the noise profile from the next ~second of sound (play a gap or a pause). */
  learnNoise() {
    if (!this.dn) return;
    this.denoiseMode = "learning"; this.onDenoiseMode?.("learning");
    this.dn.port.postMessage({ type: "learn", frames: Math.round(this.ctx.sampleRate / 512) });
  }
  /** Back to the tracked floor. */
  autoNoise() {
    this.dn?.port.postMessage({ type: "auto" });
    this.denoiseMode = "auto"; this.onDenoiseMode?.("auto");
  }

  get input(): AudioNode { return this.inNode; }
  get output(): AudioNode { return this.outNode; }

  private rebuild() {
    this.inNode.disconnect();
    this.inNode.connect(this.ana);
    for (const f of [...this.hp, ...this.lp, ...this.notch]) f.disconnect();
    this.tail.disconnect();
    this.tail.connect(this.dnDry);
    if (this.dn) this.tail.connect(this.dn);
    this.notch = this.state.notches.flatMap((n) => {
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
    const chain = [...(this.state.highpass ? this.hp : []), ...(this.state.lowpass ? this.lp : []), ...this.notch];
    for (const f of chain) { node.connect(f); node = f; }
    node.connect(this.tail);
  }

  /** Apply the Clean up fields of the settings; the graph is rebuilt only when a filter joins or leaves. */
  set(c: AudioState) {
    const prev = this.state;
    const structural = c.notches.length !== prev.notches.length
      || c.notches.some((n, i) => n.harmonics !== prev.notches[i]!.harmonics)
      || !!c.highpass !== !!prev.highpass || !!c.lowpass !== !!prev.lowpass;
    this.state = c;
    if (structural) this.rebuild();
    if (c.denoise) this.ensureDenoise();
    const t = this.ctx.currentTime;
    const ramp = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, 0.02);
    if (c.highpass) for (const f of this.hp) ramp(f.frequency, c.highpass);
    if (c.lowpass) for (const f of this.lp) ramp(f.frequency, c.lowpass);
    const on = c.denoise && !!this.dn;
    ramp(this.dnWet.gain, on ? 1 : 0);
    ramp(this.dnDry.gain, on ? 0 : 1);
    if (this.dn) ramp(this.dn.parameters.get("amount")!, c.denoiseAmount);
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

  /** The sharpest narrow peak over `frames` (see findPeak). */
  findTone(frames: Float32Array[], hzPerBin: number, minDb = 12): { hz: number; prominence: number } | null {
    const n = frames[0]!.length;
    const avg = new Float32Array(n);
    for (const f of frames) for (let i = 0; i < n; i++) avg[i]! += f[i]! / frames.length;
    return findPeak(avg, hzPerBin, minDb);
  }
}

