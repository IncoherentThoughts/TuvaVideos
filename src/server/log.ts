import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let logPath: string | null = null;
let toConsole = true;

/** `quiet`: lines go to the file only (a CLI that prints its own progress). */
export function initLog(path: string, opts: { quiet?: boolean } = {}) {
  logPath = path;
  toConsole = !opts.quiet;
  mkdirSync(dirname(path), { recursive: true });
}

/** Timestamped line to stdout and, once initLog has run, to log.txt. */
export function log(...parts: unknown[]) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
  if (toConsole) console.log(line);
  if (logPath) {
    try {
      appendFileSync(logPath, line + "\n");
    } catch {
      // logging must never take the server down
    }
  }
}
