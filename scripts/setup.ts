// `bun run setup` (docs/sharing-spec.md §8.3): checks what a fresh clone needs, creates the data dir, prints one line
// per check with the install command for anything missing, and exits non-zero while something required is missing.
// It never starts the app. Required: Bun >= 1.4, ffmpeg, ffprobe, cwebp. Optional: a trash command, yt-dlp, ImageMagick.
// The checks are pure given a probe (`planSetup`), so tests play every platform on any machine.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dataDirFor, findBin } from "../src/server/config";
import { defaultWhich, trashCommandFor, type Which } from "../src/server/platform";

export const MIN_BUN = "1.4.0";

export interface CheckLine {
  name: string;
  ok: boolean;
  required: boolean;
  /** What was found (a path or version), or why it is missing. */
  detail: string;
  /** The install command, when missing. */
  install?: string;
}

export interface SetupProbe {
  platform: NodeJS.Platform;
  bunVersion: string;
  /** Finds a binary (ffmpeg, cwebp, ...): its path or null. */
  findBin(name: string): string | null;
  /** For the trash check, like platform.ts's `Which`. */
  which: Which;
}

type Pm = "brew" | "apt" | "scoop";
const pmFor = (platform: NodeJS.Platform): Pm => (platform === "darwin" ? "brew" : platform === "win32" ? "scoop" : "apt");

/** The install command per tool and package manager (Homebrew on macOS, apt on Linux, Scoop on Windows). */
const PACKAGES: Record<string, Record<Pm, string>> = {
  ffmpeg: { brew: "brew install ffmpeg", apt: "sudo apt install ffmpeg", scoop: "scoop install ffmpeg" },
  ffprobe: { brew: "brew install ffmpeg", apt: "sudo apt install ffmpeg", scoop: "scoop install ffmpeg" },
  cwebp: { brew: "brew install webp", apt: "sudo apt install webp", scoop: "scoop install libwebp" },
  "yt-dlp": { brew: "brew install yt-dlp", apt: "pipx install yt-dlp", scoop: "scoop install yt-dlp" },
  magick: { brew: "brew install imagemagick", apt: "sudo apt install imagemagick", scoop: "scoop install imagemagick" },
  trash: {
    brew: "update to macOS 14 or later (it ships /usr/bin/trash)",
    apt: "sudo apt install trash-cli (or gio from libglib2.0-bin)",
    scoop: "PowerShell comes with Windows; check that powershell.exe is on PATH",
  },
};

const BUN_INSTALL: Record<Pm, string> = {
  brew: "curl -fsSL https://bun.sh/install | bash (or bun upgrade)",
  apt: "curl -fsSL https://bun.sh/install | bash (or bun upgrade)",
  scoop: 'powershell -c "irm bun.sh/install.ps1 | iex" (or bun upgrade)',
};

/** Semver-ish compare of "x.y.z" prefixes; a pre-release suffix is ignored. */
export function versionAtLeast(have: string, want: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(have);
  const b = parse(want);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** Every check, in print order. Pure given the probe. */
export function planSetup(p: SetupProbe): CheckLine[] {
  const pm = pmFor(p.platform);
  const lines: CheckLine[] = [];
  const bunOk = versionAtLeast(p.bunVersion, MIN_BUN);
  lines.push({
    name: "bun",
    ok: bunOk,
    required: true,
    detail: bunOk ? p.bunVersion : `${p.bunVersion} is older than ${MIN_BUN}`,
    ...(bunOk ? {} : { install: BUN_INSTALL[pm] }),
  });
  const tool = (name: string, required: boolean, label = name) => {
    const at = p.findBin(name);
    lines.push({
      name: label,
      ok: !!at,
      required,
      detail: at ?? "not found",
      ...(at ? {} : { install: PACKAGES[name]![pm] }),
    });
  };
  tool("ffmpeg", true);
  tool("ffprobe", true);
  tool("cwebp", true);
  const trash = trashCommandFor(p.platform, p.which);
  lines.push({
    name: "trash",
    ok: !!trash,
    required: false,
    detail: trash ? trash.label : "not found: deleting will keep files on disk (entry-only delete)",
    ...(trash ? {} : { install: PACKAGES.trash![pm] }),
  });
  tool("yt-dlp", false);
  tool("magick", false, "imagemagick");
  return lines;
}

export function formatLine(l: CheckLine): string {
  const mark = l.ok ? "ok     " : l.required ? "MISSING" : "missing";
  const kind = l.required ? "" : " (optional)";
  return `${mark} ${l.name}${kind}: ${l.detail}${l.install ? ` -> ${l.install}` : ""}`;
}

/** Non-zero while anything required is missing. */
export const exitCodeFor = (lines: CheckLine[]) => (lines.some((l) => l.required && !l.ok) ? 1 : 0);

if (import.meta.main) {
  const env = process.env;
  const lines = planSetup({
    platform: process.platform,
    bunVersion: Bun.version,
    findBin: (n) => {
      const at = findBin(n, env);
      return at !== n ? at : null;
    },
    which: defaultWhich,
  });
  for (const l of lines) console.log(formatLine(l));
  const dataDir = dataDirFor(process.platform, env, homedir());
  try {
    mkdirSync(dataDir, { recursive: true });
    console.log(`ok      data dir: ${dataDir}`);
  } catch (e) {
    console.log(`MISSING data dir: could not create ${dataDir}: ${(e as Error).message}`);
    process.exit(1);
  }
  const code = exitCodeFor(lines);
  console.log(code === 0 ? "Ready. Start the app with: bun run start" : "Install what is MISSING above, then run bun run setup again.");
  process.exit(code);
}
