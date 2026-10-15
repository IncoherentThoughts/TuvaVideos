import { describe, expect, test } from "bun:test";
import { bestCopy, needsPrepare, nextCopy, readPrepare } from "../src/shared/copies";
import { dispatchKey, isRepeatable, keyAction, playerOwnsKey, type PlayerAction } from "../src/shared/keymap";
import { positionIn, resolvePlayingFrom, stepFrom, uniqueIds, type PlayingFrom } from "../src/shared/playingFrom";
import {
  AB_OFF, abLoopTarget, abToggle, clampTime, fmtClock, frameNumber, frameStepTarget, parseFrameRate, speedBy, storedLoop, volumeBy,
} from "../src/shared/playerMath";
import { FINISHED_WITHIN_S, RESUME_INTERVAL_MS, ResumeClock, isFinished, startPosition, storedResume } from "../src/shared/resume";
import { SeekThrottle } from "../src/shared/seekThrottle";
import { fmtSeconds, isPng, sanitizeTitle, screenshotName } from "../src/server/screenshot";

const focused = { containerFocused: true };
const unfocused = { containerFocused: false };
const act = (key: string, extra: Record<string, unknown> = {}) => dispatchKey({ key, ...extra }, focused).action;

describe("key dispatcher: the table of spec 4.5", () => {
  const cases: [string, Record<string, unknown>, PlayerAction][] = [
    [" ", {}, { type: "togglePause" }],
    ["p", {}, { type: "togglePause" }],
    ["ArrowRight", {}, { type: "seekBy", seconds: 5, exact: false }],
    ["ArrowLeft", {}, { type: "seekBy", seconds: -5, exact: false }],
    ["ArrowUp", {}, { type: "seekBy", seconds: 60, exact: false }],
    ["ArrowDown", {}, { type: "seekBy", seconds: -60, exact: false }],
    ["ArrowRight", { shiftKey: true }, { type: "seekBy", seconds: 1, exact: true }],
    ["ArrowLeft", { shiftKey: true }, { type: "seekBy", seconds: -1, exact: true }],
    ["ArrowUp", { shiftKey: true }, { type: "seekBy", seconds: 5, exact: true }],
    ["ArrowDown", { shiftKey: true }, { type: "seekBy", seconds: -5, exact: true }],
    [",", {}, { type: "frameStep", dir: -1 }],
    [".", {}, { type: "frameStep", dir: 1 }],
    ["[", {}, { type: "speedBy", delta: -0.1 }],
    ["]", {}, { type: "speedBy", delta: 0.1 }],
    ["{", { shiftKey: true }, { type: "speedSet", rate: 0.5 }],
    ["}", { shiftKey: true }, { type: "speedSet", rate: 2 }],
    ["Backspace", {}, { type: "speedSet", rate: 1 }],
    ["9", {}, { type: "volumeBy", delta: -5 }],
    ["0", {}, { type: "volumeBy", delta: 5 }],
    ["m", {}, { type: "mute" }],
    ["f", {}, { type: "fullscreen" }],
    ["l", {}, { type: "abLoop" }],
    ["!", { shiftKey: true }, { type: "chapter", dir: -1 }],
    ["@", { shiftKey: true }, { type: "chapter", dir: 1 }],
    ["PageUp", {}, { type: "chapter", dir: -1 }],
    ["PageDown", {}, { type: "chapter", dir: 1 }],
    ["<", { shiftKey: true }, { type: "video", dir: -1 }],
    [">", { shiftKey: true }, { type: "video", dir: 1 }],
    ["s", {}, { type: "screenshot" }],
    ["o", {}, { type: "osd", always: false }],
    ["O", { shiftKey: true }, { type: "osd", always: true }],
    ["t", {}, { type: "studio" }],
    ["c", {}, { type: "chapterAdd" }],
    ["a", {}, { type: "audio" }],
    ["n", {}, { type: "playlist", op: "next" }],
    ["N", { shiftKey: true }, { type: "playlist", op: "prev" }],
    ["x", {}, { type: "playlist", op: "shuffle" }],
    ["e", {}, { type: "playlist", op: "repeat" }],
    ["q", {}, { type: "playlist", op: "panel" }],
  ];
  for (const [key, extra, want] of cases) {
    test(`${extra.shiftKey ? "shift+" : ""}${key === " " ? "space" : key}`, () => {
      const r = dispatchKey({ key, ...extra }, focused);
      expect(r.handled).toBe(true);
      expect(r.action).toEqual(want);
    });
  }

  test("unbound keys are not handled, so they keep their default", () => {
    for (const k of ["Tab", "Enter", "Escape", "F5", "/", "1", "d", "F", "X", "E", "Q"]) {
      expect(dispatchKey({ key: k }, focused)).toEqual({ action: null, handled: false });
    }
  });

  test("bare keys only: Meta, Ctrl and Alt chords are never ours", () => {
    for (const mod of ["metaKey", "ctrlKey", "altKey"]) {
      for (const k of [" ", "f", "ArrowRight", "s", "m", "[", "0"]) {
        expect(keyAction({ key: k, [mod]: true })).toBeNull();
        expect(dispatchKey({ key: k, [mod]: true }, focused).handled).toBe(false);
      }
    }
  });
});

