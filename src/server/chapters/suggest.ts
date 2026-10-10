// Stage 2 of the Chapter pipeline (spec 8, docs/chapter-pipeline.md): offline and re-runnable. Reads the YouTube info
// cache plus the Mirror's Performances, picks a text block, merges Performance offsets, runs the Song matcher and writes
// Suggested Chapters under the re-run rules. The CLI is cli.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db";
import { fillLatinTitles } from "../latin";
import { hasTable, rebuildSearchIndex } from "../search";
import {
  NEAR_TIE,
  TIER_LINKED,
  TIER_MIRROR,
  matchSong,
  prepareSongs,
  type MatchOutcome,
  type PreparedSong,
} from "../../shared/songMatch";
import { applyRerunRules, mergePerformances, selectBlock, type Candidate, type ChapterSource, type PerformanceOffset, type TextBlock, type YtInfo } from "./blocks";

export const AUTO_SOURCES: ChapterSource[] = ["description", "comment", "performance"];

export interface SuggestOptions {
  /** YouTube info cache directory. */
  cacheDir: string;
  /** Limit to these Videos: numeric library ids or YouTube ids. */
  only?: string[];
  dryRun?: boolean;
  thresholds?: { linked: number; mirror: number; nearTie: number };
}

export interface MatchReportRow {
  chapter: string;
  startS: number;
  verdict: MatchOutcome["verdict"];
  tier: MatchOutcome["tier"];
  best: { name: string; score: number } | null;
  runnerUp: { name: string; score: number } | null;
  songName: string | null;
}

export interface VideoReport {
  videoId: number;
  youtubeId: string;
  title: string;
  hasInfo: boolean;
  /** The text source used, or null when no block was found. */
  textSource: "description" | "comment" | null;
  textEntries: number;
  performances: number;
  written: Record<ChapterSource, number>;
  withSong: number;
  match: MatchReportRow[];
  hits: number;
  misses: number;
  nearTies: number;
  droppedNearKept: number;
  droppedTombstoned: number;
  droppedCollided: number;
  replaced: number;
  /** Cached info, but neither description nor comments gave a block: a candidate for the replies pass. */
  noBlock: boolean;
}

export interface SuggestReport {
  videos: VideoReport[];
  noBlockIds: string[];
  totals: { videos: number; withText: number; chapters: number; hits: number; misses: number; nearTies: number };
  thresholds: { linked: number; mirror: number; nearTie: number };
  dryRun: boolean;
  indexRows: number | null;
}

interface VideoRow {
  id: number;
  youtube_id: string;
  title: string;
  copy_duration: number | null;
}

export function readInfo(cacheDir: string, youtubeId: string): YtInfo | null {
  const f = join(cacheDir, `${youtubeId}.info.json`);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as YtInfo;
  } catch {
    return null;
  }
}

function loadSongs(db: Db) {
  if (!hasTable(db, "mirror_song")) return { all: [] as PreparedSong[], byId: new Map<string, PreparedSong>(), names: new Map<string, string>() };
  const rows = db.query("SELECT id, name, english_name, alternate_titles, alternate_spellings FROM mirror_song").all() as any[];
  const all = prepareSongs(rows);
  return { all, byId: new Map(all.map((s) => [s.id, s])), names: new Map<string, string>(rows.map((r) => [r.id, r.name])) };
}

