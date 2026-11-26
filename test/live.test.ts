// Live stream pure parts (docs/home-server-spec.md 7, 10): playlist and segment arithmetic, what a segment request
// does, pausing and pruning, the plan and ffmpeg command, quality options, and slot arbitration.
import { describe, expect, test } from "bun:test";
import { ffmpegArgs, planLive, pruneBelow, segmentAction, segmentAt, segmentCount, segmentDuration, shouldPause, vodPlaylist, type LiveSource } from "../src/server/live/hls";
import { arbitrate } from "../src/server/live/slots";
import { liveSegmentStarts, parseLiveQuality, qualityOptions } from "../src/shared/liveQuality";
import { busyMessage, liveUrl } from "../src/tv/copies";
import type { TvDecision } from "../src/shared/playbackProfile";

describe("playlist and segment arithmetic", () => {
  test("ceil(duration/10) segments, the last one the remainder", () => {
    expect(segmentCount(30)).toBe(3);
    expect(segmentCount(30.04)).toBe(4);
    expect(segmentCount(0.5)).toBe(1);
    expect(segmentDuration(0, 35)).toBe(10);
    expect(segmentDuration(3, 35)).toBeCloseTo(5);
    expect(segmentDuration(2, 30)).toBe(10);
    expect(segmentAt(0, 35)).toBe(0);
    expect(segmentAt(19.99, 35)).toBe(1);
    expect(segmentAt(500, 35)).toBe(3);
    expect(liveSegmentStarts(35)).toEqual([0, 10, 20, 30]);
    expect(liveSegmentStarts(null)).toEqual([0]);
  });

  test("the whole VOD playlist up front, segment URLs carry the quality", () => {
    const p = vodPlaylist(35, "720");
    expect(p.startsWith("#EXTM3U\n")).toBe(true);
    expect(p).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(p).toContain("#EXT-X-TARGETDURATION:10");
    expect(p.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
    expect(p.match(/^seg\d+\.ts\?q=720$/gm)).toEqual(["seg0.ts?q=720", "seg1.ts?q=720", "seg2.ts?q=720", "seg3.ts?q=720"]);
    expect(p.match(/#EXTINF:([\d.]+),/g)).toEqual(["#EXTINF:10.000,", "#EXTINF:10.000,", "#EXTINF:10.000,", "#EXTINF:5.000,"]);
  });
});

describe("a segment request", () => {
  const r = (start: number, next: number, low = start, exited = false) => ({ start, next, low, exited });
  test("on disk is served; the one being made or the next waits; a jump outside restarts", () => {
    expect(segmentAction(r(0, 3), 1, true)).toBe("ready");
    expect(segmentAction(r(0, 3), 3, false)).toBe("wait"); // being encoded
    expect(segmentAction(r(0, 3), 4, false)).toBe("wait"); // just behind it
    expect(segmentAction(r(0, 3), 5, false)).toBe("restart"); // a jump ahead
    expect(segmentAction(r(10, 12), 4, false)).toBe("restart"); // before this run's start
    expect(segmentAction(r(0, 40, 9), 5, false)).toBe("restart"); // pruned
    expect(segmentAction(r(0, 3, 0, true), 3, false)).toBe("restart"); // ffmpeg gone
    expect(segmentAction(null, 0, false)).toBe("restart"); // nothing running yet
    expect(segmentAction(r(5, 5), 5, false)).toBe("wait"); // a fresh restart
  });

  test("pause 60 s ahead of the last request, prune 300 s behind", () => {
    expect(shouldPause(6, 0)).toBe(false);
    expect(shouldPause(7, 0)).toBe(true);
    expect(shouldPause(12, 6)).toBe(false);
    expect(pruneBelow(10)).toBe(0);
    expect(pruneBelow(45)).toBe(15);
  });
});

describe("the plan", () => {
  const ok: TvDecision = { video: "directplay", audio: "directplay", reason: null };
  const src = (o: Partial<LiveSource> = {}): LiveSource => ({ durationS: 100, width: 1920, height: 1080, videoCodec: "h264", audioCodec: "aac", sizeBytes: 100 * 1_000_000, decision: ok, ...o });

  test("only the container or audio wrong: copy mode, audio copied when a segment carries it", () => {
    expect(planLive(src({ decision: { video: "copy", audio: "copy", reason: "x" } }), "orig")).toMatchObject({ mode: "copy", audio: "copy" });
    expect(planLive(src({ audioCodec: "pcm_s16le", decision: { video: "directplay", audio: "transcode", reason: "x" } }), "orig")).toMatchObject({ mode: "copy", audio: "aac" });
    expect(planLive(src({ audioCodec: "opus" }), "orig").audio).toBe("aac"); // opus does not go into TS
    expect(planLive(src({ audioCodec: null }), "orig").audio).toBe("none");
  });

  test("a video transcode or a smaller pick: encode mode at the short edge, 8 / 4 / 1.5 Mbit/s capped at the source", () => {
    const tr: TvDecision = { video: "transcode", audio: "copy", reason: "x" };
    expect(planLive(src({ decision: tr }), "orig")).toMatchObject({ mode: "encode", shortEdge: 1080, videoKbps: 8000, audio: "aac" });
    expect(planLive(src(), "720")).toMatchObject({ mode: "encode", shortEdge: 720, videoKbps: 4000 });
    expect(planLive(src(), "480")).toMatchObject({ mode: "encode", shortEdge: 480, videoKbps: 1500 });
    expect(planLive(src({ sizeBytes: 25 * 1_000_000 }), "720").videoKbps).toBe(2000); // the source is 2 Mbit/s
    expect(planLive(src({ width: 3840, height: 2160, decision: tr }), "orig").shortEdge).toBe(1080); // the player's largest
    expect(planLive(src({ width: 3840, height: 2160 }), "orig")).toMatchObject({ mode: "encode", shortEdge: 1080 }); // Tizen's HLS cap
    expect(planLive(src({ width: 1080, height: 1920 }), "720")).toMatchObject({ shortEdge: 720, portrait: true });
    expect(planLive(src({ width: 1280, height: 720 }), "1080")).toMatchObject({ mode: "copy" }); // nothing is scaled up
    expect(planLive(src({ videoCodec: "vp9" }), "orig").mode).toBe("encode"); // vp9 does not go into TS
  });

  test("the ffmpeg command: -ss before -i, VideoToolbox, keyframes every 10 s, numbered from the start segment", () => {
    const enc = ffmpegArgs(planLive(src(), "720"), "/in.mkv", "/tmp/d", 3);
    const s = enc.join(" ");
    expect(enc.indexOf("-ss")).toBeLessThan(enc.indexOf("-i"));
    expect(s).toContain("-ss 30 -i /in.mkv");
    expect(s).toContain("-c:v h264_videotoolbox -b:v 4000k");
    expect(s).toContain("scale=-2:720");
    expect(s).toContain("-force_key_frames expr:gte(t,n_forced*10)");
    expect(s).toContain("-output_ts_offset 30");
    expect(s).toContain("-c:a aac -b:a 160k -ac 2");
    expect(s).toContain("-hls_time 10");
    expect(s).toContain("-start_number 3");
    expect(s).toContain("/tmp/d/seg%d.ts");
    expect(s).not.toContain("noaccurate_seek");
    const copy = ffmpegArgs(planLive(src({ decision: { video: "copy", audio: "copy", reason: "x" } }), "orig"), "/in.avi", "/tmp/d", 0).join(" ");
    expect(copy).toContain("-noaccurate_seek");
    expect(copy).toContain("-c:v copy -copyts");
    expect(copy).toContain("-c:a copy");
    expect(copy).not.toContain("-ss");
    expect(ffmpegArgs(planLive(src({ width: 1080, height: 1920 }), "480"), "/in", "/d", 0).join(" ")).toContain("scale=480:-2");
  });
});

describe("quality options", () => {
  test("Original, then each size below the Copy's own short edge", () => {
    expect(qualityOptions(1920, 1080)).toEqual(["orig", "720", "480"]);
    expect(qualityOptions(3840, 2160)).toEqual(["orig", "1080", "720", "480"]);
    expect(qualityOptions(1280, 720)).toEqual(["orig", "480"]);
    expect(qualityOptions(640, 360)).toEqual(["orig"]);
    expect(qualityOptions(1080, 1920)).toEqual(["orig", "720", "480"]); // portrait: the short edge
    expect(qualityOptions(null, null)).toEqual(["orig"]);
    expect(parseLiveQuality(null)).toBe("orig");
    expect(parseLiveQuality("720")).toBe("720");
    expect(parseLiveQuality("360")).toBeNull();
  });
});

describe("slot arbitration", () => {
  const a = { device: "tv1", key: "5:orig" };
  const b = { device: "tv2", key: "6:720" };
  test("two per server, one per device", () => {
    expect(arbitrate([], "tv1", "5:orig")).toEqual({ action: "start" });
    expect(arbitrate([a], "tv1", "5:orig")).toEqual({ action: "reuse" });
    expect(arbitrate([a], "tv1", "5:720")).toEqual({ action: "replace" }); // its own, replaced
    expect(arbitrate([a], "tv2", "6:720")).toEqual({ action: "start" });
    expect(arbitrate([a, b], "tv2", "7:orig")).toEqual({ action: "replace" });
    expect(arbitrate([a, b], "tv3", "5:orig")).toEqual({ action: "busy", holders: [a, b] }); // even for the same stream
  });

  test("the TV's busy line and Live URL", () => {
    expect(busyMessage([{ device: "Samsung", title: "Alash" }, { device: "100.64.0.2", title: "" }])).toBe("The server is busy streaming to Samsung (Alash) and 100.64.0.2");
    expect(busyMessage([])).toBe("The server is busy streaming to other devices");
    expect(liveUrl(7)).toBe("/live/7/index.m3u8?q=orig");
  });
});
