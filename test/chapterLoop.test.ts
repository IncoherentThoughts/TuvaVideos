import { describe, expect, test } from "bun:test";
import { keyAction } from "../src/shared/keymap";
import { abLoopTarget, chapterAtTime, chapterLoopSpan } from "../src/shared/playerMath";

const chs = [
  { id: "c2", startS: 300 },
  { id: "c1", startS: 0 },
  { id: "c3", startS: 620 },
];
const key = (c: { id: string }) => c.id;

describe("Chapter loop", () => {
  test("L toggles it; l stays the A-B loop", () => {
    expect(keyAction({ key: "L", shiftKey: true })).toEqual({ type: "chapterLoop" });
    expect(keyAction({ key: "l" })).toEqual({ type: "abLoop" });
  });

  test("the span runs to the next Chapter's start, the last one to the Video's end", () => {
    expect(chapterLoopSpan(chs, key, "c2", 900)).toMatchObject({ a: 300, b: 620 });
    expect(chapterLoopSpan(chs, key, "c3", 900)).toMatchObject({ a: 620, b: 900 });
    expect(chapterLoopSpan(chs, key, "c3", null)?.b).toBe(Infinity);
    expect(chapterLoopSpan(chs, key, "gone", 900)).toBeNull();
  });

  test("the Chapter the playhead is in", () => {
    expect(chapterAtTime(chs, 450)?.id).toBe("c2");
    expect(chapterAtTime(chs, 300)?.id).toBe("c2");
    expect(chapterAtTime([{ id: "x", startS: 10 }], 5)).toBeNull();
  });

  test("an A-B loop inside the Chapter wins; one elsewhere leaves the Chapter loop working", () => {
    const cl = { a: 300, b: 620 };
    const pick = (ab: { a: number; b: number }, abArmed: boolean, t: number) => abLoopTarget(ab, t, false, abArmed) ?? abLoopTarget(cl, t, false, true);
    expect(pick({ a: 400, b: 450 }, true, 450)).toBe(400); // inner A-B
    expect(pick({ a: 10, b: 60 }, false, 620)).toBe(300); // A-B elsewhere, not armed: the Chapter loops
  });
});
