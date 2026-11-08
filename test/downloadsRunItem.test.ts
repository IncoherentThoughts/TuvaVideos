import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBin } from "../src/server/config";
import { runItem, sizeItem, type ItemEvent, type ItemSpec } from "../src/server/downloads/runItem";

const FAKE = join(import.meta.dir, "fixtures", "fake-yt-dlp.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "tuva-runitem-")));
const clip = join(root, "clip.mp4");
let n = 0;

beforeAll(async () => {
  const p = Bun.spawn([findBin("ffmpeg"), "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=64x48:d=0.5:r=10", "-pix_fmt", "yuv420p", clip], { stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** One fake-yt-dlp run in its own destination folder. */
function setup(scenario: object, extra: Partial<ItemSpec> = {}) {
  const dir = join(root, `run${++n}`);
  mkdirSync(dir);
  const scenarioPath = join(dir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const cwd = join(dir, "dest");
  mkdirSync(cwd);
  const argvFile = join(dir, "argv.json");
  const spec: ItemSpec = {
    url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    source: "youtube",
    quality: "1080p",
    ffmpegLocation: "/opt/ff",
    ytDlpPath: FAKE,
    cwd,
    logPath: join(dir, "logs", "item.log"),
    env: { FAKE_YTDLP_SCENARIO: scenarioPath, FAKE_YTDLP_CLIP: clip, FAKE_YTDLP_ARGV_FILE: argvFile },
    ...extra,
  };
  return { spec, cwd, argv: () => JSON.parse(readFileSync(argvFile, "utf8")) as string[], log: () => readFileSync(spec.logPath, "utf8") };
}

const dl = (status: string, done: number, total: number, speed = "1000.5", eta = "1") => `TUVA ${status} ${done} ${total} NA ${speed} ${eta}`;

describe("runItem with the fake yt-dlp", () => {
  test("a two-stream download: events, file, log, real clip on disk", async () => {
    const t = setup(
      {
        steps: [
          { out: dl("downloading", 100, 300) },
          { out: dl("finished", 300, 300, "2000", "NA") },
          { out: dl("downloading", 50, 200) },
          { out: dl("finished", 200, 200, "2000", "NA") },
          { err: "TUVAPP started" },
          { err: "TUVAPP finished" },
          { out: "TUVAFILE @FILE" },
        ],
      },
      { exactBytes: 500, throttleMs: 0, mergeFormat: "mkv" },
    );
    const events: ItemEvent[] = [];
    const out = await runItem(t.spec, (e) => events.push(e)).done;
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.filePath).toBe(join(t.cwd, "Fake clip [jNQXAC9IVRw].mp4"));
    expect(existsSync(out.filePath)).toBe(true);
    expect(Bun.file(out.filePath).size).toBeGreaterThan(1000);
    const progress = events.filter((e): e is Extract<ItemEvent, { type: "progress" }> => e.type === "progress");
    expect(progress.map((e) => e.doneBytes)).toEqual([100, 300, 350, 500]);
    expect(progress.every((e) => e.totalBytes === 500)).toBe(true);
    // stderr (TUVAPP) and stdout (TUVAFILE) race, so "merging" may be dropped when it arrives after the file; never repeated
    expect(events.filter((e) => e.type === "merging").length).toBeLessThanOrEqual(1);
    expect(events).toContainEqual({ type: "file", path: out.filePath });
    // every line of both streams reaches the log, stderr marked
    const log = t.log();
    expect(log).toContain("TUVA finished 300 300 NA 2000 NA\n");
    expect(log).toContain("[err] TUVAPP started\n");
    expect(log).toContain("TUVAFILE ");
    // the item runs in the destination with the spec's arguments
    expect(t.argv()).toEqual(expect.arrayContaining(["--merge-output-format", "mkv", "--ffmpeg-location", "/opt/ff"]));
  });

  test("progress events are throttled but the final state always arrives", async () => {
    const steps = Array.from({ length: 30 }, (_, i) => ({ out: dl("downloading", (i + 1) * 10, 300) }));
    const t = setup({ steps: [...steps, { out: "TUVAFILE @FILE" }] }, { throttleMs: 60_000 });
    const events: ItemEvent[] = [];
    await runItem(t.spec, (e) => events.push(e)).done;
    const progress = events.filter((e) => e.type === "progress") as Array<Extract<ItemEvent, { type: "progress" }>>;
    expect(progress.length).toBeLessThanOrEqual(2);
    expect(progress.at(-1)!.doneBytes).toBe(300);
  });

  test("a failing run is classified from the last ERROR line", async () => {
    const t = setup({ steps: [{ err: "ERROR: [youtube] Sf9lj8T6TGQ: Video unavailable. This video is not available" }], exit: 1 });
    const out = await runItem(t.spec, () => {}).done;
    expect(out).toEqual({ ok: false, killed: false, reason: "unavailable", errorLine: "[youtube] Sf9lj8T6TGQ: Video unavailable. This video is not available", exitCode: 1 });
    expect(t.log()).toContain("[err] ERROR: [youtube] Sf9lj8T6TGQ");
    expect(readdirSyncSafe(t.cwd)).toEqual([]);
  });

  test("exit 0 without a reported file is a failure, not a success", async () => {
    const t = setup({ steps: [{ out: dl("downloading", 1, 2) }] });
    const out = await runItem(t.spec, () => {}).done;
    expect(out).toMatchObject({ ok: false, reason: "unknown", exitCode: 0 });
  });

  test("kill sends SIGTERM and the run ends as killed, partials untouched", async () => {
    const t = setup({ steps: [{ out: dl("downloading", 1, 2) }], hang: true });
    writeFileSync(join(t.cwd, "Fake clip [jNQXAC9IVRw].mp4.part"), "partial");
    const run = runItem(t.spec, () => {});
    await Bun.sleep(400);
    const t0 = Date.now();
    await run.kill();
    const out = await run.done;
    expect(out).toMatchObject({ ok: false, killed: true });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(existsSync(join(t.cwd, "Fake clip [jNQXAC9IVRw].mp4.part"))).toBe(true);
  });

  test("a process that ignores SIGTERM is SIGKILLed after the grace period", async () => {
    const t = setup({ steps: [{ out: dl("downloading", 1, 2) }], hang: true, ignoreSigterm: true }, { killGraceMs: 300 });
    const run = runItem(t.spec, () => {});
    await Bun.sleep(400);
    const t0 = Date.now();
    await run.kill();
    expect((await run.done).ok).toBe(false);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(3000);
  });

  test("kill before the process exists or after it ended does nothing", async () => {
    const t = setup({ steps: [{ out: "TUVAFILE @FILE" }] });
    const run = runItem(t.spec, () => {});
    await run.done;
    await run.kill();
  });
});

describe("sizeItem with the fake yt-dlp", () => {
  test("reads exact bytes and codec", async () => {
    const t = setup({ sizing: { duration: 19, requested_formats: [{ filesize: 293080, vcodec: "vp09.00.20.08" }, { filesize: 252182, vcodec: "none" }] } });
    const r = await sizeItem(t.spec);
    expect(r).toEqual({ ok: true, sizing: { exactBytes: 545262, videoCodec: "vp09", mergeFormat: "mkv", durationS: 19 } });
    expect(t.argv()).toContain("-J");
  });

  test("a sizing failure is classified like a download failure", async () => {
    const t = setup({ steps: [{ err: "ERROR: [youtube] i_66Y-6DZ9k: Private video. Sign in if you've been granted access to this video" }], exit: 1 });
    expect(await sizeItem(t.spec)).toMatchObject({ ok: false, reason: "private" });
  });

  test("unreadable output is unknown", async () => {
    const t = setup({});
    expect(await sizeItem(t.spec)).toMatchObject({ ok: false, reason: "unknown" });
  });
});

function readdirSyncSafe(d: string) {
  return require("node:fs").readdirSync(d) as string[];
}
