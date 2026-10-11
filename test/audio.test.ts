import { describe, expect, test } from "bun:test";
import { BUILT_IN_PRESETS, DEFAULT_AUDIO, isDefaultAudio, normalizeAudio, normalizeEq, presetFor, presetNameError } from "../src/shared/audio";

describe("audio settings: normalize", () => {
  test("the defaults round-trip and count as default", () => {
    expect(normalizeAudio(DEFAULT_AUDIO)).toEqual(DEFAULT_AUDIO);
    expect(isDefaultAudio(normalizeAudio(DEFAULT_AUDIO)!)).toBe(true);
    expect(isDefaultAudio({ ...DEFAULT_AUDIO, routing: "left" })).toBe(false);
  });
  test("every field is clamped, unknown fields dropped, bad routing falls back", () => {
    const s = normalizeAudio({ routing: "quad", balance: 7, volL: -1, volR: 9, preamp: 99, eq: [20, -20, 0, 0, 0, 0, 0.26], compress: "yes", compressAmount: 2, extra: 1 })!;
    expect(s).toEqual({ routing: "stereo", balance: 1, volL: 0, volR: 2, preamp: 18, eq: [12, -12, 0, 0, 0, 0, 0.3], compress: false, compressAmount: 1 });
    expect("extra" in s).toBe(false);
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
