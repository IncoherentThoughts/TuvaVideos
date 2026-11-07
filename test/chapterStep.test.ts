// The Player's Chapter step keys (`@`/PgDn next, `!`/PgUp previous): src/shared/playerMath.ts chapterStepTarget.
import { describe, expect, test } from "bun:test";
import { chapterStepTarget } from "../src/shared/playerMath";

describe("Chapter steps", () => {
  const starts = [5, 20, 40];
  test("back before the first Chapter goes to the start of the Video, not forward to it (WEB-9)", () => {
    expect(chapterStepTarget(starts, 0.16, -1)).toBe(-1);
    expect(chapterStepTarget(starts, 4.9, -1)).toBe(-1);
  });
  test("next and back between Chapters; back restarts the current one after 2 s", () => {
    expect(chapterStepTarget(starts, 0.16, 1)).toBe(0);
    expect(chapterStepTarget(starts, 6, 1)).toBe(1);
    expect(chapterStepTarget(starts, 21, -1)).toBe(0);
    expect(chapterStepTarget(starts, 25, -1)).toBe(1);
    expect(chapterStepTarget(starts, 5, -1)).toBe(0);
    expect(chapterStepTarget(starts, 45, 1)).toBe(2);
  });
});
