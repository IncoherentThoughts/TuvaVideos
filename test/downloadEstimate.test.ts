import { describe, expect, test } from "bun:test";
import { ASSUMED_THROUGHPUT_BPS, estimateSeconds, estimateVideoBytes, fitsDisk, isQuality, totalsOf } from "../src/shared/downloadEstimate";

const GB = 1e9;
describe("estimateVideoBytes", () => {
  test("ratios on a 1080 Reference", () => {
    const f = { sizeBytes: GB, durationS: 600, height: 1080 };
    expect(estimateVideoBytes(f, "720p")).toBe(0.5 * GB);
    expect(estimateVideoBytes(f, "1080p")).toBe(GB);
    expect(estimateVideoBytes(f, "best")).toBe(1.6 * GB);
  });
  test("a Reference below the target is not scaled up", () => {
    const f = { sizeBytes: GB, height: 480 };
    expect(estimateVideoBytes(f, "1080p")).toBe(GB);
    expect(estimateVideoBytes(f, "720p")).toBe(0.5 * GB);
    expect(estimateVideoBytes(f, "best")).toBe(1.6 * GB);
  });
  test("a Reference above 1080 scales by (target/height)^2", () => {
    const f = { sizeBytes: 4 * GB, height: 2160 };
    expect(estimateVideoBytes(f, "1080p")).toBe(GB);
    expect(estimateVideoBytes(f, "720p")).toBe(Math.round(4 * GB * 0.5 * (720 / 2160) ** 2));
    expect(estimateVideoBytes(f, "best")).toBe(1.6 * GB);
  });
  test("a missing height means no scaling", () => {
    expect(estimateVideoBytes({ sizeBytes: GB }, "1080p")).toBe(GB);
  });
  test("duration fallback is 2.5 Mbit/s times the ratio", () => {
    const f = { durationS: 800 };
    expect(estimateVideoBytes(f, "1080p")).toBe(250_000_000);
    expect(estimateVideoBytes(f, "720p")).toBe(125_000_000);
    expect(estimateVideoBytes(f, "best")).toBe(400_000_000);
  });
  test("the size wins over the duration", () => {
    expect(estimateVideoBytes({ sizeBytes: 10, durationS: 800 }, "1080p")).toBe(10);
  });
  test("neither, or non-positive values, give null", () => {
    expect(estimateVideoBytes({}, "1080p")).toBeNull();
    expect(estimateVideoBytes({ sizeBytes: 0, durationS: null }, "1080p")).toBeNull();
    expect(estimateVideoBytes({ sizeBytes: null, durationS: -1 }, "best")).toBeNull();
    expect(estimateVideoBytes({ sizeBytes: 0, durationS: 8 }, "1080p")).toBe(2_500_000);
  });
});

describe("totals", () => {
  test("sums the known, counts the unknown, divides by throughput", () => {
    const t = totalsOf([2e9, null, 4e9, null], ASSUMED_THROUGHPUT_BPS);
    expect(t).toEqual({ count: 4, estBytes: 6e9, withoutEstimate: 2, estSeconds: 3000 });
  });
  test("empty and all-unknown", () => {
    expect(totalsOf([], 1)).toEqual({ count: 0, estBytes: 0, withoutEstimate: 0, estSeconds: 0 });
    expect(totalsOf([null], 1)).toEqual({ count: 1, estBytes: 0, withoutEstimate: 1, estSeconds: 0 });
  });
  test("time guards a bad rate", () => {
    expect(estimateSeconds(100, 0)).toBe(0);
    expect(estimateSeconds(100, 10)).toBe(10);
  });
});

test("fitsDisk applies the 1.1 margin and tolerates unknown free space", () => {
  expect(fitsDisk(100, 110)).toBe(true);
  expect(fitsDisk(100, 109)).toBe(false);
  expect(fitsDisk(100, null)).toBe(true);
});
test("isQuality", () => {
  expect(isQuality("best")).toBe(true);
  expect(isQuality("4k")).toBe(false);
});
