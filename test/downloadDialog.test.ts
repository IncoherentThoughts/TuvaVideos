// The download dialog's pure parts (downloader-spec §7, #203): words, the footer's disabled rules, the log's order,
// marks and pace colours, the held status, yt-dlp output colouring, the quit question; and the quality spelling (§6).
import { describe, expect, test } from "bun:test";
import { normQuality, storedQuality } from "../src/shared/downloadEstimate";
import {
  anyDownloadable, colorLine, confirmBlock, confirmLabel, displayLine, fmtBytes, fmtDur, fmtLen, headline, heldStatus, isErrorLine, isLive, paceOf,
  picked, quitQuestion, resumeLine, ROW_MARK, rowGroup, selectAllState, sortRows, tileLine,
} from "../src/web/downloader/model";
import type { ItemState } from "../src/server/downloads/queue";

describe("quality spelling (§6)", () => {
  test("720p / 1080p / best is canonical; 720 / 1080 (string or number, any case) still accepted", () => {
    expect(normQuality("720p")).toBe("720p");
    expect(normQuality("720")).toBe("720p");
    expect(normQuality(1080)).toBe("1080p");
    expect(normQuality("1080P")).toBe("1080p");
    expect(normQuality("Best")).toBe("best");
    for (const bad of ["4k", "", null, undefined, "bestp", "480p"]) expect(normQuality(bad)).toBeNull();
  });
  test("the stored spelling drops the p (migration 0024)", () => {
    expect(storedQuality("720p")).toBe("720");
    expect(storedQuality("1080p")).toBe("1080");
    expect(storedQuality("best")).toBe("best");
  });
});

describe("words", () => {
  test("bytes, durations, lengths", () => {
    expect(fmtBytes(0)).toBe("0 MB");
    expect(fmtBytes(820e6)).toBe("820 MB");
    expect(fmtBytes(4.24e9)).toBe("4.2 GB");
    expect(fmtBytes(41.4e9)).toBe("41 GB");
    expect(fmtDur(40)).toBe("40 s");
    expect(fmtDur(12 * 60)).toBe("12 min");
    expect(fmtDur(80 * 60)).toBe("1 h 20 min");
    expect(fmtDur(5 * 3600)).toBe("5 h");
    expect(fmtDur(51 * 3600)).toBe("2 d 3 h");
    expect(fmtLen(187)).toBe("3:07");
    expect(fmtLen(3725)).toBe("1:02:05");
    expect(fmtLen(null)).toBe("–");
  });
  test("a tile shows size then time; the button counts, sizes and times", () => {
    expect(tileLine({ count: 3, estBytes: 41e9, estSeconds: 5 * 3600 })).toEqual({ size: "≈ 41 GB", time: "~5 h" });
    expect(tileLine({ count: 0, estBytes: 0, estSeconds: 0 }).size).toBe("nothing");
    expect(confirmLabel({ count: 12, estBytes: 4.2e9, estSeconds: 35 * 60 })).toBe("Download 12 Videos (≈ 4.2 GB) ~35 min");
    expect(confirmLabel({ count: 1, estBytes: 0, estSeconds: 0 })).toBe("Download 1 Video");
  });
});

describe("choosing (§7.2)", () => {
  const list = [{ id: "a", estBytes: 1e9 }, { id: "b", estBytes: null }, { id: "c", estBytes: 2e9 }];
  test("picked: the unchecked ones are left out of the list and the totals", () => {
    const p = picked(list, new Set(["c"]), 2e6);
    expect(p.videos.map((v) => v.id)).toEqual(["a", "b"]);
    expect(p.totals).toEqual({ count: 2, estBytes: 1e9, withoutEstimate: 1, estSeconds: 500 });
  });
  test("Select all is all / some / none", () => {
    expect(selectAllState(3, 0)).toBe("all");
    expect(selectAllState(3, 1)).toBe("some");
    expect(selectAllState(3, 3)).toBe("none");
    expect(selectAllState(0, 0)).toBe("none");
  });
  test("the footer button is disabled when nothing is picked, the disk is too small, no destination, or no yt-dlp", () => {
    const ok = { count: 2, estBytes: 1e9, freeBytes: 2e9, destDir: "/r", toolsMissing: false, busy: false };
    expect(confirmBlock(ok)).toBeNull();
    expect(confirmBlock({ ...ok, count: 0 })).toBe("nothing picked");
    expect(confirmBlock({ ...ok, freeBytes: 1.05e9 })).toBe("not enough free space"); // the 10 % margin (§3.4)
    expect(confirmBlock({ ...ok, freeBytes: 1.1e9 })).toBeNull();
    expect(confirmBlock({ ...ok, freeBytes: null, estBytes: 1e15 })).toBeNull(); // unreadable volume: never blocks
    expect(confirmBlock({ ...ok, destDir: null })).toContain("no Root");
    expect(confirmBlock({ ...ok, toolsMissing: true })).toContain("yt-dlp");
    expect(confirmBlock({ ...ok, busy: true })).not.toBeNull();
  });
  test("Download videos… only while a Video with a source id is Not on this machine", () => {
    const v = (o: object) => ({ youtubeId: "y", instagramId: null, rutubeId: null, available: false, copies: [] as { missing: boolean }[], ...o });
    expect(anyDownloadable([v({})])).toBe(true);
    expect(anyDownloadable([v({ available: true })])).toBe(false);
    expect(anyDownloadable([v({ copies: [{ missing: false }] })])).toBe(false); // unmounted, not Not here
    expect(anyDownloadable([v({ copies: [{ missing: true }] })])).toBe(true);
    expect(anyDownloadable([v({ youtubeId: null })])).toBe(false); // hash-only
    expect(anyDownloadable(null)).toBe(false);
  });
});

