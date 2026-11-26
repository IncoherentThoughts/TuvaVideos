// Serve on launch, Open at login, keep-awake and the drive-unmounted health (docs/home-server-spec.md §2.2).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/server/config";
import { migrate } from "../src/server/db";
import { caffeinateArgs, LOGIN_AGENT_LABEL, LoginAgent, loginAgentPlist, ServeOnLaunch } from "../src/server/serveOnLaunch";
import { TvServer } from "../src/server/tv";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");

function fixture(o: { passive?: boolean; platform?: NodeJS.Platform } = {}) {
  const db = new Database(":memory:");
  migrate(db, MIGRATIONS);
  const dir = mkdtempSync(join(tmpdir(), "tuva-agents-"));
  const agent = new LoginAgent({ dir, launcher: "/Users/x/Applications/TuvaVideos.app/Contents/MacOS/TuvaVideos", logPath: "/tmp/launcher.log" });
  let on = false;
  const hooks = { start: [] as (() => void)[], stop: [] as (() => void)[] };
  const tv = {
    get on() {
      return on;
    },
    start: () => {
      on = true;
      hooks.start.forEach((f) => f());
      return { ok: true as const };
    },
    stop: () => {
      on = false;
      hooks.stop.forEach((f) => f());
    },
    onStart: (f: () => void) => void hooks.start.push(f),
    onStop: (f: () => void) => void hooks.stop.push(f),
  };
  const spawned: string[][] = [];
  let killed = 0;
  const sol = new ServeOnLaunch({
    db: db as never,
    tv,
    agent,
    passive: o.passive ?? false,
    platform: o.platform ?? "darwin",
    pid: 4242,
    spawn: (cmd) => {
      spawned.push(cmd);
      return { kill: () => void killed++ };
    },
  });
  return { sol, tv, agent, dir, spawned, killed: () => killed };
}

describe("LaunchAgent", () => {
  test("the plist starts the launcher with --background at load", () => {
    const p = loginAgentPlist({ launcher: "/a b/T&V", logPath: "/l.log" });
    expect(p).toContain(`<key>Label</key><string>${LOGIN_AGENT_LABEL}</string>`);
    expect(p).toContain("<string>/a b/T&amp;V</string>\n    <string>--background</string>");
    expect(p).toContain("<key>RunAtLoad</key><true/>");
  });

  test.skipIf(process.platform !== "darwin")("plutil accepts the generated plist", () => {
    const f = fixture();
    f.agent.install();
    const r = Bun.spawnSync(["plutil", "-lint", f.agent.path]);
    expect(r.exitCode).toBe(0);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("install and remove write only in the injected folder", () => {
    const f = fixture();
    expect(f.agent.installed()).toBe(false);
    f.agent.install();
    expect(existsSync(join(f.dir, `${LOGIN_AGENT_LABEL}.plist`))).toBe(true);
    expect(readFileSync(f.agent.path, "utf8")).toContain("--background");
    f.agent.remove();
    expect(f.agent.installed()).toBe(false);
    rmSync(f.dir, { recursive: true, force: true });
  });
});

describe("Serve on launch", () => {
  test("off by default: nothing starts, nothing is kept awake", () => {
    const f = fixture();
    expect(f.sol.state()).toEqual({ available: true, serveOnLaunch: false, openAtLogin: false });
    f.sol.applyAtLaunch();
    expect(f.tv.on).toBe(false);
    f.tv.start();
    expect(f.spawned).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("on: applyAtLaunch starts the Library Server and caffeinate -i -w <pid>; turning the server off ends it", () => {
    const f = fixture();
    expect(f.sol.set({ serveOnLaunch: true }).ok).toBe(true);
    f.sol.applyAtLaunch();
    expect(f.tv.on).toBe(true);
    expect(f.spawned).toEqual([["caffeinate", "-i", "-w", "4242"]]);
    f.tv.stop();
    expect(f.killed()).toBe(1);
    expect(f.sol.awakeRunning).toBe(false);
    f.tv.start();
    expect(f.spawned.length).toBe(2);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("Open at login needs Serve on launch; turning Serve on launch off removes the agent", () => {
    const f = fixture();
    expect(f.sol.set({ openAtLogin: true })).toEqual({ ok: false, error: "turn Serve on launch on first" });
    f.sol.set({ serveOnLaunch: true });
    expect(f.sol.set({ openAtLogin: true })).toMatchObject({ ok: true, state: { serveOnLaunch: true, openAtLogin: true } });
    expect(f.agent.installed()).toBe(true);
    expect(f.sol.set({ serveOnLaunch: false })).toMatchObject({ ok: true, state: { serveOnLaunch: false, openAtLogin: false } });
    expect(f.agent.installed()).toBe(false);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("unavailable on a passive server and off macOS", () => {
    for (const o of [{ passive: true }, { platform: "linux" as const }]) {
      const f = fixture(o);
      expect(f.sol.state().available).toBe(false);
      expect(f.sol.set({ serveOnLaunch: true }).ok).toBe(false);
      f.sol.applyAtLaunch();
      expect(f.tv.on).toBe(false);
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("caffeinateArgs", () => expect(caffeinateArgs(7)).toEqual(["caffeinate", "-i", "-w", "7"]));
});

describe("--background and the drive", () => {
  test("--background means no tab", () => {
    expect(loadConfig({}, "darwin", ["bun", "index.ts"]).openTab).toBe(true);
    expect(loadConfig({}, "darwin", ["bun", "index.ts", "--background"]).openTab).toBe(false);
  });

  test("health: drive is unmounted with no Root, or only unmounted Roots; mounted when any Root is", () => {
    const db = new Database(":memory:");
    migrate(db, MIGRATIONS);
    const health = (avail: boolean[]) =>
      new TvServer({
        cfg: { tvPort: 0, passive: false, webDir: "" },
        db: db as never,
        roots: { list: () => avail.map((_, i) => ({ id: i }) as never), isAvailable: (id: number) => avail[id]! },
      }).health().drive;
    expect(health([])).toBe("unmounted");
    expect(health([false, false])).toBe("unmounted");
    expect(health([false, true])).toBe("mounted");
  });
});
