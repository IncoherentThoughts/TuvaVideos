import { spawn } from "node:child_process";
import type { Config } from "./config";
import { startApp, type App } from "./app";
import { InstanceLock, type LockResult } from "./instanceLock";
import { initLog, log } from "./log";
import { openCommandFor } from "./platform";

async function healthAnswers(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    return ((await r.json()) as { app?: string }).app === "TuvaVideos";
  } catch {
    return false;
  }
}

function openTab(port: number) {
  // `open` / `xdg-open` / `cmd /c start` (sharing-spec §8.2).
  const { cmd, args } = openCommandFor(process.platform, `http://localhost:${port}`);
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/** How long a relaunch waits for the previous process on the same data dir to finish shutting down. */
const LOCK_WAIT_MS = 30_000;

/**
 * Signal handling for a running app: the first Ctrl-C (or SIGTERM, or the power button) stops it cleanly; a second
 * one kills the ffmpeg children and exits at once (audit PLAY-6). Exported for tests; `exit` is process.exit.
 */
export function shutdownHandler(app: Pick<App, "stop" | "kill">, lock: Pick<InstanceLock, "setState" | "release"> | null, exit: (code: number) => void) {
  let stopping = false;
  return async (sig: string) => {
    if (stopping) {
      log(`${sig} received again: killing the jobs in flight and exiting now`);
      app.kill();
      lock?.release();
      exit(1);
      return;
    }
    stopping = true;
    log(`${sig} received`);
    lock?.setState("stopping");
    try {
      await app.stop();
    } finally {
      lock?.release();
    }
    exit(0);
  };
}

/**
 * `bun run start`: one server per data dir (audit PLAY-2). When another TuvaVideos holds the data dir and answers,
 * only open the tab; when it is shutting down, wait for it to finish first. Else serve and open the tab.
 */
export async function launch(cfg: Config) {
  // A passive server (a preview on the real library, another port) shares the data dir by design.
  const lock = cfg.passive ? null : new InstanceLock(cfg.dataDir, cfg.port);
  if (lock) {
    let got: LockResult = lock.acquire();
    if (!got.ok && got.holder.state === "running" && (await healthAnswers(got.holder.port))) {
      console.log(`TuvaVideos is already running on port ${got.holder.port}; opening the tab`);
      if (cfg.openTab) openTab(got.holder.port);
      return;
    }
    if (!got.ok) {
      console.log(`TuvaVideos (pid ${got.holder.pid}) is still ${got.holder.state === "stopping" ? "shutting down" : "starting"}; waiting for it`);
      got = await lock.acquireWaiting(LOCK_WAIT_MS);
      if (!got.ok) {
        console.error(`Another TuvaVideos (pid ${got.holder.pid}) is using ${cfg.dataDir}; not starting a second one. Stop it first.`);
        process.exitCode = 1;
        return;
      }
    }
  }
  if (await healthAnswers(cfg.port)) {
    lock?.release();
    console.log(`TuvaVideos is already running on port ${cfg.port}; opening the tab`);
    if (cfg.openTab) openTab(cfg.port);
    return;
  }
  initLog(cfg.logPath);
  process.on("exit", () => lock?.release());
  let shutdown: (sig: string) => Promise<void> = async () => {};
  const app = await startApp(cfg, { quit: () => void shutdown("quit (power button)") });
  shutdown = shutdownHandler(app, lock, (code) => process.exit(code));
  void app.studio.probe(); // spec 9: before the tab opens, so the Automation prompt is predictable
  if (cfg.openTab) openTab(cfg.port);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
