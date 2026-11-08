// Runs yt-dlp for one Download item (downloader-spec §4.2–4.4). No queue, no database: the caller owns both.

import type { ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { run } from "../proc";
import { buildDownloadArgs, buildSizingArgs, type ArgSpec } from "./args";
import { classify, type FailureReason } from "./classify";
import { ByteCounter, parseLine } from "./progress";
import { parseSizing, type Sizing } from "./sizing";

/** The tools are looked up by the caller (tools ticket, §2), never here. */
export interface ItemSpec extends ArgSpec {
  ytDlpPath: string;
  /** Destination folder; yt-dlp runs with this as its cwd. */
  cwd: string;
  /** Every stdout and stderr line is appended here. */
  logPath: string;
  /** From the sizing pass; makes `totalBytes` exact. */
  exactBytes?: number | null;
  /** Extra environment (the fake yt-dlp reads its script from here). */
  env?: Record<string, string>;
  /** Minimum gap between progress events. Default 1000. */
  throttleMs?: number;
  /** Grace between SIGTERM and SIGKILL. Default 5000. */
  killGraceMs?: number;
}

export type ItemEvent =
  | { type: "progress"; doneBytes: number; totalBytes: number | null; speed: number | null; eta: number | null }
  | { type: "merging" }
  | { type: "file"; path: string };

export type ItemOutcome =
  | { ok: true; filePath: string; exitCode: 0 }
  | { ok: false; killed: boolean; reason: FailureReason; errorLine: string | null; exitCode: number };

export interface ItemRun {
  done: Promise<ItemOutcome>;
  /** SIGTERM now, SIGKILL after the grace period. Resolves when the process is gone. Partial files are left alone. */
  kill(): Promise<void>;
}

const WEEK = 7 * 24 * 3600 * 1000;

/** Splits chunks into lines, holding back a trailing partial line. */
function lineSplitter(onLine: (l: string) => void) {
  let buf = "";
  return {
    push(chunk: Buffer | string) {
      buf += chunk;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop()!;
      for (const p of parts) onLine(p);
    },
    flush() {
      if (buf) onLine(buf);
      buf = "";
    },
  };
}

function logger(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  return (stream: "out" | "err", line: string) => {
    try {
      appendFileSync(path, `${stream === "err" ? "[err] " : ""}${line}\n`);
    } catch {
      // a full or missing log drive must not take the download down with it
    }
  };
}

/** The sizing pass. A failure is a download failure and is classified the same way. */
export async function sizeItem(spec: Omit<ItemSpec, "mergeFormat" | "exactBytes">): Promise<{ ok: true; sizing: Sizing } | { ok: false; reason: FailureReason; errorLine: string | null }> {
  const log = logger(spec.logPath);
  const r = await run(spec.ytDlpPath, buildSizingArgs(spec), { timeout: 5 * 60_000, env: spec.env });
  const lines = r.err.split(/\r?\n/).filter(Boolean);
  for (const l of lines) log("err", l);
  if (r.code === 0) {
    try {
      return { ok: true, sizing: parseSizing(r.out) };
    } catch (e) {
      log("err", `ERROR: unreadable sizing output: ${(e as Error).message}`);
      return { ok: false, reason: "unknown", errorLine: `unreadable sizing output: ${(e as Error).message}` };
    }
  }
  const c = classify(lines);
  return { ok: false, ...c };
}

export function runItem(spec: ItemSpec, onEvent: (e: ItemEvent) => void): ItemRun {
  const log = logger(spec.logPath);
  const counter = new ByteCounter(spec.exactBytes ?? null);
  const throttle = spec.throttleMs ?? 1000;
  const all: string[] = [];
  let filePath: string | null = null;
  let child: ChildProcess | null = null;
  let killed = false;
  let merging = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let lastEmit = 0;
  let pending: ItemEvent | null = null;
  let exited!: () => void;
  const gone = new Promise<void>((r) => (exited = r));

  const flush = () => {
    if (pending) {
      onEvent(pending);
      pending = null;
      lastEmit = Date.now();
    }
  };

  const onLine = (stream: "out" | "err") => (line: string) => {
    log(stream, line);
    all.push(line);
    // Real yt-dlp prints TUVAPP lines on stderr and the rest on stdout (docs/downloader-spec.md §4.3): read both.
    const p = parseLine(line);
    if (!p) return;
    if (p.kind === "file") {
      filePath = p.path;
      flush();
      onEvent({ type: "file", path: p.path });
    } else if (p.kind === "postprocess") {
      // A real run reports several post-processors (merge, move), each started/finished.
      // stdout and stderr are separate pipes, so a late TUVAPP can trail TUVAFILE: it no longer means anything then.
      if (p.status === "started" && !merging && !filePath) {
        merging = true;
        flush();
        onEvent({ type: "merging" });
      }
    } else {
      const b = counter.feed(p);
      pending = { type: "progress", doneBytes: b.doneBytes, totalBytes: b.totalBytes, speed: p.speed, eta: p.eta };
      // A stream finishing is rare and moves the count in a step: never hold it back.
      if (p.status === "finished" || Date.now() - lastEmit >= throttle) flush();
    }
  };

  const out = lineSplitter(onLine("out"));
  const err = lineSplitter(onLine("err"));

  const result = run(spec.ytDlpPath, buildDownloadArgs(spec), {
    timeout: WEEK,
    env: spec.env,
    cwd: spec.cwd,
    onSpawn: (p) => {
      child = p;
      p.stdout!.on("data", (d) => out.push(d));
      p.stderr!.on("data", (d) => err.push(d));
      p.on("close", () => exited());
      p.on("error", () => exited());
    },
  }).then((r): ItemOutcome => {
    if (killTimer) clearTimeout(killTimer);
    out.flush();
    err.flush();
    flush();
    if (r.code === 0 && filePath && !killed) return { ok: true, filePath, exitCode: 0 };
    if (killed) return { ok: false, killed: true, reason: "unknown", errorLine: null, exitCode: r.code };
    if (r.code === 0) {
      const errorLine = "yt-dlp finished without reporting a file";
      log("err", `ERROR: ${errorLine}`);
      return { ok: false, killed: false, reason: "unknown", errorLine, exitCode: 0 };
    }
    return { ok: false, killed: false, ...classify(all), exitCode: r.code };
  });

  return {
    done: result,
    async kill() {
      const p = child;
      if (!p || p.exitCode !== null || p.signalCode !== null) return;
      killed = true;
      p.kill("SIGTERM");
      killTimer = setTimeout(() => p.kill("SIGKILL"), spec.killGraceMs ?? 5000);
      await gone;
    },
  };
}
