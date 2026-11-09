// The card's download states (downloader-spec §8): queue items → pills, the polling rule, the log tail at the error,
// and the hover estimate's endpoint helper.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FAST_POLL_MS, SLOW_POLL_MS, cardState, formatEstimate, formatEta, hasSourceId, newlyDone, pollInterval, progressFraction, tailAtError, type CardItem,
} from "../src/web/cardDownloadState";
import { cardEstimate, estimateQuality } from "../src/server/downloads/cardEstimate";
import { openDb } from "../src/server/db";
import { insertVideo } from "./helpers/seed";

const it = (o: Partial<CardItem>): CardItem => ({ id: 7, videoId: "v", state: "queued", ...o });

describe("cardState", () => {
  test("absent is idle; cancelled and skipped show nothing", () => {
    expect(cardState(undefined).kind).toBe("idle");
    expect(cardState(it({ state: "cancelled" })).kind).toBe("idle");
    expect(cardState(it({ state: "skipped" })).kind).toBe("idle");
  });
  test("Queued #n, and Queued · next at the front", () => {
    expect(cardState(it({ rank: 3 }))).toEqual({ kind: "queued", itemId: 7, rank: 3, label: "Queued #3" });
    expect(cardState(it({ rank: 1 })).label).toBe("Queued · next");
    expect(cardState(it({ rank: null })).label).toBe("Queued");
    expect(cardState(it({ state: "waiting" })).label).toBe("Waiting");
  });
  test("running: percent and eta against the exact size, else the estimate", () => {
    const s = cardState(it({ state: "downloading", doneBytes: 42, exactBytes: 100, estBytes: 500, etaS: 31 }));
    expect(s).toEqual({ kind: "running", itemId: 7, fraction: 0.42, label: "42% · 31 s" });
    expect(cardState(it({ state: "downloading", doneBytes: 50, exactBytes: null, estBytes: 200 })).label).toBe("25%");
    expect(cardState(it({ state: "downloading" })).label).toBe("Downloading…");
    expect(cardState(it({ state: "sizing" }))).toMatchObject({ kind: "running", fraction: 0, label: "Starting…" });
  });
  test("Merging… and Adding…", () => {
    expect(cardState(it({ state: "merging" }))).toMatchObject({ kind: "merging", label: "Merging…" });
    expect(cardState(it({ state: "scanning" }))).toMatchObject({ kind: "adding", label: "Adding…" });
  });
  test("Failed ▾ with the reason's words", () => {
    expect(cardState(it({ state: "failed", reason: "private" }))).toEqual({ kind: "failed", itemId: 7, reason: "private", label: "Failed ▾" });
    expect(cardState(it({ state: "failed", reason: "geo" }))).toMatchObject({ reason: "not available in your country" });
    expect(cardState(it({ state: "failed", reason: null }))).toMatchObject({ reason: "unknown error" });
  });
  test("✓ Downloaded", () => {
    expect(cardState({ id: 7, videoId: "v", state: "done" })).toEqual({ kind: "done", itemId: 7, label: "✓ Downloaded" });
    expect(cardState(it({ state: "done_outside" })).kind).toBe("done");
  });
});

describe("formatting", () => {
  test("eta", () => {
    expect(formatEta(31)).toBe("31 s");
    expect(formatEta(240)).toBe("4 min");
    expect(formatEta(3900)).toBe("1 h 5 min");
    expect(formatEta(7200)).toBe("2 h");
  });
  test("estimate", () => {
    expect(formatEstimate(120e6)).toBe("≈ 120 MB");
    expect(formatEstimate(1.5e9)).toBe("≈ 1.5 GB");
    expect(formatEstimate(800)).toBe("≈ 1 kB");
    expect(formatEstimate(null)).toBe("size unknown");
  });
  test("progress clamps and needs a size", () => {
    expect(progressFraction({ doneBytes: 150, exactBytes: 100 })).toBe(1);
    expect(progressFraction({ doneBytes: 1, exactBytes: null, estBytes: null })).toBeNull();
  });
  test("hash-only has no source id", () => {
    expect(hasSourceId({ youtubeId: null, instagramId: null, rutubeId: null })).toBe(false);
    expect(hasSourceId({ youtubeId: null, instagramId: "Cx", rutubeId: null })).toBe(true);
  });
});

