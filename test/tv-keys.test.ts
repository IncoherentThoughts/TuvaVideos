import { expect, test } from "bun:test"
import { renderKeysJs } from "../scripts/tv-install.ts"
import { TV_KEYS, keyName, registeredKeyNames } from "../src/tv/keys.ts"

test("every registered key has a Tizen code and no two keys share one", () => {
  for (const k of TV_KEYS.filter((k) => k.registered)) {
    expect(Number.isInteger(k.code) && k.code > 0).toBe(true)
    expect(k.name.length).toBeGreaterThan(0)
  }
  const codes = TV_KEYS.map((k) => k.code)
  expect(new Set(codes).size).toBe(codes.length)
  const names = TV_KEYS.map((k) => k.name)
  expect(new Set(names).size).toBe(names.length)
})

test("the §8 codes", () => {
  const expected: Record<string, number> = {
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Back: 10009, Exit: 10182,
    ChannelUp: 427, ChannelDown: 428, MediaPlayPause: 10252, MediaPlay: 415, MediaPause: 19,
    MediaRewind: 412, MediaFastForward: 417, MediaTrackPrevious: 10232, MediaTrackNext: 10233,
    ColorF0Red: 403, ColorF1Green: 404, ColorF2Yellow: 405, ColorF3Blue: 406, Info: 457, "0": 48, "9": 57,
  }
  for (const [name, code] of Object.entries(expected)) expect(TV_KEYS.find((k) => k.name === name)?.code).toBe(code)
})

test("arrows, Enter, Back and Exit arrive unregistered; the rest is registered", () => {
  for (const n of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Enter", "Back", "Exit"]) {
    expect(TV_KEYS.find((k) => k.name === n)?.registered).toBe(false)
  }
  expect(registeredKeyNames()).toContain("MediaPlayPause")
  expect(registeredKeyNames()).not.toContain("Back")
})

test("keyName looks a code up", () => {
  expect(keyName(10009)).toBe("Back")
  expect(keyName(405)).toBe("ColorF2Yellow")
  expect(keyName(48)).toBe("0")
  expect(keyName(1)).toBeUndefined()
})

test("tv/shell/keys.js is the generated copy of the table", async () => {
  expect(await Bun.file(new URL("../tv/shell/keys.js", import.meta.url)).text()).toBe(renderKeysJs())
})
