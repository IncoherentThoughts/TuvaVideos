#!/usr/bin/env bun
// Stage 1 of the Chapter pipeline (spec 8, docs/chapter-pipeline.md): the ONLY part of TuvaVideos that touches the network.
// One yt-dlp call per eligible Video writes `<id>.info.json` (YouTube info: description, top comments, metadata) into the
// cache directory (`TUVA_YT_CACHE`, default `~/Library/Application Support/TuvaVideos/youtube-info/`).
//
//   bun scripts/fetch-youtube-info.ts [ids...] [--limit N] [--force] [--dry-run] [--replies] [--no-suggest]
//
// Eligible: Type concert, plus any Video with a YouTube id longer than 20 min, plus the ids given on the command line.
// Concerts come first, then the longest of the rest; `--limit N` cuts the list (the smoke run uses 20). Resumable: an id
// that is already cached is skipped unless `--force`. `--replies` is the second pass: only ids that
// `bun run suggest-chapters` listed in `<cache>/no-block-ids.txt`, fetched again with replies (max-replies-per-thread=5).
// When at least one info file was written, the run ends with stage 2 (`suggestChapters`) on exactly those ids, so the
// Suggested Chapters appear without a separate `bun run suggest-chapters`; `--no-suggest` skips that. Until then the
// library database is opened read-only; nothing under a Root is touched.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/server/config";
import { eligibleForFetch, type EligibilityRow } from "../src/server/chapters/eligible";
import { formatReport, suggestChapters } from "../src/server/chapters/suggest";
import { checkpoint, openDb } from "../src/server/db";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const valueOf = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const limit = valueOf("limit") ? Number(valueOf("limit")) : Infinity;
const ids = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit");
const force = flag("force");
const dry = flag("dry-run");
const replies = flag("replies");
const suggest = !flag("no-suggest");

const cfg = loadConfig();
const cache = cfg.ytCacheDir;
const YTDLP = existsSync("/usr/local/bin/yt-dlp") ? "/usr/local/bin/yt-dlp" : (Bun.which("yt-dlp") ?? "yt-dlp");
const GAP_MS = 5000;
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const db = new Database(cfg.dbPath, { readonly: true });
const rows = db
  .query(
    `SELECT v.id, v.youtube_id AS youtubeId, v.type, (SELECT MAX(duration_s) FROM copy c WHERE c.video_id = v.id) AS durationS
       FROM video v WHERE v.youtube_id IS NOT NULL`,
  )
  .all() as EligibilityRow[];
db.close();

let targets: EligibilityRow[];
if (replies) {
  const f = join(cache, "no-block-ids.txt");
  const want = existsSync(f) ? readFileSync(f, "utf8").split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const byId = new Map(rows.map((r) => [r.youtubeId, r]));
  targets = want.filter((id) => !existsSync(join(cache, `${id}.replies`)) || force).map((id) => byId.get(id) ?? { id: -1, youtubeId: id, type: "other", durationS: null });
  say(`replies pass: ${want.length} ids marked "no block", ${targets.length} still to fetch`);
} else {
  targets = eligibleForFetch(rows, ids);
}
targets = targets.slice(0, limit);

mkdirSync(cache, { recursive: true });
say(`cache ${cache}; ${targets.length} Video(s) selected${dry ? " (dry run)" : ""}`);
const extractor = replies ? "youtube:max_comments=1000,200,800,5;comment_sort=top" : "youtube:max_comments=200,200,0,0;comment_sort=top";

let fetched = 0, skipped = 0, failed = 0;
const fetchedIds: string[] = [];
for (const [i, t] of targets.entries()) {
  const id = t.youtubeId!;
  const file = join(cache, `${id}.info.json`);
  const label = `[${i + 1}/${targets.length}] ${id} (${t.type}, ${t.durationS ? Math.round(t.durationS / 60) + " min" : "?"})`;
  if (!replies && existsSync(file) && !force) {
    skipped++;
    say(`${label}: cached, skipped`);
    continue;
  }
  if (dry) {
    say(`${label}: would fetch`);
    continue;
  }
  // Write into a scratch directory and move into place, so a killed run never leaves a half-written info.json.
  const tmp = mkdtempSync(join(cache, ".tmp-"));
  const t0 = Date.now();
  const p = Bun.spawn(
    [YTDLP, "--skip-download", "--write-info-json", "--write-comments", "--no-playlist", "--extractor-args", extractor, "--sleep-requests", "1", "-o", join(tmp, "%(id)s.%(ext)s"), "--", id],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const got = join(tmp, `${id}.info.json`);
  if (code === 0 && existsSync(got)) {
    renameSync(got, file);
    if (replies) writeFileSync(join(cache, `${id}.replies`), "");
    fetched++;
    fetchedIds.push(id);
    let n = "?";
    try {
      n = String((JSON.parse(readFileSync(file, "utf8")).comments ?? []).length);
    } catch {}
    say(`${label}: ok, ${n} comments, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } else {
    failed++;
    say(`${label}: FAILED (exit ${code}) ${(err || out).trim().split("\n").slice(-2).join(" | ")}`);
  }
  rmSync(tmp, { recursive: true, force: true });
  if (i < targets.length - 1) await Bun.sleep(GAP_MS);
}
say(`done: ${fetched} fetched, ${skipped} cached, ${failed} failed`);

// Stage 2 on what this run fetched: the cache alone shows nothing in the app until the Chapters are written.
if (fetchedIds.length && suggest) {
  const rw = openDb(cfg.dbPath, cfg.migrationsDir);
  try {
    const r = suggestChapters(rw, { cacheDir: cache, only: fetchedIds });
    say(`suggest-chapters on ${fetchedIds.length} fetched id(s):`);
    console.log(formatReport(r, false));
  } catch (e) {
    say(`suggest-chapters FAILED: ${(e as Error).message} (run \`bun run suggest-chapters ${fetchedIds.join(" ")}\` by hand)`);
  } finally {
    checkpoint(rw);
    rw.close();
  }
}
process.exit(failed && !fetched ? 1 : 0);