describe("the focus rule", () => {
  test("keys are handled only while the Player container has focus", () => {
    expect(playerOwnsKey({ key: " " }, focused)).toBe(true);
    expect(playerOwnsKey({ key: " " }, unfocused)).toBe(false);
    expect(dispatchKey({ key: " " }, unfocused)).toEqual({ action: null, handled: false });
    expect(dispatchKey({ key: "ArrowRight" }, unfocused).handled).toBe(false);
  });
  test("a chord is not ours even with focus", () => {
    expect(playerOwnsKey({ key: "f", metaKey: true }, focused)).toBe(false);
  });
  test("a held one-shot key is swallowed (preventDefault) but does nothing; relative keys repeat", () => {
    expect(dispatchKey({ key: "m", repeat: true }, focused)).toEqual({ action: null, handled: true });
    expect(dispatchKey({ key: "f", repeat: true }, focused)).toEqual({ action: null, handled: true });
    expect(dispatchKey({ key: "ArrowRight", repeat: true }, focused).action).toEqual({ type: "seekBy", seconds: 5, exact: false });
    expect(dispatchKey({ key: ".", repeat: true }, focused).action).toEqual({ type: "frameStep", dir: 1 });
    expect(isRepeatable({ type: "screenshot" })).toBe(false);
    expect(isRepeatable({ type: "togglePause" })).toBe(false);
  });
  test("every binding in the table is reachable", () => {
    expect(act("t")).toEqual({ type: "studio" });
  });
});

describe("frame-step arithmetic from r_frame_rate", () => {
  test("parseFrameRate", () => {
    expect(parseFrameRate("25/1")).toBe(25);
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97003, 5);
    expect(parseFrameRate("60")).toBe(60);
    expect(parseFrameRate("0/0")).toBeNull();
    expect(parseFrameRate(null)).toBeNull();
    expect(parseFrameRate("abc")).toBeNull();
  });
  test("frame numbers", () => {
    expect(frameNumber(0, 25)).toBe(0);
    expect(frameNumber(1, 25)).toBe(25);
    expect(frameNumber(10 / 25, 25)).toBe(10);
    const ntsc = parseFrameRate("30000/1001")!;
    expect(frameNumber(100 / ntsc, ntsc)).toBe(100);
    expect(frameNumber(-3, 25)).toBe(0);
  });
  test("stepping lands just past the neighbouring frame boundary and the frame number moves by one", () => {
    for (const fps of [24, 25, 29.97003, 30, 50, 59.94006, 60]) {
      for (const n of [0, 1, 17, 1000, 123456]) {
        const t = n / fps;
        const fwd = frameStepTarget(t, fps, 1);
        const back = frameStepTarget(t, fps, -1);
        expect(frameNumber(fwd, fps)).toBe(n + 1);
        expect(frameNumber(back, fps)).toBe(Math.max(0, n - 1));
        // the target is on the correct side of the boundary: it falls inside frame n+1's display interval
        expect(fwd).toBeGreaterThanOrEqual((n + 1) / fps);
        expect(fwd).toBeLessThan((n + 2) / fps);
      }
    }
  });
  test("stepping back at 0 stays on frame 0; stepping forward is clamped to the last frame", () => {
    expect(frameNumber(frameStepTarget(0, 25, -1), 25)).toBe(0);
    const last = frameStepTarget(9.99, 25, 1, 10); // 250 frames: 0..249
    expect(frameNumber(last, 25)).toBe(249);
    expect(frameStepTarget(last, 25, 1, 10)).toBe(last);
  });
  test("from an in-between time, the step starts from the nearest frame", () => {
    expect(frameNumber(frameStepTarget(1.013, 25, 1), 25)).toBe(26); // 1.013 s ~ frame 25
  });
});

