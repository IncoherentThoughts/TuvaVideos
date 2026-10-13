import { describe, expect, test } from "bun:test";
import { decodeKeyframes, encodeKeyframes, parseKeyframes } from "../src/server/keyframes";
import { KEYFRAME_LEAD, keyframeBefore, keyframeSeekTarget } from "../src/shared/playerMath";

describe("keyframe index: ffprobe packets -> stored blob (spec 4.1)", () => {
  test("keeps K-flagged packets only, by pts (dts when pts is N/A), sorted and deduplicated in ms", () => {
    const csv = ["0.000000,0.000000,K__", "0.040000,0.040000,___", "5.072000,5.072000,K_", "N/A,10.143000,K__", "5.072000,5.072000,K__", "2.5,2.5,__", "", "garbage"].join("\n");
    expect(parseKeyframes(csv)).toEqual([0, 5072, 10143]);
  });
  test("round-trips through the uint32 blob, in seconds", () => {
    const ms = [0, 5072, 10143, 4_000_000_000];
    const blob = encodeKeyframes(ms);
    expect(blob.byteLength).toBe(16);
    expect(decodeKeyframes(blob)).toEqual([0, 5.072, 10.143, 4_000_000]);
    expect(decodeKeyframes(null)).toEqual([]);
    expect(decodeKeyframes(new Uint8Array(0))).toEqual([]);
  });
});

describe("keyframe seeks: nearest keyframe, and a relative seek always moves", () => {
  const kf = [0, 5.1, 10.2, 15.3, 20.4];
  const near = (t: number, from?: number) => Math.round((keyframeSeekTarget(t, kf, from) - KEYFRAME_LEAD) * 1000) / 1000;

  test("keyframeBefore is the last keyframe at or before t", () => {
    expect(keyframeBefore(kf, -1)).toBe(-1);
    expect(keyframeBefore(kf, 0)).toBe(0);
    expect(keyframeBefore(kf, 5.1)).toBe(1);
    expect(keyframeBefore(kf, 7)).toBe(1);
    expect(keyframeBefore(kf, 99)).toBe(4);
  });
  test("an absolute seek (the bar) lands on the nearest keyframe", () => {
    expect(near(7)).toBe(5.1);
    expect(near(8)).toBe(10.2);
    expect(near(0.3)).toBe(0);
    expect(near(99)).toBe(20.4);
  });
  test("a forward step shorter than the GOP still moves to the next keyframe", () => {
    expect(near(5, 0)).toBe(5.1); // → from 0: target 5 is nearest 5.1 anyway
    expect(near(7.1, 5.1)).toBe(10.2); // nearest to 7.1 is 5.1, where we already are: next one
    expect(near(10.25, 5.25)).toBe(10.2); // from where the last snap landed (0.15 s in), a full step
    expect(near(5.5, 0.4)).toBe(5.1);
  });
  test("a backward step never stays put either", () => {
    expect(near(0.1, 5.1)).toBe(0);
    expect(near(8.2, 10.2)).toBe(5.1); // nearest to 8.2 is 10.2, where we are: the one before
    expect(near(5.35, 10.35)).toBe(5.1); // from where the last snap landed, a full step back
    expect(near(3.1, 8.1)).toBe(5.1); // mid-GOP start: the keyframe before the current one
    expect(near(-4, 1)).toBe(0);
  });
  test("past the last keyframe a forward step is exact; without an index every seek is exact", () => {
    expect(keyframeSeekTarget(25, kf, 20.4)).toBe(25);
    expect(keyframeSeekTarget(7, [], 0)).toBe(7);
    expect(keyframeSeekTarget(7, [])).toBe(7);
  });
  test("the landing time sits KEYFRAME_LEAD past the keyframe: Chromium demuxes from ~100 ms before the request", () => {
    expect(KEYFRAME_LEAD).toBeGreaterThanOrEqual(0.1);
    expect(keyframeSeekTarget(7, kf)).toBeCloseTo(5.1 + KEYFRAME_LEAD, 6);
  });
});
