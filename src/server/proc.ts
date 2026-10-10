import { spawn } from "node:child_process";

/** stderr patterns that mean the drive is misbehaving, not that the file is bad. */
export const IO_RE =
  /input\/output error|device not configured|operation timed out|i\/o error|stale file|no such device|broken pipe|connection reset|resource busy|\bEIO\b|\bETIMEDOUT\b|\bENXIO\b|\bENODEV\b/i;

export function isIoError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "EIO" || code === "ETIMEDOUT" || code === "ENXIO" || code === "ENODEV" || code === "EBUSY" || IO_RE.test(String((e as Error)?.message ?? e));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

export function run(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<RunResult> {
  const timeout = opts.timeout ?? 300_000;
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => {
      if (err.length < 20000) err += d;
    });
    const t = setTimeout(() => p.kill("SIGKILL"), timeout);
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: "", err: String(e) });
    });
    p.on("close", (code, sig) => {
      clearTimeout(t);
      resolve({ code: sig ? -1 : (code ?? -1), out: Buffer.concat(out).toString("utf8"), err: sig ? `killed (${sig}) ${err}` : err });
    });
  });
}