describe("speed, volume, clamping, A-B loop", () => {
  test("[ ] are additive and return to exactly 1.0", () => {
    let r = 1;
    r = speedBy(r, 0.1);
    expect(r).toBe(1.1);
    r = speedBy(r, 0.1);
    expect(r).toBe(1.2);
    r = speedBy(speedBy(r, -0.1), -0.1);
    expect(r).toBe(1);
    expect(speedBy(0.1, -0.1)).toBe(0.1);
    expect(speedBy(8, 0.1)).toBe(8);
  });
  test("volume steps by 5 percent points within 0..1", () => {
    expect(volumeBy(1, 5)).toBe(1);
    expect(volumeBy(1, -5)).toBe(0.95);
    expect(volumeBy(0.05, -5)).toBe(0);
    expect(volumeBy(0, -5)).toBe(0);
    expect(volumeBy(0.7, 5)).toBe(0.75);
  });
  test("clampTime", () => {
    expect(clampTime(-4, 100)).toBe(0);
    expect(clampTime(140, 100)).toBe(100);
    expect(clampTime(50, null)).toBe(50);
  });
  test("A-B loop cycles A, B, off and loops back from B", () => {
    let s = abToggle(AB_OFF, 10);
    expect(s.ab).toEqual({ a: 10, b: null });
    expect(abLoopTarget(s.ab, 50)).toBeNull();
    expect(abLoopTarget(s.ab, 50, true)).toBe(10); // ended with only A set
    s = abToggle(s.ab, 20);
    expect(s.ab).toEqual({ a: 10, b: 20 });
    expect(abLoopTarget(s.ab, 19.9)).toBeNull();
    expect(abLoopTarget(s.ab, 20)).toBe(10);
    s = abToggle(s.ab, 30);
    expect(s.ab).toEqual(AB_OFF);
    expect(abToggle({ a: 20, b: null }, 5).ab).toEqual({ a: 5, b: 20 }); // B before A swaps
    expect(abToggle({ a: 20, b: null }, 20).ab).toEqual({ a: 20, b: null }); // empty loop refused
  });
  test("storedLoop keeps only a complete loop (what persists across sessions)", () => {
    expect(storedLoop(AB_OFF)).toBeNull();
    expect(storedLoop(null)).toBeNull();
    expect(storedLoop({ a: 10, b: null })).toBeNull(); // half-set A is not kept
    expect(storedLoop({ a: 10, b: 20 })).toEqual({ a: 10, b: 20 });
    expect(storedLoop({ a: 20, b: 10 })).toBeNull();
    expect(storedLoop({ a: 10, b: 10.01 })).toBeNull();
    expect(storedLoop({ a: NaN, b: 10 })).toBeNull();
    expect(abToggle(storedLoop({ a: 10, b: 20 })!, 15).ab).toEqual(AB_OFF); // l on a restored loop turns it off
  });
  test("fmtClock", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(65.9)).toBe("1:05");
    expect(fmtClock(3725)).toBe("1:02:05");
    expect(fmtClock(null)).toBe("–:––");
  });
});

