// The spectral denoise AudioWorklet (spec 4.7, Clean up): STFT (N = 1024, hop 512, sqrt-Hann both sides), a noise
// power profile per bin, spectral subtraction with a floor, and gain smoothing against musical noise. The profile is
// either tracked automatically (a running minimum that rises slowly, so pauses and gaps set it) or learned from a
// stretch the user marks. Served as a Blob URL since the UI bundle is one file.
export const DENOISE_WORKLET_SRC = String.raw`
const N = 1024, H = 512, BINS = N / 2 + 1;
const win = new Float32Array(N);
for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
const rev = new Uint16Array(N);
for (let i = 0, bits = 10; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
const cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2);
for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / N); sinT[i] = Math.sin(2 * Math.PI * i / N); }
function fft(re, im, inverse) {
  for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let start = 0; start < N; start += size) for (let k = 0, t = 0; k < half; k++, t += step) {
      const i = start + k, j = i + half, c = cosT[t], s = sgn * sinT[t];
      const tr = re[j] * c - im[j] * s, ti = re[j] * s + im[j] * c;
      re[j] = re[i] - tr; im[j] = im[i] - ti; re[i] += tr; im[i] += ti;
    }
  }
  if (inverse) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
}
class Channel {
  constructor() {
    this.fifo = new Float32Array(N); this.filled = 0; this.since = 0;
    this.oring = new Float32Array(2 * N); this.wpos = 0; this.rpos = 0;
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.psm = new Float32Array(BINS); this.noise = new Float32Array(BINS).fill(-1); this.g = new Float32Array(BINS).fill(1);
    this.acc = new Float32Array(BINS); this.accN = 0;
  }
}
class Denoise extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: "amount", defaultValue: 0.5, minValue: 0, maxValue: 1 }]; }
  constructor() {
    super();
    this.ch = [new Channel(), new Channel()];
    this.mode = "auto"; this.learnLeft = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "learn") { this.learnLeft = m.frames; for (const c of this.ch) { c.acc.fill(0); c.accN = 0; } this.mode = "learning"; }
      if (m.type === "auto") { this.mode = "auto"; for (const c of this.ch) c.noise.fill(-1); }
    };
  }
  frame(c, amount) {
    const re = c.re, im = c.im;
    for (let i = 0; i < N; i++) { re[i] = c.fifo[i] * win[i]; im[i] = 0; }
    fft(re, im, false);
    const over = 1 + 2 * amount, floor = Math.pow(10, -(4 + 26 * amount) / 20);
    for (let k = 0; k < BINS; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      c.psm[k] = 0.7 * c.psm[k] + 0.3 * p;
      if (this.mode === "learning") { c.acc[k] += p; }
      else if (this.mode === "auto") { c.noise[k] = c.noise[k] < 0 ? c.psm[k] : Math.min(c.psm[k], c.noise[k] * 1.015 + 1e-12); }
      const nz = c.noise[k] < 0 ? 0 : c.noise[k] * (this.mode === "auto" ? 2.5 : 1);
      let g = p > 0 ? Math.sqrt(Math.max(0, 1 - over * nz / p)) : 1;
      if (g < floor) g = floor;
      c.g[k] = g > c.g[k] ? 0.6 * c.g[k] + 0.4 * g : 0.85 * c.g[k] + 0.15 * g;
      const gg = c.g[k];
      re[k] *= gg; im[k] *= gg;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    if (this.mode === "learning") { c.accN++; }
    fft(re, im, true);
    for (let i = 0; i < N; i++) c.oring[(c.wpos + i) % (2 * N)] += re[i] * win[i];
    c.wpos = (c.wpos + H) % (2 * N);
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const amount = params.amount[0];
    const nch = Math.min(2, inp.length, out.length);
    for (let ci = 0; ci < nch; ci++) {
      const c = this.ch[ci], x = inp[ci], y = out[ci], q = x.length;
      c.fifo.copyWithin(0, q); c.fifo.set(x, N - q);
      c.filled = Math.min(N, c.filled + q); c.since += q;
      if (c.filled >= N && c.since >= H) { this.frame(c, amount); c.since -= H; }
      for (let i = 0; i < q; i++) { const p = (c.rpos + i) % (2 * N); y[i] = c.oring[p]; c.oring[p] = 0; }
      c.rpos = (c.rpos + q) % (2 * N);
    }
    if (this.mode === "learning" && this.ch[0].accN >= this.learnLeft) {
      for (const c of this.ch) { if (c.accN) for (let k = 0; k < BINS; k++) c.noise[k] = c.acc[k] / c.accN; }
      this.mode = "learned";
      this.port.postMessage({ type: "learned" });
    }
    return true;
  }
}
registerProcessor("tuva-denoise", Denoise);
`;
