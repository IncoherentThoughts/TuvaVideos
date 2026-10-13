import { describe, expect, test } from "bun:test";
import { BUILT_IN_PRESETS, DEFAULT_AUDIO, fmtHz, hzToPos, isDefaultAudio, normalizeAudio, normalizeEq, normalizeNotches, posToHz, presetFor, presetNameError } from "../src/shared/audio";
import { autoSettings, findPeak, type Measure } from "../src/shared/audioAuto";

describe("audio settings: normalize", () => {
  test("the defaults round-trip and count as default", () => {
    expect(normalizeAudio(DEFAULT_AUDIO)).toEqual(DEFAULT_AUDIO);
    expect(isDefaultAudio(normalizeAudio(DEFAULT_AUDIO)!)).toBe(true);
    expect(isDefaultAudio({ ...DEFAULT_AUDIO, routing: "left" })).toBe(false);
  });
  test("every field is clamped, unknown fields dropped, bad routing falls back", () => {
    const s = normalizeAudio({ routing: "quad", balance: 7, volL: -1, volR: 9, preamp: 99, eq: [20, -20, 0, 0, 0, 0, 0.26], compress: "yes", compressAmount: 2, extra: 1 })!;
    expect(s).toEqual({ ...DEFAULT_AUDIO, routing: "stereo", balance: 1, volL: 0, volR: 2, preamp: 18, eq: [12, -12, 0, 0, 0, 0, 0.3], compress: false, compressAmount: 1 });
    expect("extra" in s).toBe(false);
  });
  test("a row from before Clean up takes the Clean up defaults", () => {
    const old = { routing: "left", balance: 0, volL: 1, volR: 1, preamp: 6, eq: [0, 0, 0, 0, 0, 0, 0], compress: true, compressAmount: 0.5 };
    expect(normalizeAudio(old)).toEqual({ ...DEFAULT_AUDIO, routing: "left", preamp: 6, compress: true });
  });
  test("clean up: cutoffs clamp to their sliders or switch off, notches are bounded and capped at three", () => {
    const s = normalizeAudio({ ...DEFAULT_AUDIO, highpass: 5, lowpass: "x", denoise: true, denoiseAmount: 3, multiband: 1, notches: [{ hz: 66.4, q: 999, depth: -5, harmonics: true }, { hz: "60" }, {}, { hz: 1000 }, { hz: 2000 }, { hz: 3000 }] })!;
    expect(s.highpass).toBe(20);
    expect(s.lowpass).toBeNull();
    expect(s.denoise).toBe(true);
    expect(s.denoiseAmount).toBe(1);
    expect(s.multiband).toBe(false);
    expect(s.notches).toEqual([{ hz: 66, q: 60, depth: 0, harmonics: true }, { hz: 1000, q: 30, depth: 30, harmonics: false }, { hz: 2000, q: 30, depth: 30, harmonics: false }]);
    expect(normalizeNotches("no")).toEqual([]);
  });
  test("log sliders round-trip and Hz format", () => {
    expect(posToHz(0, 20, 400)).toBe(20);
    expect(posToHz(1, 20, 400)).toBe(400);
    expect(posToHz(hzToPos(80, 20, 400), 20, 400)).toBe(80);
    expect([fmtHz(66.4), fmtHz(2500), fmtHz(10000), fmtHz(16000)]).toEqual(["66", "2.5k", "10k", "16k"]);
  });
  test("no eq, a short eq or a non-numeric eq is no settings at all", () => {
    expect(normalizeAudio({})).toBeNull();
    expect(normalizeAudio({ eq: [0, 0, 0] })).toBeNull();
    expect(normalizeAudio({ eq: [0, 0, 0, 0, 0, 0, "x"] })).toBeNull();
    expect(normalizeAudio(null)).toBeNull();
    expect(normalizeAudio("eq")).toBeNull();
    expect(normalizeEq([1, 2, 3, 4, 5, 6, 7])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("audio presets", () => {
  test("presetFor matches exactly and prefers a custom name over a built-in copy", () => {
    const voice = BUILT_IN_PRESETS.find((p) => p.name === "Voice")!;
    expect(presetFor(voice.eq, BUILT_IN_PRESETS)?.name).toBe("Voice");
    expect(presetFor([...voice.eq.slice(0, 6), 1], BUILT_IN_PRESETS)).toBeNull();
    const mine = { name: "Mine", eq: [...voice.eq], builtIn: false };
    expect(presetFor(voice.eq, [...BUILT_IN_PRESETS, mine])?.name).toBe("Mine");
  });
  test("names: trimmed, bounded, built-ins reserved case-insensitively", () => {
    expect(presetNameError("  ")).toMatch(/name/);
    expect(presetNameError("voice")).toMatch(/built-in/);
    expect(presetNameError("x".repeat(41))).toMatch(/40/);
    expect(presetNameError(" Концерт ")).toBeNull();
  });
});

// A spectrum on the Analyser's scale, shaped like a healthy recording: `level` dB at 1 kHz, `tilt` dB per octave
// (−3 is the reference the EQ rule nudges toward), nothing under 35 Hz, plus narrow peaks.
const spectrum = (hzPerBin: number, bins: number, level: number, peaks: [number, number][] = [], tilt = -3): Float32Array => {
  const out = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const hz = Math.max(1, i * hzPerBin);
    out[i] = level + tilt * Math.log2(hz / 1000) - (hz < 35 ? 45 : 0);
  }
  for (const [hz, db] of peaks) out[Math.round(hz / hzPerBin)] = db;
  return out;
};
const HZ = 32000 / 8192;
const measure = (over: Partial<Measure> = {}): Measure => ({ chDb: [-20, -20], spectrum: spectrum(HZ, 4096, -66), hzPerBin: HZ, tone: null, how: "test", ...over });

describe("audio auto", () => {
  test("findPeak: the sharpest narrow peak over its neighbourhood, nothing when the spectrum is smooth", () => {
    expect(findPeak(spectrum(HZ, 4096, -66), HZ)).toBeNull();
    const p = findPeak(spectrum(HZ, 4096, -66, [[66, -24], [1000, -50]]), HZ)!;
    expect(Math.round(p.hz)).toBe(66);
    expect(p.prominence).toBeGreaterThan(25);
  });
  test("a healthy recording is left alone", () => {
    const r = autoSettings(measure());
    expect(r.audio).toEqual(DEFAULT_AUDIO);
    expect(r.report.map((x) => x.k)).toEqual(["measured", "result"]);
  });
  test("a dead right channel routes left; a lean turns the loud side down", () => {
    expect(autoSettings(measure({ chDb: [-20, -70] })).audio.routing).toBe("left");
    expect(autoSettings(measure({ chDb: [-70, -20] })).audio.routing).toBe("right");
    const lean = autoSettings(measure({ chDb: [-20, -26] })).audio;
    expect(lean.routing).toBe("stereo");
    expect(lean.volL).toBe(0.5);
    expect(lean.volR).toBe(1);
  });
  test("a side far behind the other is not worth keeping: the loud side goes to both ears, nothing is cut", () => {
    const a = autoSettings(measure({ chDb: [-46, -20] })).audio;
    expect(a.routing).toBe("right");
    expect([a.volL, a.volR]).toEqual([1, 1]);
    expect(a.preamp).toBe(0);
  });
  test("a quiet recording gets preamp toward −20 dBFS and the leveler, per band when it works hard", () => {
    const a = autoSettings(measure({ chDb: [-34, -34] })).audio;
    expect(a.preamp).toBe(14);
    expect(a.compress).toBe(true);
    expect(a.multiband).toBe(true);
    expect(autoSettings(measure({ chDb: [-23, -23] })).audio).toMatchObject({ preamp: 3, compress: false, multiband: false });
    expect(autoSettings(measure({ chDb: [-5, -5] })).audio.preamp).toBe(-12);
  });
  test("a tone becomes a notch, with harmonics when it is hum", () => {
    const hum = autoSettings(measure({ tone: { hz: 66, prominence: 28, persistence: 0.62 } }));
    expect(hum.audio.notches).toEqual([{ hz: 66, q: 30, depth: 30, harmonics: true }]);
    expect(hum.report.find((r) => r.k === "tone")?.did).toBe("notch 66 Hz harmonics");
    expect(hum.report.some((r) => r.heard === "present 62 % of the time")).toBe(true);
    const whine = autoSettings(measure({ tone: { hz: 4100, prominence: 15, persistence: 1 } }));
    expect(whine.audio.notches).toEqual([{ hz: 4100, q: 20, depth: 30, harmonics: false }]);
  });
  test("rumble under 60 Hz → high-pass at 80; a flat floor over 10 kHz → low-pass at 10k", () => {
    const rumble = spectrum(HZ, 4096, -66);
    for (let i = 0; i * HZ < 60; i++) rumble[i] = -45;
    expect(autoSettings(measure({ spectrum: rumble })).audio.highpass).toBe(80);
    const hiss = spectrum(HZ, 4096, -66);
    for (let i = Math.ceil(10000 / HZ); i < 4096; i++) hiss[i] = -70;
    expect(autoSettings(measure({ spectrum: hiss })).audio.lowpass).toBe(10000);
    expect(autoSettings(measure()).audio).toMatchObject({ highpass: null, lowpass: null });
  });
  test("a noise floor in the quiet seconds switches the denoise on, scaled; a dense mix does not", () => {
    const noisy = autoSettings(measure({ floorDb: -50, typicalDb: -20 })).audio;
    expect(noisy.denoise).toBe(true);
    expect(noisy.denoiseAmount).toBe(0.5);
    expect(autoSettings(measure({ floorDb: -40, typicalDb: -20 })).audio.denoiseAmount).toBe(0.8);
    expect(autoSettings(measure({ floorDb: -22, typicalDb: -15 })).audio.denoise).toBe(false);
    expect(autoSettings(measure({ floorDb: -80, typicalDb: -20 })).audio.denoise).toBe(false);
    expect(autoSettings(measure()).audio.denoise).toBe(false);
  });
  test("a dull recording gets a tilt nudge, capped at ±6 and never boosting the bass under a high-pass", () => {
    const dull = autoSettings(measure({ spectrum: spectrum(HZ, 4096, -50, [], -9) })).audio;
    expect(dull.eq[6]).toBeGreaterThan(0);
    expect(dull.eq[0]).toBeLessThan(0);
    expect(Math.max(...dull.eq.map(Math.abs))).toBeLessThanOrEqual(6);
  });
});