describe("resume rules", () => {
  test("a position within 30 s of the end is finished", () => {
    expect(FINISHED_WITHIN_S).toBe(30);
    expect(isFinished(569.9, 600)).toBe(false);
    expect(isFinished(570, 600)).toBe(true);
    expect(isFinished(600, 600)).toBe(true);
    expect(isFinished(100, null)).toBe(false); // unknown duration
    expect(isFinished(10, 25)).toBe(true); // a clip shorter than the window is always finished
  });
  test("stored value: finished -> 0, else the position", () => {
    expect(storedResume(123.456, 600)).toBe(123.46);
    expect(storedResume(580, 600)).toBe(0);
    expect(storedResume(-5, 600)).toBe(0);
    expect(storedResume(NaN, 600)).toBe(0);
    expect(storedResume(42, null)).toBe(42);
  });
  test("start position: ?t= wins, else Resume, finished reopens at 0", () => {
    expect(startPosition({ t: 90, resumeS: 10, durationS: 600 })).toBe(90);
    expect(startPosition({ t: 0, resumeS: 10, durationS: 600 })).toBe(0);
    expect(startPosition({ t: null, resumeS: 10, durationS: 600 })).toBe(10);
    expect(startPosition({ t: null, resumeS: 590, durationS: 600 })).toBe(0);
    expect(startPosition({ t: null, resumeS: null, durationS: 600 })).toBe(0);
    expect(startPosition({ t: 9999, resumeS: null, durationS: 600 })).toBe(599.5); // t past the end is clamped
  });
  test("5 s cadence: first tick starts the clock, due every 5 s while playing", () => {
    expect(RESUME_INTERVAL_MS).toBe(5000);
    const c = new ResumeClock();
    expect(c.tick(0, true)).toBe(false);
    expect(c.tick(1000, true)).toBe(false);
    expect(c.tick(4999, true)).toBe(false);
    expect(c.tick(5000, true)).toBe(true);
    expect(c.tick(6000, true)).toBe(false);
    expect(c.tick(10000, true)).toBe(true);
    expect(c.tick(20000, false)).toBe(false); // paused: never
  });
  test("an event write (pause, seek, Copy switch) restarts the interval; a new play starts fresh", () => {
    const c = new ResumeClock();
    c.tick(0, true);
    c.wrote(4000);
    expect(c.tick(5000, true)).toBe(false);
    expect(c.tick(9000, true)).toBe(true);
    c.stopped();
    expect(c.tick(100000, true)).toBe(false);
    expect(c.tick(105000, true)).toBe(true);
  });
});

describe("Playing from", () => {
  const pf: PlayingFrom = { source: "favorites", ids: [5, 9, 2, 7] };
  test("position n of N", () => {
    expect(positionIn(pf, 9)).toEqual({ n: 2, total: 4 });
    expect(positionIn(pf, 5)).toEqual({ n: 1, total: 4 });
    expect(positionIn(pf, 99)).toBeNull();
  });
  test("steps next and previous", () => {
    expect(stepFrom(pf, 9, 1)).toBe(2);
    expect(stepFrom(pf, 9, -1)).toBe(5);
  });
  test("wraps at both ends", () => {
    expect(stepFrom(pf, 7, 1)).toBe(5);
    expect(stepFrom(pf, 5, -1)).toBe(7);
  });
  test("skips Videos that cannot be played, and wraps past them", () => {
    const playable = (id: number) => id !== 2 && id !== 7;
    expect(stepFrom(pf, 9, 1, playable)).toBe(5); // 2 and 7 skipped, wrapped to 5
    expect(stepFrom(pf, 5, -1, playable)).toBe(9);
  });
  test("nothing else playable, one-item list, or current not in the list", () => {
    expect(stepFrom(pf, 5, 1, (id) => id === 5)).toBeNull();
    expect(stepFrom({ source: "search", ids: [3] }, 3, 1)).toBeNull();
    expect(stepFrom(pf, 100, 1)).toBeNull();
    expect(stepFrom({ source: "library", ids: [] }, 1, 1)).toBeNull();
  });
  test("a snapshot is a snapshot: stepping does not depend on later list changes", () => {
    const ids = [1, 2, 3];
    const snap: PlayingFrom = { source: "library", ids: [...ids] };
    ids.push(4);
    expect(stepFrom(snap, 3, 1)).toBe(1);
  });
  test("resolve: keep a snapshot that holds the Video (reload, stepping), else library order", () => {
    expect(resolvePlayingFrom(pf, 2, [1, 2, 3])).toBe(pf);
    expect(resolvePlayingFrom(pf, 100, [100, 101])).toEqual({ source: "library", ids: [100, 101] });
    expect(resolvePlayingFrom(null, 1, [1, 2])).toEqual({ source: "library", ids: [1, 2] });
  });
  test("uniqueIds keeps the first occurrence (Favorites chapters of one Video)", () => {
    expect(uniqueIds([4, 8, 4, 8, 1])).toEqual([4, 8, 1]);
  });
});

