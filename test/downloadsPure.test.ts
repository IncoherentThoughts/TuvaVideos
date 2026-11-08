import { describe, expect, test } from "bun:test";
import { buildDownloadArgs, buildSizingArgs, mergeFormatFor, OUTPUT_TEMPLATES, SELECTORS, sourceOf, type Source } from "../src/server/downloads/args";
import { classify, lastErrorLine, type FailureReason } from "../src/server/downloads/classify";
import { ByteCounter, parseLine } from "../src/server/downloads/progress";
import { parseSizing } from "../src/server/downloads/sizing";
import { parseFilename } from "../src/server/filename";

const base = { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", source: "youtube" as const, quality: "1080p" as const, ffmpegLocation: "/opt/ff" };

describe("argument builder", () => {
  test("the spec's flags, selector, merge format, template and progress templates", () => {
    const a = buildDownloadArgs({ ...base, jsRuntime: "/opt/deno", mergeFormat: "mkv" });
    const pair = (flag: string) => a[a.indexOf(flag) + 1];
    expect(a).toContain("--newline");
    expect(a).toContain("--no-playlist");
    expect(a).toContain("--no-overwrites");
    expect(a).not.toContain("--restrict-filenames");
    expect(pair("--retries")).toBe("10");
    expect(pair("--retry-sleep")).toBe("exp=1:30");
    expect(pair("--ffmpeg-location")).toBe("/opt/ff");
    expect(pair("--js-runtimes")).toBe("deno:/opt/deno");
    expect(pair("-f")).toBe(SELECTORS["1080p"]);
    expect(pair("--merge-output-format")).toBe("mkv");
    expect(pair("-o")).toBe(OUTPUT_TEMPLATES.youtube);
    expect(pair("--print")).toBe("after_move:TUVAFILE %(filepath)s");
    // --print implies --quiet, which hides progress unless --progress is given
    expect(a).toContain("--progress");
    expect(a).toContain("--no-simulate");
    expect(a.filter((x) => x === "--progress-template")).toHaveLength(2);
    expect(a.at(-1)).toBe(base.url);
  });

  test("optional parts are left out", () => {
    const a = buildDownloadArgs(base);
    for (const f of ["--js-runtimes", "--merge-output-format", "--cookies", "--cookies-from-browser", "--windows-filenames"]) expect(a).not.toContain(f);
  });

  test("cookies flags and Windows filenames", () => {
    expect(buildDownloadArgs({ ...base, cookies: { file: "/c.txt" } })).toEqual(expect.arrayContaining(["--cookies", "/c.txt"]));
    expect(buildDownloadArgs({ ...base, cookies: { browser: "firefox" } })).toEqual(expect.arrayContaining(["--cookies-from-browser", "firefox"]));
    expect(buildDownloadArgs({ ...base, windows: true })).toContain("--windows-filenames");
  });

  test("selectors per quality", () => {
    expect(SELECTORS["720p"]).toContain("height<=720");
    expect(SELECTORS["1080p"]).toContain("height<=1080");
    expect(SELECTORS.best).toBe("bv*+ba/b");
    expect(buildDownloadArgs({ ...base, quality: "best" })).toContain("bv*+ba/b");
  });

  test("the sizing pass is extraction only", () => {
    const a = buildSizingArgs(base);
    expect(a).toEqual(expect.arrayContaining(["--simulate", "-J", "-f", SELECTORS["1080p"]]));
    expect(a).not.toContain("--print");
  });

  test("merge format follows the chosen video codec", () => {
    expect(mergeFormatFor("avc1")).toBe("mp4");
    expect(mergeFormatFor("vp9")).toBe("mkv");
    expect(mergeFormatFor("av01")).toBe("mkv");
    expect(mergeFormatFor(null)).toBe("mkv");
  });

  test("source from URL", () => {
    expect(sourceOf("https://youtu.be/jNQXAC9IVRw")).toBe("youtube");
    expect(sourceOf("https://www.instagram.com/reel/C1abc/")).toBe("instagram");
    expect(sourceOf("https://rutube.ru/video/0123456789abcdef0123456789abcdef/")).toBe("rutube");
    expect(sourceOf("https://example.com/x")).toBeNull();
    expect(sourceOf("not a url")).toBeNull();
  });
});

/** What yt-dlp makes of each template, for a Tuvan Cyrillic title, an untitled post and a plain one. */
function expand(template: string, title: string, id: string, ext: string) {
  return template.replace("%(title).150B", title).replace("%(id)s", id).replace("%(ext)s", ext);
}

describe("output templates round-trip through parseFilename", () => {
  const ids: Record<Source, string> = { youtube: "jNQXAC9IVRw", instagram: "C1abcDEF-_x", rutube: "0123456789abcdef0123456789abcdef" };
  for (const source of ["youtube", "instagram", "rutube"] as const) {
    for (const title of ["Me at the zoo", "Хөөмей Аяңчыл — Тыва", "Song #1 (live) [2019]"]) {
      test(`${source}: ${title}`, () => {
        const parsed = parseFilename(expand(OUTPUT_TEMPLATES[source], title, ids[source], "mkv"));
        expect(parsed.skip).toBeNull();
        expect(parsed.title).toBe(title);
        const got = { youtube: parsed.youtubeId, instagram: parsed.instagramId, rutube: parsed.rutubeId }[source];
        expect(got).toBe(ids[source]);
      });
    }
  }
  test("the untitled Instagram name keeps its shortcode", () => {
    const p = parseFilename(expand(OUTPUT_TEMPLATES.instagram, "Instagram video #C1abcDEF-_x", "C1abcDEF-_x", "mp4"));
    expect(p.instagramId).toBe("C1abcDEF-_x");
  });
});

describe("sizing pass", () => {
  // Shapes recorded from `yt-dlp --simulate -J` on jNQXAC9IVRw (docs/research/yt-dlp-progress-errors.md §4).
  test("sums the streams' exact filesize and reads the codec (vp9 + opus -> mkv)", () => {
    const s = parseSizing({
      duration: 19,
      requested_formats: [
        { filesize: 293080, filesize_approx: 293079, vcodec: "vp09.00.20.08" },
        { filesize: 252182, filesize_approx: 252180, vcodec: "none" },
      ],
    });
    expect(s).toEqual({ exactBytes: 545262, videoCodec: "vp09", mergeFormat: "mkv", durationS: 19 });
  });

  test("avc1 + aac merges to mp4; falls back to filesize_approx per stream", () => {
    const s = parseSizing(
      JSON.stringify({
        requested_formats: [
          { filesize: null, filesize_approx: 1000, vcodec: "avc1.64001F" },
          { filesize: 500, vcodec: "none" },
        ],
      }),
    );
    expect(s).toMatchObject({ exactBytes: 1500, videoCodec: "avc1", mergeFormat: "mp4" });
  });

  test("an HLS stream without a size is null, not a guess", () => {
    const s = parseSizing({ requested_formats: [{ vcodec: "avc1.4d401f" }, { filesize: 10 }] });
    expect(s.exactBytes).toBeNull();
    expect(s.videoCodec).toBe("avc1");
  });

  test("a single-file format has nothing to merge", () => {
    expect(parseSizing({ filesize: 9000, vcodec: "h264" })).toMatchObject({ exactBytes: 9000, mergeFormat: null });
    expect(parseSizing({})).toMatchObject({ exactBytes: null, videoCodec: null, mergeFormat: null });
  });
});

describe("progress lines", () => {
  // Recorded from a real run (yt-dlp 2026.10.21, jNQXAC9IVRw, `bv*+ba`): the audio stream followed the video stream.
  const recorded = [
    "TUVA downloading 1024 293080 NA 29054.404167089462 10",
    "TUVA downloading 293080 293080 NA 4314578.696149661 0",
    "TUVA finished 293080 293080 NA 1373660.2915238177 NA",
    "TUVA downloading 1024 252182 NA 480313.94497875194 0",
    "TUVA finished 252182 252182 NA 2345513.265820764 NA",
    "TUVAPP started",
    "TUVAPP finished",
    "TUVAFILE /tmp/x/Me at the zoo [jNQXAC9IVRw].mkv",
  ];

  test("fields, with NA as null", () => {
    expect(parseLine(recorded[0]!)).toEqual({ kind: "download", status: "downloading", downloaded: 1024, total: 293080, totalEstimate: null, speed: 29054.404167089462, eta: 10 });
    expect(parseLine(recorded[2]!)).toMatchObject({ status: "finished", eta: null });
    expect(parseLine("TUVA downloading 5 NA 9000 NA NA")).toMatchObject({ total: null, totalEstimate: 9000, speed: null, eta: null });
    expect(parseLine(recorded[5]!)).toEqual({ kind: "postprocess", status: "started" });
    expect(parseLine(recorded[7]!)).toEqual({ kind: "file", path: "/tmp/x/Me at the zoo [jNQXAC9IVRw].mkv" });
  });

  test("other lines are ignored", () => {
    for (const l of ["[download] Destination: x", "[youtube] jNQXAC9IVRw: Downloading webpage", "TUVA downloading 1", "TUVAFILE ", ""]) expect(parseLine(l)).toBeNull();
  });

  test("two-stream accounting against the exact size", () => {
    const c = new ByteCounter(545262);
    const done = recorded.slice(0, 5).map((l) => c.feed(parseLine(l) as any).doneBytes);
    expect(done).toEqual([1024, 293080, 293080, 293080 + 1024, 545262]);
    expect(c.snapshot().totalBytes).toBe(545262);
  });

  test("without an exact size the total is finished streams plus the current total", () => {
    const c = new ByteCounter(null);
    expect(c.feed(parseLine("TUVA downloading 10 NA 100 NA NA") as any)).toEqual({ doneBytes: 10, totalBytes: 100 });
    c.feed(parseLine("TUVA finished 100 100 NA NA NA") as any);
    expect(c.feed(parseLine("TUVA downloading 5 50 NA NA NA") as any)).toEqual({ doneBytes: 105, totalBytes: 150 });
  });

  test("a resumed stream's downloaded_bytes already includes what was on disk", () => {
    const c = new ByteCounter(1000);
    expect(c.feed(parseLine("TUVA downloading 400 600 NA NA NA") as any).doneBytes).toBe(400);
  });

  test("the total never falls below the done bytes", () => {
    const c = new ByteCounter(null);
    expect(c.feed(parseLine("TUVA downloading 120 NA 100 NA NA") as any)).toEqual({ doneBytes: 120, totalBytes: 120 });
  });
});

describe("failure classifier, on real messages", () => {
  const E = (m: string) => [`ERROR: ${m}`];
  const cases: Array<[FailureReason, string]> = [
    // docs/research/failed-youtube-downloads.md and yt-dlp-progress-errors.md
    ["unavailable", "[youtube] Sf9lj8T6TGQ: Video unavailable. This video is not available"],
    ["unavailable", "[youtube] aYvZ6P29Oao: This video is unavailable"],
    ["unavailable", "[youtube] abc: This video has been removed by the uploader"],
    ["private", "[youtube] i_66Y-6DZ9k: Private video. Sign in if you've been granted access to this video"],
    ["geo", "[youtube] abc: The uploader has not made this video available in your country"],
    ["geo", "[youtube] abc: This video is not available from your location due to geo restriction"],
    ["youtube_signin", "[youtube] UrCE3tq_prs: Please sign in. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies."],
    ["youtube_signin", "[youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication."],
    // docs/research/instagram-auth.md
    ["login_wall", "[Instagram] C1abc: The webpage request was redirected to the login page. You have exceeded the rate-limit for accessing posts anonymously. Use --cookies-from-browser or --cookies for the authentication."],
    ["login_wall", "[Instagram] C1abc: Restricted Video: This content may be inappropriate. Use --cookies-from-browser or --cookies for the authentication."],
    ["login_wall", "[Instagram] C1abc: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in. If it is, then use --cookies-from-browser or --cookies for the authentication."],
    ["private_follow", "[Instagram] C1abc: This content is only available for registered users who follow this account"],
    ["unavailable", "[Instagram] C1abc: There is no video in this post"],
    // §4.5 / source-derived wordings
    ["rate_limited", "unable to download video data: HTTP Error 429: Too Many Requests"],
    ["rate_limited", "[youtube] abc: Your account/IP has been rate-limited by YouTube for up to an hour"],
    ["disk_full", "unable to write data: [Errno 28] No space left on device"],
    ["network", "[youtube] abc: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known>"],
    ["network", "unable to download video data: HTTP Error 503: Service Unavailable"],
    ["network", "[download] Got error: The read operation timed out. Giving up after 10 retries"],
    ["network", "<urlopen error [Errno 60] Operation timed out>"],
    ["network", "Connection reset by peer"],
    ["no_js_runtime", "[youtube] abc: Signature extraction failed: Some formats may be missing"],
    ["no_js_runtime", "[youtube] abc: n challenge solving failed: Some formats may be missing. Install a JavaScript runtime"],
    ["no_js_runtime", "[youtube] abc: No supported JavaScript runtime could be found"],
    ["unknown", "ffmpeg exited with code 1"],
    ["unknown", "Interrupted by user"],
  ];
  for (const [reason, msg] of cases) test(`${reason}: ${msg.slice(0, 60)}`, () => expect(classify(E(msg)).reason).toBe(reason));

  test("the warning that cookies are no longer valid wins on any line, even before an unrelated error", () => {
    const lines = ["WARNING: [Instagram] The provided Instagram account cookies are no longer valid", ...E("[Instagram] C1abc: Instagram sent an empty media response.")];
    expect(classify(lines).reason).toBe("cookies_expired");
  });

  test("the last ERROR line decides and is kept verbatim", () => {
    const lines = ["ERROR: [youtube] abc: Video unavailable", "WARNING: x", "ERROR: unable to write data: [Errno 28] No space left on device", "[download] done"];
    expect(lastErrorLine(lines)).toBe("unable to write data: [Errno 28] No space left on device");
    expect(classify(lines)).toEqual({ reason: "disk_full", errorLine: "unable to write data: [Errno 28] No space left on device" });
  });

  test("no ERROR line is unknown with a null error line", () => {
    expect(classify(["[download] 100%"])).toEqual({ reason: "unknown", errorLine: null });
  });
});