describe("the log (§7.3)", () => {
  test("rows sort running → failed → queued → done, then in queue order", () => {
    const states: ItemState[] = ["done", "queued", "failed", "downloading", "waiting", "sizing", "cancelled", "skipped", "done_outside", "merging"];
    const items = states.map((state, i) => ({ id: i + 1, queuePos: 100 - i, state }));
    expect(sortRows(items).map((i) => i.state)).toEqual(["merging", "sizing", "downloading", "failed", "waiting", "queued", "done_outside", "skipped", "done", "cancelled"]);
    expect(items[0]!.state).toBe("done"); // the input is untouched
  });
  test("marks ↓ / ! / ✓, none for queued; × only while live", () => {
    expect(ROW_MARK[rowGroup("downloading")]).toBe("↓");
    expect(ROW_MARK[rowGroup("failed")]).toBe("!");
    expect(ROW_MARK[rowGroup("done")]).toBe("✓");
    expect(ROW_MARK[rowGroup("queued")]).toBe("");
    expect(isLive("waiting")).toBe(true);
    expect(isLive("scanning")).toBe(true);
    expect(isLive("failed")).toBe(false);
    expect(isLive("done")).toBe(false);
  });
  test("pace: red under 1.5 MB/s, yellow under 4, green from 4", () => {
    expect(paceOf(1.49e6)).toBe("slow");
    expect(paceOf(1.5e6)).toBe("mid");
    expect(paceOf(3.99e6)).toBe("mid");
    expect(paceOf(4e6)).toBe("fast");
  });
  test("what replaces the speed", () => {
    const now = Date.parse("2026-11-08T12:00:00Z");
    const base = { paused: false, offline: null, diskFull: null, sitePauses: [] };
    expect(heldStatus(base, now)).toBeNull();
    expect(heldStatus({ ...base, paused: true }, now)).toBe("Paused");
    expect(heldStatus({ ...base, offline: { since: "x", nextProbeAt: "y" } }, now)).toBe("Waiting for connection…");
    expect(heldStatus({ ...base, sitePauses: [{ site: "youtube", until: "2026-11-08T12:04:10Z" }] }, now)).toBe("YouTube paused for 5 min (rate limit)");
    expect(heldStatus({ ...base, sitePauses: [{ site: "youtube", until: "2026-11-08T11:00:00Z" }] }, now)).toBeNull();
    expect(heldStatus({ ...base, paused: true, diskFull: { dir: "/Volumes/X" } }, now)).toContain("Disk full: free space on /Volumes/X");
  });
  test("the headline counts skipped as downloaded and leaves cancelled out", () => {
    const c = { total: 10, done: 5, failed: 2, cancelled: 2, skipped: 1 };
    expect(headline(c, 0, 0)).toEqual({ pct: 75, done: 6, of: 8, failed: 2 });
    expect(headline(c, 250, 1000).pct).toBe(25);
    expect(headline({ total: 2, done: 2, failed: 0, cancelled: 0, skipped: 0 }, 900, 1000).pct).toBe(100);
  });
});

describe("yt-dlp output (§7.3)", () => {
  test("our progress lines read like yt-dlp's own", () => {
    expect(displayLine("TUVA downloading 52428800 104857600 NA 2097152 25")).toBe("[download]  50.0% of 100.00MiB at 2.00MiB/s ETA 00:25");
    expect(displayLine("TUVA downloading 10 NA 100 NA NA")).toBe("[download]  10.0% of ~0.00MiB at Unknown B/s ETA Unknown");
    expect(displayLine("TUVAPP started")).toBe("[postprocess] started");
    expect(displayLine("TUVAFILE /r/a.mp4")).toBe("[file] /r/a.mp4");
    expect(displayLine("[err] ERROR: [youtube] x: Video unavailable")).toBe("ERROR: [youtube] x: Video unavailable");
    expect(isErrorLine("[err] ERROR: boom")).toBe(true);
    expect(isErrorLine("WARNING: hm")).toBe(false);
  });
  test("tones: ERROR red, WARNING yellow, percent blue, speed green, ETA yellow, [tags] cyan; texts join back", () => {
    const tones = (l: string) => colorLine(l).filter((s) => s.tone).map((s) => `${s.tone}:${s.text.trim()}`);
    const line = "[download]  50.0% of 100.00MiB at 2.00MiB/s ETA 00:25";
    expect(tones(line)).toEqual(["tag:[download]", "pct:50.0%", "size:100.00MiB", "speed:2.00MiB/s", "eta:00:25"]);
    expect(colorLine(line).map((s) => s.text).join("")).toBe(line);
    expect(tones("ERROR: [youtube] x: Private video")).toEqual(["err:ERROR: [youtube] x: Private video"]);
    expect(tones("WARNING: falling back")).toEqual(["warn:WARNING:"]);
    expect(tones("[youtube] x: Downloading webpage")).toEqual(["tag:[youtube]"]);
    expect(tones("plain")).toEqual([]);
  });
});

test("the quit question and the resume bar (§4.7)", () => {
  expect(quitQuestion(2)).toBe("2 downloads are running. Quit anyway? They will resume next time.");
  expect(quitQuestion(1)).toBe("1 download is running. Quit anyway? They will resume next time.");
  expect(resumeLine({ left: 4, estBytes: 3.1e9, waitingForRoot: null })).toBe("Download job: 4 Videos left (≈ 3.1 GB)");
  expect(resumeLine({ left: 1, estBytes: 0, waitingForRoot: "/Volumes/Server" })).toBe("Download job: 1 Video left — waiting for /Volumes/Server");
});
