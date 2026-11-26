// What `GET /api/health` answers on the Library Server (docs/home-server-spec.md §2.1).
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * The wire string of `app`. Installed TV shells match on it (`HEALTH_MARK` in tv/shell/discovery.js), and a shell change
 * costs a reinstall, so it stays "TuvaVideos TV Server" although the thing is the Library Server now.
 */
export const HEALTH_APP = "TuvaVideos TV Server";
/** The name people read: the top bar, the TV page's title. */
export const LIBRARY_SERVER_NAME = "Library Server";

export interface HealthDto {
  app: string;
  /** The Mac's computer name. */
  name: string;
  /** True on the Home Server (set from the Home Server toggle, #240). */
  home: boolean;
  /** "mounted" when any Root is mounted, else "unmounted". */
  drive: "mounted" | "unmounted";
  /** The app's commit (short), or the package version when it is not a checkout. */
  version: string;
}

/** Pure: the health answer for the facts it is made of. */
export function healthBody(f: { name: string; home: boolean; rootsMounted: readonly boolean[]; version: string }): HealthDto {
  return { app: HEALTH_APP, name: f.name, home: f.home, drive: f.rootsMounted.some(Boolean) ? "mounted" : "unmounted", version: f.version };
}

let cachedName: string | undefined;
/** The Mac's computer name (System Settings > General > About), else its hostname. Asked once. */
export function computerName(): string {
  if (cachedName) return cachedName;
  let n = "";
  if (process.platform === "darwin") {
    try {
      n = Bun.spawnSync(["/usr/sbin/scutil", "--get", "ComputerName"]).stdout.toString().trim();
    } catch {}
  }
  return (cachedName = n || hostname().replace(/\.local$/, ""));
}

let cachedVersion: string | undefined;
/** The checkout's short commit (`TUVA_VERSION` overrides, for tests), else package.json's version. Asked once. */
export function appVersion(): string {
  if (process.env.TUVA_VERSION) return process.env.TUVA_VERSION;
  if (cachedVersion) return cachedVersion;
  const root = join(import.meta.dir, "..", "..");
  let v = "";
  try {
    v = Bun.spawnSync(["git", "-C", root, "rev-parse", "--short", "HEAD"]).stdout.toString().trim();
  } catch {}
  if (!v) {
    try {
      v = String((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "");
    } catch {}
  }
  return (cachedVersion = v || "unknown");
}
