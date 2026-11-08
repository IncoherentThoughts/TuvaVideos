#!/usr/bin/env bun
// A scripted stand-in for yt-dlp (downloader-spec §10). Tests point the runner at this file and describe one run in a
// JSON scenario named by FAKE_YTDLP_SCENARIO:
//   { sizing?: object,          // printed for `-J` (the sizing pass)
//     steps?: [{ out?, err?, wait? }],   // replayed in order; `@FILE` in a line becomes the output file's absolute path
//     exit?: number,            // default 0
//     file?: string,            // output name written into cwd (default "Fake clip [jNQXAC9IVRw].mp4"); needs FAKE_YTDLP_CLIP
//     hang?: boolean,           // after the steps, wait forever (for kill tests)
//     ignoreSigterm?: boolean } // survive SIGTERM, so only SIGKILL stops it
// FAKE_YTDLP_CLIP is a small real video that becomes the output file. FAKE_YTDLP_ARGV_FILE, if set, receives the argv as JSON.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Step {
  out?: string;
  err?: string;
  wait?: number;
}
interface Scenario {
  sizing?: object;
  steps?: Step[];
  exit?: number;
  file?: string;
  hang?: boolean;
  ignoreSigterm?: boolean;
}

const argv = process.argv.slice(2);
if (process.env.FAKE_YTDLP_ARGV_FILE) writeFileSync(process.env.FAKE_YTDLP_ARGV_FILE, JSON.stringify(argv));
const sc: Scenario = process.env.FAKE_YTDLP_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_YTDLP_SCENARIO, "utf8")) : {};
if (sc.ignoreSigterm) process.on("SIGTERM", () => {});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const write = (stream: NodeJS.WriteStream, s: string) => new Promise<void>((r) => stream.write(s + "\n", () => r()));

if (argv.includes("-J")) {
  if (sc.sizing) await write(process.stdout, JSON.stringify(sc.sizing));
}

const target = join(process.cwd(), sc.file ?? "Fake clip [jNQXAC9IVRw].mp4");
for (const s of sc.steps ?? []) {
  if (s.wait) await sleep(s.wait);
  if (s.out !== undefined) await write(process.stdout, s.out.replace("@FILE", target));
  if (s.err !== undefined) await write(process.stderr, s.err.replace("@FILE", target));
}
if (sc.hang) await new Promise(() => {});

if ((sc.exit ?? 0) === 0 && !argv.includes("-J") && process.env.FAKE_YTDLP_CLIP) copyFileSync(process.env.FAKE_YTDLP_CLIP, target);
process.exit(sc.exit ?? 0);
