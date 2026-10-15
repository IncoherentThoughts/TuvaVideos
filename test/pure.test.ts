import { describe, expect, test } from "bun:test";
import { parseFilename, contentTypeFor } from "../src/server/filename";
import { decidePlayback, frameRateValue, parseProbe } from "../src/server/playback";
import { rankCopies, type Rankable } from "../src/server/ranking";
import { stripGeometry, tileForTime, sliceCentre } from "../src/server/stripGeometry";
import { parseRange } from "../src/server/range";
import { pickRandomVideo } from "../src/shared/random";

describe("filename identity and skip rules", () => {
  test("youtube id and title", () => {
    const p = parseFilename("Alash Ensemble - Ay Daglar [dQw4w9WgXcQ].webm");
    expect(p.skip).toBeNull();
    expect(p.youtubeId).toBe("dQw4w9WgXcQ");
    expect(p.title).toBe("Alash Ensemble - Ay Daglar");
    expect(p.ext).toBe("webm");
  });
  test("ids may contain - and _", () => {
    expect(parseFilename("x [a-b_c-d_e-f].mkv").youtubeId).toBe("a-b_c-d_e-f");
  });
  test("instagram: the [instagram-…] tag (and an `Instagram video #…` shortcode) is left out of the title", () => {
    const p = parseFilename("Video by tuva.accord [instagram-CrcH6MHo6Jm].mkv");
    expect(p.youtubeId).toBeNull();
    expect(p.instagramId).toBe("CrcH6MHo6Jm");
    expect(p.title).toBe("Video by tuva.accord");
    expect(parseFilename("Огбе Тывам [instagram-CZ6ySoaIWro].mp4").title).toBe("Огбе Тывам");
    expect(parseFilename("Instagram video #CdtUBecoRUu [instagram-CdtUBecoRUu].mkv").title).toBe("Instagram video");
    expect(parseFilename("Video by _dalai_damdyn [instagram-ButuhuUAss-].mkv").title).toBe("Video by _dalai_damdyn");
    expect(parseFilename("Video by _dalai_damdyn [instagram-ButuhuUAss-].mkv").instagramId).toBe("ButuhuUAss-");
    expect(parseFilename("Alash Ensemble - Ay Daglar [dQw4w9WgXcQ].webm").instagramId).toBeNull();
  });
  test("no id: hash identity, title is the stem", () => {
    const p = parseFilename("Alash w: Radik 2.MP4");
    expect(p.skip).toBeNull();
    expect(p.youtubeId).toBeNull();
    expect(p.title).toBe("Alash w: Radik 2");
    expect(p.ext).toBe("mp4");
  });
  test("a bracket that is not an 11-char id is part of the title", () => {
    const p = parseFilename("Concert [live].mp4");
    expect(p.youtubeId).toBeNull();
    expect(p.title).toBe("Concert [live]");
  });
  test("skips partials, AppleDouble, non-video", () => {
    expect(parseFilename("a [dQw4w9WgXcQ].f303.webm").skip).toBe("partial");
    expect(parseFilename("a [dQw4w9WgXcQ].f251.webm").skip).toBe("partial");
    expect(parseFilename("a [dQw4w9WgXcQ].mp4.part").skip).toBe("partial");
    expect(parseFilename("a [dQw4w9WgXcQ].temp.mp4").skip).toBe("partial");
    expect(parseFilename("._a [dQw4w9WgXcQ].mp4").skip).toBe("apple-double");
    expect(parseFilename(".DS_Store").skip).toBe("ds-store");
    expect(parseFilename("song.mp3").skip).toBe("not-video");
    expect(parseFilename("cover.jpg").skip).toBe("not-video");
  });
  test("content types", () => {
    expect(contentTypeFor("webm")).toBe("video/webm");
    expect(contentTypeFor("mp4")).toBe("video/mp4");
    expect(contentTypeFor("mkv")).toBe("video/x-matroska");
  });
});

describe("playback decision from ffprobe output", () => {
  const probe = (audio: string | null, duration: string | undefined) =>
    parseProbe({
      streams: [
        { codec_type: "video", codec_name: "vp9", width: 1920, height: 1080, r_frame_rate: "30000/1001" },
        ...(audio ? [{ codec_type: "audio", codec_name: audio }] : []),
      ],
      format: duration ? { duration } : {},
    });
  test("native", () => {
    for (const a of ["aac", "opus", "vorbis", "mp3", "flac", null]) expect(decidePlayback(probe(a, "12.5"))).toBe("native");
  });
  test("audio codec outside the set transcodes", () => {
    expect(decidePlayback(probe("eac3", "12.5"))).toBe("transcode");
    expect(decidePlayback(probe("ac3", "12.5"))).toBe("transcode");
  });
  test("missing duration remuxes; transcode wins over remux", () => {
    expect(decidePlayback(probe("opus", undefined))).toBe("remux");
    expect(decidePlayback(probe("opus", "N/A"))).toBe("remux");
    expect(decidePlayback(probe("eac3", undefined))).toBe("transcode");
  });
  test("facts", () => {
    const f = probe("opus", "93.1");
    expect(f).toMatchObject({ hasVideo: true, duration: 93.1, videoCodec: "vp9", audioCodec: "opus", width: 1920, height: 1080, rFrameRate: "30000/1001" });
    expect(frameRateValue(f.rFrameRate)).toBeCloseTo(29.97, 2);
    expect(frameRateValue("0/0")).toBeNull();
  });
  test("audio-only and cover art are not video", () => {
    expect(parseProbe({ streams: [{ codec_type: "audio", codec_name: "mp3" }], format: { duration: "5" } }).hasVideo).toBe(false);
    expect(parseProbe({ streams: [{ codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } }] }).hasVideo).toBe(false);
  });
  test("duration falls back to the video stream", () => {
    expect(parseProbe({ streams: [{ codec_type: "video", codec_name: "h264", duration: "7.5" }], format: {} }).duration).toBe(7.5);
  });
});