describe("the polling rule", () => {
  const map: Record<string, CardItem> = {
    q: it({ videoId: "q", state: "queued", rank: 2 }),
    w: it({ videoId: "w", state: "waiting" }),
    r: it({ videoId: "r", state: "downloading" }),
    m: it({ videoId: "m", state: "merging" }),
    s: it({ videoId: "s", state: "scanning" }),
    f: it({ videoId: "f", state: "failed" }),
    d: { id: 1, videoId: "d", state: "done" },
  };
  test("1 s while a card on screen is queued or running", () => {
    for (const id of ["q", "w", "r", "m", "s"]) expect(pollInterval([id], map)).toBe(FAST_POLL_MS);
    expect(pollInterval(["idle", "f", "r"], map)).toBe(FAST_POLL_MS);
  });
  test("a live item off screen does not make the cards poll fast", () => {
    expect(pollInterval(["idle", "f", "d"], map)).toBe(SLOW_POLL_MS);
  });
  test("no card on screen, no polling", () => {
    expect(pollInterval([], map)).toBeNull();
  });
  test("newly done items reload the grid once", () => {
    expect(newlyDone({ r: map.r }, { r: { id: 7, videoId: "r", state: "done" } })).toEqual(["r"]);
    expect(newlyDone({ d: map.d }, { d: map.d })).toEqual([]);
  });
});

describe("the log tail at the error", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  test("ends a few lines after the error and scrolls to it", () => {
    const t = tailAtError(lines, 60, 40, 3);
    expect(t.lines.length).toBe(40);
    expect(t.lines[t.lines.length - 1]).toBe("line 63");
    expect(t.lines[t.scrollTo]).toBe("line 60");
  });
  test("an error near the start keeps it in the window", () => {
    const t = tailAtError(lines, 2, 40, 3);
    expect(t.lines[0]).toBe("line 0");
    expect(t.lines[t.scrollTo]).toBe("line 2");
  });
  test("no error: the last lines, scrolled to the end", () => {
    const t = tailAtError(lines, -1, 10);
    expect(t.lines).toEqual(lines.slice(90));
    expect(t.scrollTo).toBe(9);
  });
  test("empty log", () => {
    expect(tailAtError([], 5)).toEqual({ lines: [], scrollTo: -1 });
  });
});

describe("the hover estimate", () => {
  const dir = mkdtempSync(join(tmpdir(), "tuva-cardest-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, "c.db"), join(import.meta.dir, "..", "migrations"));
  test("either quality spelling", () => {
    expect(estimateQuality("720")).toBe("720p");
    expect(estimateQuality("720p")).toBe("720p");
    expect(estimateQuality("best")).toBe("best");
    expect(estimateQuality(undefined)).toBe("1080p");
  });
  test("Reference size at the last job's quality, else 1080p; duration fallback; unknown Video", () => {
    const a = insertVideo(db, { title: "a", youtube_id: "aaaaaaaaaa1", size_bytes: 100_000_000, height: 1080, duration_s: 60 });
    const b = insertVideo(db, { title: "b", youtube_id: "aaaaaaaaaa2", duration_s: 8 });
    expect(cardEstimate(db, a)).toEqual({ videoId: a, quality: "1080p", estBytes: 100_000_000 });
    expect(cardEstimate(db, b)?.estBytes).toBe(2_500_000);
    db.prepare("INSERT INTO download_job (kind, quality, dest_dir, created_at) VALUES ('card', '720', '/r', 'x')").run();
    expect(cardEstimate(db, a)).toEqual({ videoId: a, quality: "720p", estBytes: 50_000_000 });
    expect(cardEstimate(db, "nope")).toBeNull();
  });
});
