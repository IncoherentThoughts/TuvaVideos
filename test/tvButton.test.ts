import { describe, expect, test } from "bun:test"
import { splitAddress, tvLabel } from "../src/web/TvButton"
import type { TvStateDto } from "../src/shared/types"

describe("TV button (tv-spec 2.4)", () => {
  test("splitAddress: the last number is what the TV's number pad needs", () => {
    expect(splitAddress("192.168.4.83")).toEqual({ head: "192.168.4.", last: "83" })
    expect(splitAddress("10.0.0.7")).toEqual({ head: "10.0.0.", last: "7" })
    expect(splitAddress("weird")).toEqual({ head: "", last: "weird" })
  })

  test("the label names the Mac's address while on and nobody is talking", () => {
    const s: TvStateDto = { available: true, on: true, port: 4401, addresses: ["192.168.4.83"], pending: [], approved: [], playing: null }
    expect(tvLabel(s)).toBe("TV on · 192.168.4.83:4401")
    expect(tvLabel({ ...s, on: false })).toBe("TV")
  })
})
