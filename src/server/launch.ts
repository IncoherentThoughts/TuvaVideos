import { spawn } from "node:child_process";
import type { Config } from "./config";
import { startApp } from "./app";
import { initLog, log } from "./log";

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
  spawn("open", [`http://localhost:${port}`], { stdio: "ignore", detached: true }).unref();
}

/** `bun run start`: if TuvaVideos already answers on the port only open the tab, else serve and open it. */
export async function launch(cfg: Config) {
  if (await healthAnswers(cfg.port)) {
    console.log(`TuvaVideos is already running on port ${cfg.port}; opening the tab`);
    if (cfg.openTab) openTab(cfg.port);
    return;
  }
  initLog(cfg.logPath);
  const app = await startApp(cfg);
  if (cfg.openTab) openTab(cfg.port);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig} received`);
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
