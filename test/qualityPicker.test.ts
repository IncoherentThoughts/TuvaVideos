// The quality pick's pure parts (docs/home-server-spec.md 7.1, 7.2, 10): the options for a Copy, what another Copy
// keeps, the Live stream URLs for this Mac's and the Home Server's Copies, how the desktop Player plays HLS, and
// the busy answer.
import { describe, expect, test } from "bun:test";
import { liveRoute } from "../src/shared/copies";
import { busyMessage, hlsMode, keepQuality, qualityLabel, qualityOptions, readBusy } from "../src/shared/liveQuality";
import { liveUrl, playsLive } from "../src/tv/copies";

describe("quality options", () => {
  test("Original first, then each size below the Copy's short edge; none above or at it", () => {
    expect(qualityOptions(3840, 2160)).toEqual(["orig", "1080", "720", "480"]);
    expect(qualityOptions(1920, 1080)).toEqual(["orig", "720", "480"]);
    expect(qualityOptions(1280, 720)).toEqual(["orig", "480"]);
    expect(qualityOptions(854, 480)).toEqual(["orig"]);
    expect(qualityOptions(1080, 1920)).toEqual(["orig", "720", "480"]); // portrait: the short edge
    expect(qualityOptions(null, null)).toEqual(["orig"]); // size not known: nothing to offer
  });

  test("labels", () => {
    expect(["orig", "1080", "720", "480"].map((q) => qualityLabel(q as "orig"))).toEqual(["Original", "1080p", "720p", "480p"]);
  });

  test("another Copy keeps the pick when it offers it, else Original", () => {
    expect(keepQuality("720", 1920, 1080)).toBe("720");
    expect(keepQuality("1080", 1920, 1080)).toBe("orig"); // a 1080p Copy has no 1080p Live stream
    expect(keepQuality("480", 640, 360)).toBe("orig");
    expect(keepQuality("orig", 640, 360)).toBe("orig");
  });
});

describe("Live stream URLs", () => {
  test("this Mac's Copy, and a Home Server Copy through the companion's proxy by its id there", () => {
    expect(liveRoute({ id: 12 }, "720")).toBe("/live/12/index.m3u8?q=720");
    expect(liveRoute({ id: -40, homeId: 40 }, "480")).toBe("/home/live/40/index.m3u8?q=480");
    expect(liveRoute({ id: 3 }, "orig")).toBe("/live/3/index.m3u8?q=orig");
  });

  test("the TV asks for the picked quality; Original stays the default", () => {
    expect(liveUrl(7)).toBe("/live/7/index.m3u8?q=orig");
    expect(liveUrl(7, "480")).toBe("/live/7/index.m3u8?q=480");
  });

  test("the TV plays a Live stream for a quality below Original, or for a Copy it does not play as-is", () => {
    const plays = { id: 1, rootKind: "local" as const, available: true, tv: { order: "file" } } as Parameters<typeof playsLive>[0];
    const live = { ...plays, tv: { order: "live" } } as Parameters<typeof playsLive>[0];
    expect(playsLive(plays, "orig")).toBe(false);
    expect(playsLive(plays, "720")).toBe(true);
    expect(playsLive(live, "orig")).toBe(true);
  });
});

describe("how the desktop Player plays HLS", () => {
  test("native when canPlayType answers, else hls.js when MSE is there, else not at all", () => {
    expect(hlsMode("maybe", true)).toBe("native");
    expect(hlsMode("probably", false)).toBe("native");
    expect(hlsMode("", true)).toBe("hlsjs");
    expect(hlsMode("", false)).toBe(null);
  });
});

describe("the busy answer", () => {
  test("a 503 busy names the holders; anything else is not busy", () => {
    expect(readBusy(503, { error: "busy", streams: [{ device: "Samsung", title: "Alash" }, { device: "100.64.0.2" }] })).toEqual([
      { device: "Samsung", title: "Alash" },
      { device: "100.64.0.2", title: "" },
    ]);
    expect(readBusy(503, { error: "busy" })).toEqual([]);
    expect(readBusy(503, { error: "copy unavailable" })).toBe(null);
    expect(readBusy(404, { error: "busy", streams: [] })).toBe(null);
    expect(readBusy(503, null)).toBe(null);
    expect(readBusy(503, { error: "busy", streams: [null, { title: "x" }] })).toEqual([]);
  });

  test("the message names the server", () => {
    expect(busyMessage([{ device: "Samsung", title: "Alash" }], "The Home Server")).toBe("The Home Server is busy streaming to Samsung (Alash)");
    expect(busyMessage([], "This Mac")).toBe("This Mac is busy streaming to other devices");
    expect(busyMessage(null)).toBe("The server is busy streaming to other devices");
  });
});