/** Runs the whole stage. With `dryRun` nothing is written (the report is the same). */
export function suggestChapters(db: Db, opts: SuggestOptions): SuggestReport {
  const th = opts.thresholds ?? { linked: TIER_LINKED, mirror: TIER_MIRROR, nearTie: NEAR_TIE };
  const songs = loadSongs(db);
  const hasPerf = hasTable(db, "mirror_performance");

  const vids = db
    .query("SELECT v.id, v.youtube_id, v.title, (SELECT MAX(duration_s) FROM copy c WHERE c.video_id = v.id) AS copy_duration FROM video v WHERE v.youtube_id IS NOT NULL ORDER BY v.id")
    .all() as VideoRow[];
  const only = opts.only?.length ? new Set(opts.only) : null;
  const perfByYt = new Map<string, PerformanceOffset[]>();
  const linkedByYt = new Map<string, Set<string>>();
  if (hasPerf) {
    for (const p of db.query("SELECT youtube_id, song_id, start_s FROM mirror_performance WHERE youtube_id IS NOT NULL").all() as { youtube_id: string; song_id: string; start_s: number | null }[]) {
      (linkedByYt.get(p.youtube_id) ?? linkedByYt.set(p.youtube_id, new Set()).get(p.youtube_id)!).add(p.song_id);
      if (p.start_s != null) (perfByYt.get(p.youtube_id) ?? perfByYt.set(p.youtube_id, []).get(p.youtube_id)!).push({ songId: p.song_id, startS: p.start_s, songName: songs.names.get(p.song_id) ?? "" });
    }
  }

  const report: SuggestReport = {
    videos: [],
    noBlockIds: [],
    totals: { videos: 0, withText: 0, chapters: 0, hits: 0, misses: 0, nearTies: 0 },
    thresholds: th,
    dryRun: !!opts.dryRun,
    indexRows: null,
  };

  for (const v of vids) {
    if (only && !only.has(String(v.id)) && !only.has(v.youtube_id)) continue;
    const info = readInfo(opts.cacheDir, v.youtube_id);
    const perfs = (perfByYt.get(v.youtube_id) ?? []).filter((p) => p.songName !== "" || songs.byId.size === 0);
    if (!info && !perfs.length) continue; // nothing to suggest from

    const duration = v.copy_duration ?? info?.duration ?? null;
    const block: TextBlock | null = info ? selectBlock(info, duration) : null;
    const cands = mergePerformances(block, perfs);

    const existing = db.query("SELECT id, start_s, suggested, source, favorited_at FROM chapter WHERE video_id = ?").all(v.id) as { id: number; start_s: number; suggested: number; source: string; favorited_at: string | null }[];
    const kept = existing.filter((c) => !c.suggested).map((c) => c.start_s);
    const replaceable = existing.filter((c) => c.suggested && (AUTO_SOURCES as string[]).includes(c.source));
    const tombs = db.query("SELECT source, start_s AS startS FROM chapter_rejection WHERE video_id = ?").all(v.id) as { source: string; startS: number }[];
    const rules = applyRerunRules(cands, kept, tombs);

    // Song matcher on the text Chapters that survived the rules and that no Performance supplied a Song for
    const linked = [...(linkedByYt.get(v.youtube_id) ?? [])].map((id) => songs.byId.get(id)).filter((s): s is PreparedSong => !!s);
    const match: MatchReportRow[] = [];
    for (const c of rules.keep) {
      if (c.source === "performance" || c.songId) continue;
      const m = matchSong(c.title, linked, songs.all, th);
      if (m.songId) {
        c.songId = m.songId;
        c.songFrom = "matcher";
      }
      match.push({
        chapter: c.title,
        startS: c.startS,
        verdict: m.verdict,
        tier: m.tier,
        best: m.best ? { name: m.best.name, score: round(m.best.score) } : null,
        runnerUp: m.runnerUp ? { name: m.runnerUp.name, score: round(m.runnerUp.score) } : null,
        songName: m.songId ? (songs.names.get(m.songId) ?? null) : null,
      });
    }

    const written: Record<ChapterSource, number> = { description: 0, comment: 0, performance: 0 };
    for (const c of rules.keep) written[c.source]++;
    const rep: VideoReport = {
      videoId: v.id,
      youtubeId: v.youtube_id,
      title: v.title,
      hasInfo: !!info,
      textSource: block?.source ?? null,
      textEntries: block?.entries.length ?? 0,
      performances: perfs.length,
      written,
      withSong: rules.keep.filter((c) => c.songId).length,
      match,
      hits: match.filter((m) => m.verdict === "hit").length,
      misses: match.filter((m) => m.verdict === "miss").length,
      nearTies: match.filter((m) => m.verdict === "near-tie").length,
      droppedNearKept: rules.nearKept.length,
      droppedTombstoned: rules.tombstoned.length,
      droppedCollided: rules.collided.length,
      replaced: replaceable.length,
      noBlock: !!info && !block,
    };
    report.videos.push(rep);
    if (rep.noBlock) report.noBlockIds.push(v.youtube_id);
    report.totals.videos++;
    if (block) report.totals.withText++;
    report.totals.chapters += rules.keep.length;
    report.totals.hits += rep.hits;
    report.totals.misses += rep.misses;
    report.totals.nearTies += rep.nearTies;

    if (!opts.dryRun) writeVideo(db, v.id, rules.keep, replaceable);
  }

  if (!opts.dryRun) {
    fillLatinTitles(db);
    report.indexRows = rebuildSearchIndex(db).total; // Chapter titles are index rows
    recordNoBlock(opts.cacheDir, report, !!only);
  }
  return report;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Replaces the Video's automatic Suggested Chapters with `keep`. A Favorite among the replaced ones passes to the new Chapter at the same start (±1 s). */
function writeVideo(db: Db, videoId: number, keep: Candidate[], replaced: { id: number; start_s: number; favorited_at: string | null }[]) {
  db.transaction(() => {
    const favs = replaced.filter((r) => r.favorited_at);
    for (const r of replaced) db.query("DELETE FROM chapter WHERE id = ?").run(r.id);
    const ins = db.prepare("INSERT INTO chapter (video_id, start_s, title, song_id, suggested, source, favorited_at) VALUES (?, ?, ?, ?, 1, ?, ?)");
    for (const c of keep) {
      const fav = favs.find((f) => Math.abs(f.start_s - c.startS) <= 1)?.favorited_at ?? null;
      ins.run(videoId, c.startS, c.title, c.songId, c.source, fav);
    }
  })();
}

/** `<cache>/no-block-ids.txt`: the ids the replies pass should refetch. A partial run only updates the ids it looked at. */
function recordNoBlock(cacheDir: string, report: SuggestReport, partial: boolean) {
  const f = join(cacheDir, "no-block-ids.txt");
  const looked = new Set(report.videos.map((v) => v.youtubeId));
  const prev = !existsSync(f) ? [] : readFileSync(f, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  const next = new Set(partial ? prev.filter((id) => !looked.has(id)) : []);
  for (const id of report.noBlockIds) next.add(id);
  try {
    writeFileSync(f, [...next].sort().join("\n") + (next.size ? "\n" : ""));
  } catch {}
}

/** Text form of the report for the terminal. */
export function formatReport(r: SuggestReport, verbose = false): string {
  const L: string[] = [];
  L.push(`suggest-chapters${r.dryRun ? " (dry run: nothing written)" : ""}  thresholds: linked ${r.thresholds.linked}, mirror ${r.thresholds.mirror}, near-tie ${r.thresholds.nearTie}`);
  for (const v of r.videos) {
    const src = v.textSource ? `${v.textSource} block (${v.textEntries} entries)` : v.hasInfo ? "NO BLOCK" : "no cached info";
    L.push(`#${v.videoId} ${v.youtubeId} ${v.title.slice(0, 60)}`);
    L.push(
      `    source: ${src}; Performance offsets: ${v.performances}; written: ${v.written.description} description + ${v.written.comment} comment + ${v.written.performance} performance (${v.withSong} with a Song); replaced ${v.replaced}`,
    );
    if (v.match.length) L.push(`    matcher: ${v.hits} hit, ${v.nearTies} near-tie, ${v.misses} miss of ${v.match.length}`);
    if (v.droppedNearKept || v.droppedTombstoned || v.droppedCollided) L.push(`    dropped: ${v.droppedNearKept} near a confirmed/manual Chapter, ${v.droppedTombstoned} tombstoned, ${v.droppedCollided} same start`);
    for (const m of v.match) {
      if (!verbose && m.verdict === "hit") continue;
      const best = m.best ? `${m.best.name} ${m.best.score}` : "-";
      const ru = m.runnerUp ? `, then ${m.runnerUp.name} ${m.runnerUp.score}` : "";
      L.push(`      ${m.verdict.toUpperCase().padEnd(8)} "${m.chapter}" -> ${m.songName ?? "(none)"}  [best ${best}${ru}${m.tier ? `, tier ${m.tier}` : ""}]`);
    }
  }
  const t = r.totals;
  L.push(`${t.videos} Videos, ${t.withText} with a text block, ${t.chapters} Chapters written; matcher ${t.hits} hit / ${t.nearTies} near-tie / ${t.misses} miss`);
  if (r.noBlockIds.length) L.push(`no block (candidates for the replies pass): ${r.noBlockIds.join(" ")}`);
  if (r.indexRows != null) L.push(`search index rebuilt: ${r.indexRows} rows`);
  return L.join("\n");
}
