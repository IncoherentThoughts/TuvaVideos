// Hashing gives up on a read that stops delivering bytes (audit DB-10): a hung drive no longer stalls the scanner for good.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256File } from "../src/server/hash";

const dir = mkdtempSync(join(tmpdir(), "tuva-hash-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a normal file hashes", async () => {
  writeFileSync(join(dir, "a"), "abc");
  expect(await sha256File(join(dir, "a"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("a read that stalls mid-file fails as an I/O timeout after the retries", async () => {
  const fifo = join(dir, "stuck");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  // a writer that sends a few bytes and then hangs with the pipe open, like a drive that stops answering
  const writer = Bun.spawn(["/bin/sh", "-c", `exec 3>"${fifo}"; printf abc >&3; exec sleep 30`]);
  try {
    const t0 = Date.now();
    const err = await sha256File(fifo, { stallMs: 200, retryDelayMs: 10 }).then(() => null, (e) => e);
    expect(err?.code).toBe("ETIMEDOUT");
    expect(String(err.message)).toContain("stalled");
    expect(Date.now() - t0).toBeLessThan(5000);
  } finally {
    writer.kill();
  }
});
