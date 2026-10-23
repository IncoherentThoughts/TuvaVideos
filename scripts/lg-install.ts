// bun run lg-install [device]
// Packages and installs the TV shell (tv/shell/) on an LG webOS TV in Developer Mode, the LG counterpart of
// tv-install. `device` is the name given to `ares-setup-device` (default "lgtv"); see tv/shell/README.md.
// Needs the webOS CLI, installed with npm (bun's install ignores its pinned dependencies and ares-package breaks):
//   bunx npm@10 install --prefix ~/.webos-cli @webos-tools/cli      (found there or on PATH)
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { renderKeysJs } from "./tv-install.ts"

const ROOT = resolve(import.meta.dir, "..")
const SHELL_DIR = join(ROOT, "tv/shell")
const APP_ID = "local.tuvavideos.tuvatv" // tv/shell/appinfo.json

/** An ares tool from PATH, else from ~/.webos-cli (see the install line above). */
function ares(name: string): string | null {
  const local = join(homedir(), ".webos-cli/node_modules/.bin", name)
  return Bun.which(name) ?? (existsSync(local) ? local : null)
}

async function run(cmd: string[]): Promise<string> {
  console.log(`\n$ ${cmd.join(" ")}`)
  const p = Bun.spawn(cmd, { cwd: SHELL_DIR, stdout: "pipe", stderr: "pipe" })
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const out = (o + e).trim()
  if (out) console.log(out)
  if ((await p.exited) !== 0 || /\berror\b/i.test(out)) {
    console.error(`\nlg-install stopped at "${cmd[0].split("/").pop()}". See tv/shell/README.md (Install on an LG TV).`)
    process.exit(1)
  }
  return out
}

async function main() {
  const device = process.argv[2] || "lgtv"
  const [pkg, install, launch] = ["ares-package", "ares-install", "ares-launch"].map(ares)
  if (!pkg || !install || !launch) {
    console.error("Missing the webOS CLI. Install it: bunx npm@10 install --prefix ~/.webos-cli @webos-tools/cli")
    process.exit(1)
  }
  writeFileSync(join(SHELL_DIR, "keys.js"), renderKeysJs())
  const out = mkdtempSync(join(tmpdir(), "tuva-ipk-"))
  try {
    const exclude = ["README.md", "tv.json", "config.xml", "icon.png", "*.wgt", "*.ipk", ".buildResult", ".gitignore"]
    await run([pkg, "--no-minify", ...exclude.flatMap((x) => ["-e", x]), "-o", out, "."])
    const ipk = readdirSync(out).find((f) => f.endsWith(".ipk"))
    if (!ipk) throw new Error("ares-package made no .ipk")
    await run([install, "-d", device, join(out, ipk)])
    await run([launch, "-d", device, APP_ID])
    console.log("\nInstalled and launched TuvaVideos on the LG TV.")
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
