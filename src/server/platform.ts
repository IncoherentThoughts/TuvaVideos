// Platform shims (docs/sharing-spec.md §8.2): which command moves a file to the Trash and which opens the app's tab.
// The data dir per platform is `dataDirFor` in config.ts. Selection is pure given its arguments; `which` is injected
// so tests can play every platform on any machine. The `.app` launcher (scripts/make-app.ts) stays macOS-only.
import { existsSync } from "node:fs";

/** Finds a command: an absolute path if it exists, else a name on PATH. Null when absent. */
export type Which = (name: string) => string | null;

/** A command line: `cmd` with `args`. */
export interface Command {
  cmd: string;
  args: string[];
}

/** How to trash one file, and what to call it in messages. */
export interface TrashCommand {
  /** "trash", "gio trash", "trash-put", "PowerShell Recycle Bin" or the override's path. */
  label: string;
  argv(path: string): Command;
}

/** The macOS trash command (macOS 14+ ships it). Also the default `Config.trash`. */
export const MAC_TRASH = "/usr/bin/trash";

/** What deleting says when this machine has no trash command: only the entry-only delete is offered. */
export const NO_TRASH_NOTICE =
  "No trash command was found on this machine, so deleting removes the library entry only and the files stay on disk. " +
  "Run `bun run setup` to see how to install one.";

/** PowerShell: send one file to the Recycle Bin through Microsoft.VisualBasic (no extra install). The path is argv, not code. */
const PS_RECYCLE =
  "Add-Type -AssemblyName Microsoft.VisualBasic; " +
  "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($args[0], 'OnlyErrorDialogs', 'SendToRecycleBin')";

export const defaultWhich: Which = (name) => (name.startsWith("/") ? (existsSync(name) ? name : null) : Bun.which(name));

/**
 * The trash command for this platform, or null when there is none (§8.2): macOS `/usr/bin/trash`; Linux and the
 * other Unixes `gio trash`, then `trash-put`; Windows a PowerShell Recycle Bin call. `override` (the `TUVA_TRASH`
 * path, used by tests) wins everywhere.
 */
export function trashCommandFor(platform: NodeJS.Platform, which: Which, override?: string): TrashCommand | null {
  if (override) return { label: override, argv: (p) => ({ cmd: override, args: [p] }) };
  if (platform === "darwin") {
    const t = which(MAC_TRASH);
    return t ? { label: "trash", argv: (p) => ({ cmd: t, args: [p] }) } : null;
  }
  if (platform === "win32") {
    const ps = which("powershell") ?? which("pwsh");
    return ps
      ? { label: "PowerShell Recycle Bin", argv: (p) => ({ cmd: ps, args: ["-NoProfile", "-NonInteractive", "-Command", PS_RECYCLE, p] }) }
      : null;
  }
  const gio = which("gio");
  if (gio) return { label: "gio trash", argv: (p) => ({ cmd: gio, args: ["trash", p] }) };
  const tp = which("trash-put");
  if (tp) return { label: "trash-put", argv: (p) => ({ cmd: tp, args: [p] }) };
  return null;
}

/**
 * The trash command the companion uses. `configured` is `Config.trash`: anything other than the macOS default is the
 * `TUVA_TRASH` override; the default means "resolve for this platform".
 */
export function resolveTrash(
  configured: string,
  platform: NodeJS.Platform = process.platform,
  which: Which = defaultWhich,
): TrashCommand | null {
  return trashCommandFor(platform, which, configured && configured !== MAC_TRASH ? configured : undefined);
}

/** The command that opens `url` in the default browser: `open` / `xdg-open` / `cmd /c start`. */
export function openCommandFor(platform: NodeJS.Platform, url: string): Command {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  // `start` takes its first quoted argument as a window title, so an empty title goes before the URL.
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: [url] };
}
