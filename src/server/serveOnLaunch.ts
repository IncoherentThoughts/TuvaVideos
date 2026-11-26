// Serve on launch, Open at login and keep-awake (docs/home-server-spec.md §2.2).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Db } from "./db";
import { log } from "./log";
import type { ServeSettingsDto } from "../shared/types";
import type { TvServer } from "./tv";

export const LOGIN_AGENT_LABEL = "com.incoherentthoughts.tuvavideos";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Pure: the LaunchAgent plist that starts the app bundle's launcher at login, with no tab. */
export function loginAgentPlist(o: { launcher: string; logPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LOGIN_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(o.launcher)}</string>
    <string>--background</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(o.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(o.logPath)}</string>
</dict>
</plist>
`;
}

/** Pure: the keep-awake child: no idle sleep for as long as process `pid` lives. */
export const caffeinateArgs = (pid: number): string[] => ["caffeinate", "-i", "-w", String(pid)];

/**
 * The Open at login LaunchAgent file. The directory is injected (tests use a temp dir). It is only written here:
 * macOS reads `~/Library/LaunchAgents` at the next login, so there is no `launchctl load` (the app is already running).
 */
export class LoginAgent {
  constructor(private o: { dir: string; launcher: string; logPath: string }) {}
  get path(): string {
    return join(this.o.dir, `${LOGIN_AGENT_LABEL}.plist`);
  }
  installed(): boolean {
    return existsSync(this.path);
  }
  install(): void {
    mkdirSync(this.o.dir, { recursive: true });
    const text = loginAgentPlist(this.o);
    if (this.installed() && readFileSync(this.path, "utf8") === text) return;
    writeFileSync(this.path, text);
  }
  remove(): void {
    rmSync(this.path, { force: true });
  }
}

/** The real LaunchAgents folder and the app bundle's launcher (scripts/make-app.ts). `TUVA_LAUNCH_AGENTS_DIR` overrides the folder, for tests and smoke. */
export function defaultLoginAgent(dataDir: string, env: Record<string, string | undefined> = process.env): LoginAgent {
  return new LoginAgent({
    dir: env.TUVA_LAUNCH_AGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents"),
    launcher: join(homedir(), "Applications", "TuvaVideos.app", "Contents", "MacOS", "TuvaVideos"),
    logPath: join(dataDir, "launcher.log"),
  });
}

export type { ServeSettingsDto };

type Spawn = (cmd: string[]) => { kill(): void };

const defaultSpawn: Spawn = (cmd) => {
  const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  p.unref();
  return p;
};

/** The per-machine Serve on launch setting (`download_setting.serve_on_launch`: local to this machine) and what hangs off it. */
export class ServeOnLaunch {
  private awake: { kill(): void } | null = null;

  constructor(
    private deps: {
      db: Db;
      tv: Pick<TvServer, "on" | "start" | "onStart" | "onStop">;
      agent: Pick<LoginAgent, "installed" | "install" | "remove">;
      passive: boolean;
      platform?: NodeJS.Platform;
      pid?: number;
      spawn?: Spawn;
    },
  ) {
    deps.tv.onStart(() => this.syncAwake());
    deps.tv.onStop(() => this.syncAwake());
  }

  private get available(): boolean {
    return !this.deps.passive && (this.deps.platform ?? process.platform) === "darwin";
  }

  get serveOnLaunch(): boolean {
    const r = this.deps.db.query("SELECT value FROM download_setting WHERE key = 'serve_on_launch'").get() as { value: string } | null;
    return r?.value === "1";
  }

  get awakeRunning(): boolean {
    return this.awake != null;
  }

  state(): ServeSettingsDto {
    return { available: this.available, serveOnLaunch: this.serveOnLaunch, openAtLogin: this.serveOnLaunch && this.deps.agent.installed() };
  }

  /** Turning Serve on launch off also removes the LaunchAgent; Open at login needs it on. */
  set(p: { serveOnLaunch?: boolean; openAtLogin?: boolean }): { ok: true; state: ServeSettingsDto } | { ok: false; error: string } {
    if (!this.available) return { ok: false, error: "Serve on launch is for the Mac app, not a passive server" };
    if (p.serveOnLaunch !== undefined) {
      this.deps.db.query("INSERT INTO download_setting (key, value) VALUES ('serve_on_launch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(p.serveOnLaunch ? "1" : "0");
      if (!p.serveOnLaunch) this.deps.agent.remove();
    }
    if (p.openAtLogin !== undefined) {
      if (p.openAtLogin && !this.serveOnLaunch) return { ok: false, error: "turn Serve on launch on first" };
      if (p.openAtLogin) this.deps.agent.install();
      else this.deps.agent.remove();
    }
    this.syncAwake();
    return { ok: true, state: this.state() };
  }

  /** At launch: start the Library Server when the setting is on. */
  applyAtLaunch(): void {
    if (!this.available || !this.serveOnLaunch) return;
    const r = this.deps.tv.start();
    if (!r.ok) log(`Serve on launch: ${r.error}`);
    this.syncAwake();
  }

  /** `caffeinate -i -w <pid>` while the Library Server is on and Serve on launch is set; ended otherwise. */
  syncAwake(): void {
    const want = this.available && this.deps.tv.on && this.serveOnLaunch;
    if (want && !this.awake) {
      try {
        this.awake = (this.deps.spawn ?? defaultSpawn)(caffeinateArgs(this.deps.pid ?? process.pid));
        log("keeping the Mac awake (caffeinate)");
      } catch (e) {
        log("caffeinate failed", String(e));
      }
    } else if (!want && this.awake) {
      this.stopAwake();
    }
  }

  stopAwake(): void {
    try {
      this.awake?.kill();
    } catch {}
    this.awake = null;
  }
}
