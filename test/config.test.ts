// Config: which servers are passive (spec 3.2 Triggers).
import { expect, test } from "bun:test";
import { loadConfig } from "../src/server/config";

test("a server on another port over the real library is passive; the main app and test data dirs are not", () => {
  expect(loadConfig({}).passive).toBe(false);
  expect(loadConfig({ TUVA_PORT: "4400" }).passive).toBe(false);
  expect(loadConfig({ TUVA_PORT: "4411" }).passive).toBe(true);
  expect(loadConfig({ TUVA_PORT: "0", TUVA_DATA_DIR: "/tmp/x" }).passive).toBe(false);
  expect(loadConfig({ TUVA_PORT: "4411", TUVA_DATA_DIR: "/tmp/x" }).passive).toBe(false);
});
