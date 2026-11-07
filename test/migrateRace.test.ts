// Two processes migrating one fresh library.db at once (audit DB-7): both start, neither crashes, the result is whole.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationFiles, openDb } from "../src/server/db";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const DB_TS = join(import.meta.dir, "..", "src", "server", "db.ts");
const dir = mkdtempSync(join(tmpdir(), "tuva-migrace-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const script = `import { openDb } from ${JSON.stringify(DB_TS)};
try { openDb(process.argv[1], ${JSON.stringify(MIGRATIONS)}).close(); console.log("OK"); } catch (e) { console.log("FAIL " + (e?.stack ?? e).split("\\n").slice(0, 4).join(" | ")); }`;

test("concurrent migrators both succeed", async () => {
  for (let run = 0; run < 3; run++) {
    const file = join(dir, `lib${run}.db`);
    const procs = [0, 1, 2].map(() => Bun.spawn([process.execPath, "-e", script, file], { stdout: "pipe", stderr: "ignore" }));
    const outs = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim().split("\n").at(-1)));
    expect(outs).toEqual(["OK", "OK", "OK"]);
    const db = openDb(file, MIGRATIONS);
    expect((db.query("SELECT COUNT(*) AS n FROM migration").get() as { n: number }).n).toBe(migrationFiles(MIGRATIONS).length);
    expect((db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    db.close();
  }
}, 60_000);
