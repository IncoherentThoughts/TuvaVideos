// bun run tv-install [--permit] [--keys]
// Builds, signs and installs the TV shell (tv/shell/) on the Samsung TV named in tv/shell/tv.json (docs/tv-spec.md §4.4).
//   --permit  run `tizen install-permit` first (once per distributor certificate)
//   --keys    only regenerate tv/shell/keys.js from src/tv/keys.ts and stop
// Prints every command and stops at the first failure with the Tizen output (sdb and tizen often exit 0 on failure,
// so the output is checked as well).
import { existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { TV_KEYS } from "../src/tv/keys.ts"

const ROOT = resolve(import.meta.dir, "..")
const SHELL_DIR = join(ROOT, "tv/shell")
const KEYS_JS = join(SHELL_DIR, "keys.js")

/** tv/shell/keys.js: the §8 table for the plain-JS shell and for the UI (window.TuvaKeys). Generated, not hand-edited. */
export function renderKeysJs(): string {
  const rows = TV_KEYS.map((k) => `  { name: ${JSON.stringify(k.name)}, code: ${k.code}, registered: ${k.registered} },`).join("\n")
  return `// GENERATED from src/tv/keys.ts by \`bun run tv-install\` (or \`bun scripts/tv-install.ts --keys\`). Do not edit.
(function (root) {
  "use strict"
  const table = [
${rows}
  ]
  function keyName(keyCode) {
    const k = table.find((t) => t.code === keyCode)
    return k ? k.name : undefined
  }
  root.TuvaKeys = { table, keyName }
})(typeof globalThis !== "undefined" ? globalThis : window)
`
}

export type TvConfig = { ip: string; target: string; duid: string; mac: string }

type Step = { label: string; cmd: string[]; ok?: (out: string) => boolean; after?: () => void }

export function planSteps(tv: TvConfig, opts: { permit: boolean; tizen: string; sdb: string }): Step[] {
  const { tizen, sdb } = opts
  const steps: Step[] = [
    { label: "connect", cmd: [sdb, "connect", tv.ip], ok: (o) => /connected to|already connected/i.test(o) && !/fail|unable/i.test(o) },
  ]
  if (opts.permit) steps.push({ label: "install-permit", cmd: [tizen, "install-permit", "-t", tv.target] })
  steps.push(
    {
      label: "build-web",
      cmd: [tizen, "build-web", "-e", "README.md", "-e", "*.wgt", "-e", "tv.json", "-e", ".gitignore", "--", "."],
    },
    {
      label: "package",
      cmd: [tizen, "package", "-t", "wgt", "-s", "TuvaVideos", "-o", ".", "--", ".buildResult"],
      after: () => {
        const made = readdirSync(SHELL_DIR).find((f) => f.endsWith(".wgt") && f !== "TuvaTV.wgt")
        if (made) renameSync(join(SHELL_DIR, made), join(SHELL_DIR, "TuvaTV.wgt"))
      },
    },
    { label: "install", cmd: [tizen, "install", "-n", "TuvaTV.wgt", "-t", tv.target] },
    { label: "run", cmd: [tizen, "run", "-p", "TuvaVideos.TuvaTV", "-t", tv.target] },
  )
  return steps
}

async function exec(cmd: string[], cwd: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out: (o + e).trim() }
}

async function main() {
  const args = process.argv.slice(2)
  writeFileSync(KEYS_JS, renderKeysJs())
  console.log(`wrote ${KEYS_JS}`)
  if (args.includes("--keys")) return

  const tv = (await Bun.file(join(SHELL_DIR, "tv.json")).json()) as TvConfig
  const tools = join(homedir(), "tizen-studio/tools")
  const tizen = join(tools, "ide/bin/tizen")
  const sdb = join(tools, "sdb")
  for (const bin of [tizen, sdb]) {
    if (!existsSync(bin)) {
      console.error(`Missing ${bin}. Tizen Studio is expected at ~/tizen-studio (see tv/shell/README.md).`)
      process.exit(1)
    }
  }
  rmSync(join(SHELL_DIR, ".buildResult"), { recursive: true, force: true })
  rmSync(join(SHELL_DIR, "TuvaTV.wgt"), { force: true })

  for (const step of planSteps(tv, { permit: args.includes("--permit"), tizen, sdb })) {
    console.log(`\n$ ${step.cmd.map((a) => (/[\s*]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`)
    const { code, out } = await exec(step.cmd, SHELL_DIR)
    if (out) console.log(out)
    const bad = code !== 0 || /\b(failed|error)\b/i.test(out) || (step.ok ? !step.ok(out) : false)
    if (bad) {
      console.error(`\ntv-install stopped at "${step.label}" (exit ${code}). See tv/shell/README.md for the checklist.`)
      process.exit(1)
    }
    step.after?.()
  }
  console.log("\nInstalled and launched TuvaVideos on the TV.")
}

if (import.meta.main) await main()