describe("Copy ranking", () => {
  const c = (name: string, o: Partial<Rankable> = {}): Rankable & { name: string } => ({
    name, rootKind: "external", playback: "native", width: 1280, height: 720, size: 100, ...o,
  });
  const order = (xs: (Rankable & { name: string })[]) => rankCopies(xs).map((x) => x.name);
  test("local beats everything", () => {
    expect(order([c("ext-hd", { width: 3840, height: 2160 }), c("loc-lo", { rootKind: "local", width: 320, height: 240, playback: "transcode" })])).toEqual(["loc-lo", "ext-hd"]);
  });
  test("then native over fallback", () => {
    expect(order([c("remux", { playback: "remux", width: 3840, height: 2160 }), c("native")])).toEqual(["native", "remux"]);
  });
  test("then larger resolution, then smaller size", () => {
    expect(order([c("small", { width: 640, height: 360 }), c("big")])).toEqual(["big", "small"]);
    expect(order([c("heavy", { size: 900 }), c("light", { size: 100 })])).toEqual(["light", "heavy"]);
  });
  test("stable on full ties; null dimensions count as zero", () => {
    expect(order([c("a", {}), c("b", {})])).toEqual(["a", "b"]);
    expect(order([c("none", { width: null, height: null }), c("some")])).toEqual(["some", "none"]);
  });
});

describe("strip geometry", () => {
  test("N = min(100, floor(duration)), 10 columns", () => {
    expect(stripGeometry(212.7)).toEqual({ frames: 100, columns: 10, rows: 10 });
    expect(stripGeometry(100)).toEqual({ frames: 100, columns: 10, rows: 10 });
    expect(stripGeometry(37.9)).toEqual({ frames: 37, columns: 10, rows: 4 });
    expect(stripGeometry(7)).toEqual({ frames: 7, columns: 7, rows: 1 });
    expect(stripGeometry(2.5)).toEqual({ frames: 2, columns: 2, rows: 1 });
  });
  test("no strip under 2 frames or without a duration", () => {
    expect(stripGeometry(1.9)).toBeNull();
    expect(stripGeometry(null)).toBeNull();
    expect(stripGeometry(NaN)).toBeNull();
  });
  test("time -> tile", () => {
    const g = stripGeometry(200)!;
    expect(tileForTime(0, 200, g)).toEqual({ index: 0, column: 0, row: 0 });
    expect(tileForTime(1.99, 200, g)).toEqual({ index: 0, column: 0, row: 0 });
    expect(tileForTime(2, 200, g)).toEqual({ index: 1, column: 1, row: 0 });
    expect(tileForTime(25, 200, g)).toEqual({ index: 12, column: 2, row: 1 });
    expect(tileForTime(200, 200, g)).toEqual({ index: 99, column: 9, row: 9 });
    expect(tileForTime(-5, 200, g).index).toBe(0);
  });
  test("slice centres", () => {
    expect(sliceCentre(100, 100, 0)).toBeCloseTo(0.5);
    expect(sliceCentre(100, 4, 3)).toBeCloseTo(87.5);
  });
});

describe("Range header parsing", () => {
  test("absent or garbage means whole file", () => {
    expect(parseRange(null, 1000)).toEqual({ kind: "none" });
    expect(parseRange("items=0-1", 1000)).toEqual({ kind: "none" });
    expect(parseRange("bytes=", 1000)).toEqual({ kind: "none" });
    expect(parseRange("bytes=0-1,5-6", 1000)).toEqual({ kind: "none" });
    expect(parseRange("bytes=9-3", 1000)).toEqual({ kind: "none" });
  });
  test("closed, open-ended, suffix", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ kind: "range", start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ kind: "range", start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ kind: "range", start: 900, end: 999 });
    expect(parseRange("bytes=-5000", 1000)).toEqual({ kind: "range", start: 0, end: 999 });
  });
  test("end clamps to the file; start past the end is unsatisfiable", () => {
    expect(parseRange("bytes=990-5000", 1000)).toEqual({ kind: "range", start: 990, end: 999 });
    expect(parseRange("bytes=1000-", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("random Video", () => {
  const vids = [
    { id: 1, available: true },
    { id: 2, available: false },
    { id: 3, available: true },
  ];
  test("only Available Videos, never the current one", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) seen.add(pickRandomVideo(vids, 3)!);
    expect([...seen]).toEqual([1]);
  });
  test("uniform over the pool", () => {
    expect(pickRandomVideo(vids, null, () => 0)).toBe(1);
    expect(pickRandomVideo(vids, null, () => 0.99)).toBe(3);
    expect(pickRandomVideo(vids, null, () => 1)).toBe(3); // a rand() of exactly 1 stays in range
  });
  test("null when nothing qualifies", () => {
    expect(pickRandomVideo([], null)).toBeNull();
    expect(pickRandomVideo([{ id: 1, available: true }], 1)).toBeNull();
    expect(pickRandomVideo([{ id: 2, available: false }], null)).toBeNull();
  });
});
