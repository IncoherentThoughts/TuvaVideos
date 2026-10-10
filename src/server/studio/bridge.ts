// The Music.app bridge (spec 7.1, ADR-0003): one resident `osascript -l JavaScript` child started on first use, JSON
// commands on its stdin, one JSON line back per command, restarted if it dies. A command that fails or does not answer
// within the timeout surfaces as `BridgeRefused` (the UI shows "Music.app refused — check System Settings › Automation").
// Tracks are addressed by persistent ID only. Nothing here reads files: many tracks are FairPlay or stream-only.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { run } from "../proc";
import { log } from "../log";

export const REFUSED_MESSAGE = "Music.app refused — check System Settings › Automation";

export class BridgeRefused extends Error {
  constructor(public detail: string) {
    super(`${REFUSED_MESSAGE} (${detail})`);
  }
}

export interface PlayerState {
  /** Music.app's `player state`: playing, paused, stopped, fast forwarding, rewinding. */
  state: string;
  position: number | null;
  duration: number | null;
  /** `currentTrack.persistentID`; null when nothing is loaded. */
  persistentId: string | null;
}

export interface PlayResult extends PlayerState {
  /** false: `whose({persistentID})` was empty (a stale id, spec 7.3); nothing was started. */
  found: boolean;
}

/** What the rest of the server needs of Music.app. Tests inject a fake; nothing but ResidentBridge touches the real one. */
export interface Bridge {
  state(): Promise<PlayerState>;
  play(persistentId: string): Promise<PlayResult>;
  pause(): Promise<PlayerState>;
  resume(): Promise<PlayerState>;
  seek(seconds: number): Promise<PlayerState>;
  stop(): Promise<PlayerState>;
  close(): void;
}

/** The JXA the child runs: a stdin line loop. Ids are ASCII hex, so chunk boundaries cannot split a character that matters. */
export const BRIDGE_SCRIPT = `
ObjC.import('Foundation');
const M = Application('Music');
const inH = $.NSFileHandle.fileHandleWithStandardInput;
const outH = $.NSFileHandle.fileHandleWithStandardOutput;
function send(o) { outH.writeData($(JSON.stringify(o) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
function snap() {
  const r = { state: M.playerState(), position: null, duration: null, persistentId: null };
  try { r.position = M.playerPosition(); } catch (e) {}
  try { const t = M.currentTrack; r.persistentId = t.persistentID(); r.duration = t.duration(); } catch (e) {}
  return r;
}
function handle(c) {
  switch (c.cmd) {
    case 'state': return snap();
    case 'play': {
      const hits = M.libraryPlaylists[0].tracks.whose({ persistentID: c.persistentId })();
      if (!hits.length) return Object.assign({ found: false }, snap());
      M.play(hits[0], { once: true });
      return Object.assign({ found: true }, snap());
    }
    case 'pause': M.pause(); return snap();
    case 'resume': M.play(); return snap();
    case 'seek': M.playerPosition = c.seconds; return snap();
    case 'stop': M.stop(); return snap();
    default: throw new Error('unknown command ' + c.cmd);
  }
}
let buf = '';
for (;;) {
  const d = inH.availableData;
  if (d.length === 0) break;
  buf += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding));
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let id = null;
    try { const c = JSON.parse(line); id = c.id; send(Object.assign({ id: id, ok: true }, handle(c))); }
    catch (e) { send({ id: id, ok: false, error: String(e) }); }
  }
}
`;

export interface ResidentOptions {
  /** argv of the child; default `osascript -l JavaScript -e <BRIDGE_SCRIPT>`. Tests point it at a fake. */
  argv?: string[];
  /** A command that has not answered after this long is treated as refused and the child is killed. */
  timeoutMs?: number;
}

interface Pending {
  resolve(v: Record<string, unknown>): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class ResidentBridge implements Bridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = "";
  private closed = false;
  /** How many times the child has been started; the tests watch it for the restart. */
  starts = 0;
  private argv: string[];
  private timeoutMs: number;

