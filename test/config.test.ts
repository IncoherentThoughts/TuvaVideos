// Config: which servers are passive (spec 3.2 Triggers).
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBin, loadConfig } from "../src/server/config";

test("a server on another port over the real library is passive; the main app and test data dirs are not", () => {
  expect(loadConfig({}).passive).toBe(false);
  expect(loadConfig({ TUVA_PORT: "4400" }).passive).toBe(false);
  expect(loadConfig({ TUVA_PORT: "4411" }).passive).toBe(true);
  expect(loadConfig({ TUVA_PORT: "0", TUVA_DATA_DIR: "/tmp/x" }).passive).toBe(false);
  expect(loadConfig({ TUVA_PORT: "4411", TUVA_DATA_DIR: "/tmp/x" }).passive).toBe(false);
});

test("TUVA_BIN_DIR comes first for ffmpeg, ffprobe and cwebp; a name it lacks falls through", () => {
  const dir = mkdtempSync(join(tmpdir(), "tuva-bin-"));
  try {
    for (const n of ["ffmpeg", "ffprobe", "cwebp"]) {
      writeFileSync(join(dir, n), "#!/bin/sh\n");
      chmodSync(join(dir, n), 0o755);
    }
    const cfg = loadConfig({ TUVA_BIN_DIR: dir });
    expect([cfg.ffmpeg, cfg.ffprobe, cfg.cwebp]).toEqual([join(dir, "ffmpeg"), join(dir, "ffprobe"), join(dir, "cwebp")]);
    expect(findBin("no-such-tool-xyz", { TUVA_BIN_DIR: dir })).toBe("no-such-tool-xyz");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
