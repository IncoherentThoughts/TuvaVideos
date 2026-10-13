// The Web Audio chain that applies a Video's Audio settings (spec 4.7, shared/audio.ts) to the Player's <video>:
//   <video> → preamp → channel matrix (routing, balance, per-channel volume) → 7-band EQ → leveler → speakers
// One AudioContext for the page; one chain per <video> element (createMediaElementSource is one-shot per element),
// built only when settings differ from the defaults or the panel is open, so untouched Videos never pass through it.
import { BANDS, DEFAULT_AUDIO, type AudioState } from "../shared/audio";
import { CleanupEngine } from "./prototype/cleanup"; // PROTOTYPE

let shared: AudioContext | null = null;
const context = () => (shared ??= new AudioContext());

const dbToGain = (db: number) => Math.pow(10, db / 20);

export interface Levels {
  /** RMS 0…1 per channel before the chain (what the Copy holds) and after it (what plays) */
  in: [number, number];
  out: [number, number];
}

export class AudioEngine {
  readonly ctx: AudioContext;
  private src: MediaElementAudioSourceNode;
  private pre: GainNode;
  private matrix: { LL: GainNode; LR: GainNode; RL: GainNode; RR: GainNode };
  private filters: BiquadFilterNode[];
  private comp: DynamicsCompressorNode;
  private dry: GainNode;
  private wet: GainNode;
  private out: GainNode;
  private anaIn: [AnalyserNode, AnalyserNode];
  private anaOut: [AnalyserNode, AnalyserNode];
  /** PROTOTYPE: cutoffs + notches between the matrix and the EQ */
  readonly cleanup: CleanupEngine;
  private onPlay: () => void;
  state: AudioState = DEFAULT_AUDIO;

  private constructor(private video: HTMLMediaElement) {
    const ctx = context();
    this.ctx = ctx;
    const g = () => ctx.createGain();
    this.src = ctx.createMediaElementSource(video);
    this.pre = g();
    this.src.connect(this.pre);

    const splitIn = ctx.createChannelSplitter(2);
    this.pre.connect(splitIn);
    this.anaIn = [ctx.createAnalyser(), ctx.createAnalyser()];
    splitIn.connect(this.anaIn[0], 0);
    splitIn.connect(this.anaIn[1], 1);

    // input channel → output channel gains; the routing, balance and per-channel volumes all land here
    const merge = ctx.createChannelMerger(2);
    this.matrix = { LL: g(), LR: g(), RL: g(), RR: g() };
    splitIn.connect(this.matrix.LL, 0); this.matrix.LL.connect(merge, 0, 0);
    splitIn.connect(this.matrix.LR, 0); this.matrix.LR.connect(merge, 0, 1);
    splitIn.connect(this.matrix.RL, 1); this.matrix.RL.connect(merge, 0, 0);
    splitIn.connect(this.matrix.RR, 1); this.matrix.RR.connect(merge, 0, 1);

    this.filters = BANDS.map((b) => {
      const f = ctx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.hz;
      f.Q.value = 1;
      return f;
    });
    this.cleanup = new CleanupEngine(ctx); // PROTOTYPE
    merge.connect(this.cleanup.input);
    let node: AudioNode = this.cleanup.output;
    for (const f of this.filters) { node.connect(f); node = f; }

    // the leveler: a compressor on a dry/wet pair so switching it is click-free
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 20;
    this.comp.attack.value = 0.01;
    this.comp.release.value = 0.25;
    this.dry = g();
    this.wet = g();
    this.out = g();
    node.connect(this.dry);
    node.connect(this.comp);
    this.comp.connect(this.wet);
    this.dry.connect(this.out);
    this.wet.connect(this.out);

    const splitOut = ctx.createChannelSplitter(2);
    this.out.connect(splitOut);
    this.anaOut = [ctx.createAnalyser(), ctx.createAnalyser()];
    splitOut.connect(this.anaOut[0], 0);
    splitOut.connect(this.anaOut[1], 1);
    for (const a of [...this.anaIn, ...this.anaOut]) a.fftSize = 512;

    this.out.connect(ctx.destination);
    // the context may start suspended (autoplay policy); every play is a user gesture or follows one
    this.onPlay = () => void ctx.resume();
    video.addEventListener("play", this.onPlay);
    this.set(DEFAULT_AUDIO);
  }

  /** The chain of this element, made on first use. */
  static for(video: HTMLMediaElement): AudioEngine {
    const v = video as HTMLMediaElement & { __tuvaAudio?: AudioEngine };
    v.__tuvaAudio ??= new AudioEngine(video);
    void v.__tuvaAudio.ctx.resume();
    return v.__tuvaAudio;
  }

  static has(video: HTMLMediaElement): boolean {
    return !!(video as HTMLMediaElement & { __tuvaAudio?: AudioEngine }).__tuvaAudio;
  }

  /** Unhook from the element when the Player leaves. The element is being torn down too, so nothing is reconnected. */
  dispose() {
    this.video.removeEventListener("play", this.onPlay);
    this.src.disconnect();
    this.out.disconnect();
    delete (this.video as HTMLMediaElement & { __tuvaAudio?: AudioEngine }).__tuvaAudio;
  }

  set(s: AudioState) {
    this.state = s;
    const t = this.ctx.currentTime;
    const ramp = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, 0.02);
    ramp(this.pre.gain, dbToGain(s.preamp));

    let LL = 0, LR = 0, RL = 0, RR = 0;
    switch (s.routing) {
      case "stereo": LL = 1; RR = 1; break;
      case "mono": LL = LR = RL = RR = 0.5; break;
      case "left": LL = LR = 1; break;
      case "right": RL = RR = 1; break;
      case "swap": LR = 1; RL = 1; break;
    }
    const outL = (s.balance > 0 ? 1 - s.balance : 1) * s.volL;
    const outR = (s.balance < 0 ? 1 + s.balance : 1) * s.volR;
    ramp(this.matrix.LL.gain, LL * outL);
    ramp(this.matrix.RL.gain, RL * outL);
    ramp(this.matrix.LR.gain, LR * outR);
    ramp(this.matrix.RR.gain, RR * outR);

    s.eq.forEach((db, i) => ramp(this.filters[i]!.gain, db));

    const a = s.compressAmount;
    this.comp.threshold.value = -12 - 30 * a;
    this.comp.ratio.value = 2 + 10 * a;
    ramp(this.wet.gain, s.compress ? dbToGain(6 * a) : 0); // make-up gain grows with the amount
    ramp(this.dry.gain, s.compress ? 0 : 1);
  }

  /** PROTOTYPE: raw per-channel input RMS in dBFS (before the chain) for the Auto wand. */
  inputDb(): [number, number] {
    const rms = (a: AnalyserNode) => {
      const buf = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(buf);
      let s = 0;
      for (const x of buf) s += x * x;
      return 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9);
    };
    return [rms(this.anaIn[0]), rms(this.anaIn[1])];
  }

  levels(): Levels {
    const rms = (a: AnalyserNode) => {
      const buf = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(buf);
      let s = 0;
      for (const x of buf) s += x * x;
      return Math.min(1, Math.sqrt(s / buf.length) * 3);
    };
    return { in: [rms(this.anaIn[0]), rms(this.anaIn[1])], out: [rms(this.anaOut[0]), rms(this.anaOut[1])] };
  }
}