describe("Copy choice and the preparing contract", () => {
  const ranked = [
    { id: 10, available: false }, // local, but its Root is gone
    { id: 11, available: true },
    { id: 12, available: true },
  ];
  test("bestCopy is the first Available in ranking order, skipping failures", () => {
    expect(bestCopy(ranked)?.id).toBe(11);
    expect(bestCopy(ranked, new Set([11]))?.id).toBe(12);
    expect(bestCopy(ranked, new Set([11, 12]))).toBeNull();
  });
  test("nextCopy after a loss never returns the lost Copy", () => {
    expect(nextCopy(ranked, 11)?.id).toBe(12);
    expect(nextCopy(ranked, 12)?.id).toBe(11);
    expect(nextCopy(ranked, 11, new Set([12]))).toBeNull();
    expect(nextCopy([{ id: 1, available: false }], 1)).toBeNull();
  });
  test("a Fallback that is not ready needs preparing", () => {
    expect(needsPrepare({ playback: "native", fallback: { state: "none" } })).toBe(false);
    expect(needsPrepare({ playback: "remux", fallback: { state: "none" } })).toBe(true);
    expect(needsPrepare({ playback: "transcode", fallback: { state: "preparing" } })).toBe(true);
    expect(needsPrepare({ playback: "transcode", fallback: { state: "ready" } })).toBe(false);
  });
  test("503 body -> overlay state: waiting with progress, ready, or failed", () => {
    expect(readPrepare({ state: "queued", progress: 0 })).toEqual({ kind: "wait", progress: 0 });
    expect(readPrepare({ state: "preparing", progress: 0.4 })).toEqual({ kind: "wait", progress: 0.4 });
    expect(readPrepare({ state: "preparing", progress: null })).toEqual({ kind: "wait", progress: null });
    expect(readPrepare({ state: "ready", progress: 1 })).toEqual({ kind: "ready" });
    expect(readPrepare({ state: "failed", error: "ffmpeg exited 1" })).toEqual({ kind: "failed", error: "ffmpeg exited 1" });
  });
});

describe("scrub throttle: one seek in flight, latest wins; click is unthrottled", () => {
  test("a drag issues one seek, queues the latest, and issues it when the first lands", () => {
    const issued: number[] = [];
    const th = new SeekThrottle((t) => issued.push(t));
    th.request(10, true, 0);
    th.request(11, true, 10);
    th.request(12, true, 20);
    th.request(13, true, 30);
    expect(issued).toEqual([10]);
    expect(th.pending).toBe(13);
    th.landed(40);
    expect(issued).toEqual([10, 13]);
    th.landed(50);
    expect(issued).toEqual([10, 13]);
    expect(th.busy).toBe(false);
    th.request(20, true, 60);
    expect(issued).toEqual([10, 13, 20]);
  });
  test("click-to-seek is issued at once even with a seek in flight, and drops the queue", () => {
    const issued: number[] = [];
    const th = new SeekThrottle((t) => issued.push(t));
    th.request(10, true, 0);
    th.request(11, true, 1);
    th.request(99, false, 2);
    expect(issued).toEqual([10, 99]);
    expect(th.pending).toBeNull();
  });
  test("a seek that never lands stops blocking after the stale window", () => {
    const issued: number[] = [];
    const th = new SeekThrottle((t) => issued.push(t), 1000);
    th.request(1, true, 0);
    th.request(2, true, 500);
    expect(issued).toEqual([1]);
    th.request(3, true, 2000);
    expect(issued).toEqual([1, 3]);
  });
});

describe("screenshot file names", () => {
  test("<title> @ <seconds>s.png", () => {
    expect(screenshotName("Alash Chicago", 12.3)).toBe("Alash Chicago @ 12.3s.png");
    expect(screenshotName("Alash", 12)).toBe("Alash @ 12s.png");
    expect(screenshotName("Alash", 12.3456)).toBe("Alash @ 12.35s.png");
    expect(fmtSeconds(0)).toBe("0");
  });
  test("unsafe characters are replaced, Cyrillic is kept", () => {
    expect(sanitizeTitle("a/b\\c:d*e?f\"g<h>i|j")).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(sanitizeTitle("Алаш — Хөөмей")).toBe("Алаш — Хөөмей");
    expect(sanitizeTitle("  ../../etc/passwd  ")).toBe("_.._etc_passwd");
    expect(sanitizeTitle("..")).toBe("screenshot");
    expect(sanitizeTitle(".hidden")).toBe("hidden");
    expect(sanitizeTitle("tab\tand\nnewline\u0000x")).toBe("tab and newlinex");
    expect(sanitizeTitle("")).toBe("screenshot");
  });
  test("long titles are cut under the filename limit by bytes", () => {
    const name = screenshotName("Ы".repeat(500), 1234.5);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name.endsWith(" @ 1234.5s.png")).toBe(true);
  });
  test("PNG signature check", () => {
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe(true);
    expect(isPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(false);
  });
});
