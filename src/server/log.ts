import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let logPath: string | null = null;

export function initLog(path: string) {
  logPath = path;
  mkdirSync(dirname(path), { recursive: true });
}

/** Timestamped line to stdout and, once initLog has run, to log.txt. */
export function log(...parts: unknown[]) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
  console.log(line);
  if (logPath) {
    try {
      appendFileSync(logPath, line + "\n");
    } catch {
      // logging must never take the server down
    }
  }
}