  constructor(opts: ResidentOptions = {}) {
    this.argv = opts.argv ?? ["osascript", "-l", "JavaScript", "-e", BRIDGE_SCRIPT];
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const [cmd, ...args] = this.argv;
    const c = spawn(cmd!, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.starts++;
    this.buf = "";
    c.stdout.on("data", (d: Buffer) => this.onData(c, d.toString("utf8")));
    c.stderr.on("data", (d: Buffer) => log("music bridge stderr:", d.toString("utf8").trim().slice(0, 300)));
    c.stdin.on("error", () => {}); // EPIPE after a death is reported through the exit path
    const gone = (why: string) => {
      if (this.child !== c) return;
      this.child = null;
      this.failAll(new BridgeRefused(why));
    };
    c.on("error", (e) => gone(`could not start osascript: ${e.message}`));
    c.on("exit", (code, sig) => gone(`osascript exited (${sig ?? code})`));
    this.child = c;
    return c;
  }

  private onData(c: ChildProcessWithoutNullStreams, chunk: string) {
    if (c !== this.child) return;
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.pending.get(msg.id as number);
      if (!p) continue;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new BridgeRefused(String(msg.error ?? "command failed")));
      else p.resolve(msg);
    }
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  private send(cmd: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new BridgeRefused("server is stopping"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.ensure();
      } catch (e) {
        return reject(new BridgeRefused(String(e)));
      }
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new BridgeRefused(`no answer within ${this.timeoutMs} ms`));
        // A child that is stuck (an Automation prompt nobody answered, Music.app hung) is killed; the next command restarts it.
        if (this.child === child) {
          this.child = null;
          this.failAll(new BridgeRefused("bridge restarted after a timeout"));
        }
        child.kill("SIGKILL");
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, cmd, ...extra }) + "\n");
    });
  }

  private static state(m: Record<string, unknown>): PlayerState {
    return {
      state: String(m.state ?? "stopped"),
      position: typeof m.position === "number" ? m.position : null,
      duration: typeof m.duration === "number" ? m.duration : null,
      persistentId: typeof m.persistentId === "string" ? m.persistentId : null,
    };
  }

  async state() {
    return ResidentBridge.state(await this.send("state"));
  }
  async play(persistentId: string): Promise<PlayResult> {
    const m = await this.send("play", { persistentId });
    return { found: m.found !== false, ...ResidentBridge.state(m) };
  }
  async pause() {
    return ResidentBridge.state(await this.send("pause"));
  }
  async resume() {
    return ResidentBridge.state(await this.send("resume"));
  }
  async seek(seconds: number) {
    return ResidentBridge.state(await this.send("seek", { seconds }));
  }
  async stop() {
    return ResidentBridge.state(await this.send("stop"));
  }

  close() {
    this.closed = true;
    this.failAll(new BridgeRefused("server is stopping"));
    const c = this.child;
    this.child = null;
    if (c) {
      try {
        c.stdin.end();
      } catch {}
      c.kill("SIGKILL");
    }
  }
}

/**
 * The launch-time read (spec 9): one `playerState()` so the macOS Automation prompt appears when the server starts,
 * not on the first `t`. A separate short-lived osascript, killed after 10 s; never throws.
 */
export async function probeAutomation(timeoutMs = 10_000): Promise<{ ok: boolean; state?: string; error?: string; ms: number }> {
  const t0 = performance.now();
  const r = await run("osascript", ["-l", "JavaScript", "-e", "Application('Music').playerState()"], { timeout: timeoutMs });
  const ms = Math.round(performance.now() - t0);
  if (r.code === 0) return { ok: true, state: r.out.trim(), ms };
  return { ok: false, error: (r.err || `exit ${r.code}`).trim().slice(0, 300), ms };
}
