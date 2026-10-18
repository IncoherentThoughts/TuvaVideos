// The Root field of first launch (docs/sharing-spec.md §8.4): an absolute path typed by hand (`~` expanded), checked
// here before the `root` row is inserted, and which onboarding surface the grid shows. The decisions are pure; the
// filesystem check takes its reads as an argument so tests can drive every error.
import { opendir, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { MachineMode } from "./localCopy/meta";

/** The inline errors of §8.4, plus one for a path that is not absolute. */
export type RootPathError = "Not found" | "Not a folder" | "Can't read it" | "Enter the folder's full path";

export type RootPathResult = { ok: true; path: string } | { ok: false; error: RootPathError };

/** `~` and `~/…` become the home directory; anything else is left as typed (trimmed). */
export function expandHome(input: string, home: string): string {
  const t = input.trim();
  if (t === "~") return home;
  if (t.startsWith("~/") || t.startsWith("~\\")) return home.replace(/[\\/]+$/, "") + t.slice(1);
  return t;
}

/** The typed text as a normalized absolute path (no trailing separator), or the error to show under the field. */
export function parseRootInput(input: string, home: string, abs: (p: string) => boolean = isAbsolute): RootPathResult {
  const p = expandHome(input, home);
  if (!p || !abs(p)) return { ok: false, error: "Enter the folder's full path" };
  let n = normalize(p);
  if (n.length > 1 && /[\\/]$/.test(n) && !/^[A-Za-z]:[\\/]$/.test(n)) n = n.slice(0, -1);
  return { ok: true, path: n };
}

/** An fs error code as the inline error. */
export function rootErrorFor(code: string | undefined): RootPathError {
  if (code === "ENOENT") return "Not found";
  if (code === "ENOTDIR") return "Not a folder";
  return "Can't read it"; // EACCES, EPERM (macOS privacy prompts), EIO, anything else
}

export interface RootFs {
  isDirectory(path: string): Promise<boolean>;
  /** Opens the directory for listing; throws with the fs `code` when it cannot. */
  canList(path: string): Promise<void>;
}

const realFs: RootFs = {
  isDirectory: (p) => stat(p).then((s) => s.isDirectory()),
  canList: async (p) => {
    // One entry read: opening alone is lazy under Bun and would pass an unreadable folder.
    const d = await opendir(p);
    try {
      await d.read();
    } finally {
      await d.close().catch(() => {});
    }
  },
};

/** Exists, is a directory, readable: the companion's check before the `root` row is inserted. */
export async function checkRootPath(input: string, home: string, fs: RootFs = realFs): Promise<RootPathResult> {
  const parsed = parseRootInput(input, home);
  if (!parsed.ok) return parsed;
  try {
    if (!(await fs.isDirectory(parsed.path))) return { ok: false, error: "Not a folder" };
    await fs.canList(parsed.path);
  } catch (e) {
    return { ok: false, error: rootErrorFor((e as { code?: string }).code) };
  }
  return parsed;
}

/**
 * Which onboarding surface the Library shows (§8.4). No Root and no grant: the first-launch panel (folder field, Sign
 * in). No Root with the grant (Member or Video Editor): a Member may run with no Root, so only the one-line "No videos
 * folder yet" bar, until dismissed on this machine. With a Root: nothing.
 */
export type Onboarding = "panel" | "bar" | "none";

export function onboardingFor(o: { mode: MachineMode; rootCount: number; barDismissed: boolean }): Onboarding {
  if (o.rootCount > 0) return "none";
  if (o.mode === "member" || o.mode === "editor") return o.barDismissed ? "none" : "bar";
  return "panel";
}

/** The `meta` key that remembers the dismissed bar, per machine (it lives in the machine's `library.db`). */
export const ROOT_BAR_DISMISSED = "root_bar_dismissed";
