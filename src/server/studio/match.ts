// The Studio matcher (spec 7.3, docs/studio-playback.md). Runs over every Mirror Track after each import.
//
// Pure part: `normalize`, `buildIndex`, `matchTrack`. key = normalized (name, album) against the Music.app dump;
// exactly one hit -> a match; several -> narrow by duration (+-3 s), then by artist token overlap; name-only hits
// (same name, another album) and unresolved ties are *offered*, never auto-matched.
//
// DB part: `applyMatches` writes Suggested `studio_track` rows, absorbs Local Studio tracks, demotes a confirmed match
// whose persistent id went stale, and respects the rejection tombstones (migration 0004).
import type { Db } from "../db";
import { log } from "../log";
import { isPlayable, type DumpCache, type DumpTrack } from "./dump";

// ---- pure ----

/** NFKD, strip diacritics, casefold, drop parentheticals, collapse punctuation and whitespace. */
export function normalize(s: string): string {
  const base = s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const clean = (t: string) => t.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const dropped = clean(base.replace(/\([^)]*\)|\[[^\]]*\]/g, " "));
  // a title that is nothing but a parenthetical keeps its text rather than becoming the empty key
  return dropped || clean(base);
}

export const DURATION_TOLERANCE_S = 3;

export interface MirrorTrackInput {
  id: string;
  songId: string | null;
  name: string;
  album: string;
  /** Seconds, or null (the Mirror often has none). */
  durationS: number | null;
  /** Track artists, else the album's Credits. */
  artists: string[];
}

export interface MatchIndex {
  byKey: Map<string, DumpTrack[]>;
  byName: Map<string, DumpTrack[]>;
}

const keyOf = (name: string, album: string) => `${normalize(name)}\u0000${normalize(album)}`;

export function buildIndex(dump: readonly DumpTrack[]): MatchIndex {
  const byKey = new Map<string, DumpTrack[]>();
  const byName = new Map<string, DumpTrack[]>();
  const push = (m: Map<string, DumpTrack[]>, k: string, t: DumpTrack) => {
    const a = m.get(k);
    if (a) a.push(t);
    else m.set(k, [t]);
  };
  for (const t of dump) {
    if (!isPlayable(t)) continue;
    const n = normalize(t.name);
    if (!n) continue;
    push(byKey, `${n}\u0000${normalize(t.album)}`, t);
    push(byName, n, t);
  }
  return { byKey, byName };
}

const STOP_TOKENS = new Set(["the", "and", "feat", "ft", "with", "of", "ensemble", "band"]);
function artistTokens(parts: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of parts) for (const t of normalize(p).split(" ")) if (t.length >= 2 && !STOP_TOKENS.has(t)) out.add(t);
  return out;
}

/** How many of the Mirror artist's tokens appear among the candidate's artist and album artist. */
export function artistOverlap(mirrorArtists: string[], t: DumpTrack): number {
  const want = artistTokens(mirrorArtists);
  if (!want.size) return 0;
  const have = artistTokens([t.artist, t.albumArtist]);
  let n = 0;
  for (const w of want) if (have.has(w)) n++;
  return n;
}

export type MatchVia = "single" | "duration" | "artist";
export type MatchResult =
  | { kind: "match"; track: DumpTrack; via: MatchVia }
  /** Offered in the miss UI, never auto-matched: `ambiguous` = several hits on the key that narrowing could not settle. */
  | { kind: "offer"; why: "name-only" | "ambiguous"; candidates: DumpTrack[] }
  | { kind: "none" };

function rank(t: MirrorTrackInput, c: DumpTrack[]): DumpTrack[] {
  const score = (x: DumpTrack) =>
    artistOverlap(t.artists, x) * 100 - (t.durationS != null && x.duration > 0 ? Math.min(99, Math.abs(x.duration - t.durationS)) : 50);
  return [...c].sort((a, b) => score(b) - score(a));
}

export function matchTrack(t: MirrorTrackInput, index: MatchIndex): MatchResult {
  const name = normalize(t.name);
  if (!name) return { kind: "none" };
  const hits = index.byKey.get(keyOf(t.name, t.album)) ?? [];
  if (hits.length === 1) return { kind: "match", track: hits[0]!, via: "single" };
  if (hits.length > 1) {
    let cands = hits;
    if (t.durationS != null) {
      const near = cands.filter((x) => x.duration > 0 && Math.abs(x.duration - t.durationS!) <= DURATION_TOLERANCE_S);
      if (near.length === 1) return { kind: "match", track: near[0]!, via: "duration" };
      if (near.length > 1) cands = near;
    }
    const scored = cands.map((x) => ({ x, n: artistOverlap(t.artists, x) }));
    const best = Math.max(...scored.map((s) => s.n));
    const top = scored.filter((s) => s.n === best);
    if (best > 0 && top.length === 1) return { kind: "match", track: top[0]!.x, via: "artist" };
    return { kind: "offer", why: "ambiguous", candidates: rank(t, hits).slice(0, 6) };
  }
  const named = (index.byName.get(name) ?? []).filter((x) => x.persistentId);
  if (named.length) return { kind: "offer", why: "name-only", candidates: rank(t, named).slice(0, 6) };
  return { kind: "none" };
}

// ---- DB ----

export interface MirrorTrackRow extends MirrorTrackInput {
  trackNumber: number;
}

/** Every Mirror Track with its album name and artists (track artists, else the album's primary and extra Credits). */
export function loadMirrorTracks(db: Db): MirrorTrackRow[] {
  const rows = db
    .query(
      `SELECT t.id, t.song_id AS songId, t.track_number AS trackNumber, t.name, t.duration_s AS durationS,
              COALESCE(a.name, '') AS album, a.artist_id AS albumArtistId, t.album_id AS albumId
         FROM archive_track t LEFT JOIN archive_album a ON a.id = t.album_id`,
    )
    .all() as (MirrorTrackRow & { albumArtistId: string | null; albumId: string })[];
  const names = new Map<string, string>();
  for (const r of db.query("SELECT id, name FROM archive_artist").all() as { id: string; name: string }[]) names.set(r.id, r.name);
  const trackArtists = new Map<string, string[]>();
  for (const r of db.query("SELECT track_id, artist_id FROM archive_track_artist ORDER BY track_id, position").all() as { track_id: string; artist_id: string }[]) {
    const n = names.get(r.artist_id);
    if (n) (trackArtists.get(r.track_id) ?? trackArtists.set(r.track_id, []).get(r.track_id)!).push(n);
  }
  const credits = new Map<string, string[]>();
  for (const r of db.query("SELECT album_id, artist_id FROM archive_album_credit ORDER BY album_id, position").all() as { album_id: string; artist_id: string }[]) {
    const n = names.get(r.artist_id);
    if (n) (credits.get(r.album_id) ?? credits.set(r.album_id, []).get(r.album_id)!).push(n);
  }
  return rows.map((r) => {
    let artists = trackArtists.get(r.id);
    if (!artists?.length) {
      artists = [];
      const p = r.albumArtistId ? names.get(r.albumArtistId) : undefined;
      if (p) artists.push(p);
      artists.push(...(credits.get(r.albumId) ?? []));
    }
    return { id: r.id, songId: r.songId, trackNumber: r.trackNumber, name: r.name, durationS: r.durationS, album: r.album, artists };
  });
}

export interface StudioRow {
  id: number;
  song_id: string;
  mirror_track_id: string | null;
  persistent_id: string;
  suggested: number;
  added_at: string;
}

export interface MatchStats {
  /** Mirror Tracks looked at (all of them, whether or not they have a Song). */
  tracks: number;
  withSong: number;
  /** Auto matches, by how they were settled. */
  matched: { total: number; single: number; duration: number; artist: number };
  /** Name-only hits and unresolved ties: offered in the miss UI, never written. */
  offered: { total: number; nameOnly: number; ambiguous: number };
  none: number;
  /** Row changes. */
  inserted: number;
  updated: number;
  dropped: number;
  absorbed: number;
  demoted: number;
  /** Confirmed rows whose id is gone from the dump and that found no fresh match (left as they were). */
  stale: number;
  rejectedSkipped: number;
  /** Distinct Songs that have at least one Studio track after the pass. */
  songsWithStudio: number;
  studioRows: number;
  dumpTracks: number;
}

export function emptyStats(): MatchStats {
  return {
    tracks: 0, withSong: 0, matched: { total: 0, single: 0, duration: 0, artist: 0 }, offered: { total: 0, nameOnly: 0, ambiguous: 0 }, none: 0,
    inserted: 0, updated: 0, dropped: 0, absorbed: 0, demoted: 0, stale: 0, rejectedSkipped: 0, songsWithStudio: 0, studioRows: 0, dumpTracks: 0,
  };
}

/** Deletes a Studio track row and re-points or clears the `studio_last` that named it. */
export function deleteStudioRow(db: Db, id: number, repointTo: number | null = null) {
  if (repointTo != null) db.query("UPDATE studio_last SET studio_track_id = ? WHERE studio_track_id = ?").run(repointTo, id);
  else db.query("DELETE FROM studio_last WHERE studio_track_id = ?").run(id);
  db.query("DELETE FROM studio_track WHERE id = ?").run(id);
}

/**
 * One pass of the matcher over the Mirror (or just `onlyTrackId`). Rules, per Mirror Track that has a Song:
 * - a Local Studio track of the Song whose persistent id is the fresh match becomes that match (absorption);
 * - a confirmed row stays as long as its id is still in the dump; once the id is gone, a fresh match that resolves
 *   differently replaces it and drops it to Suggested (stale id, spec 7.3);
 * - a Suggested row follows the fresh match, and goes when there is none;
 * - no row: a fresh match that was not rejected becomes a Suggested row.
 */
export function applyMatches(db: Db, dump: readonly DumpTrack[], opts: { onlyTrackId?: string } = {}): MatchStats {
  const stats = emptyStats();
  stats.dumpTracks = dump.length;
  const index = buildIndex(dump);
  const ids = new Set(dump.map((t) => t.persistentId));
  const now = new Date().toISOString();
  const all = loadMirrorTracks(db);
  const todo = opts.onlyTrackId ? all.filter((t) => t.id === opts.onlyTrackId) : all;

  const getRow = db.query("SELECT * FROM studio_track WHERE mirror_track_id = ?");
  const findLocal = db.query("SELECT * FROM studio_track WHERE song_id = ? AND mirror_track_id IS NULL AND persistent_id = ?");
  const sameSong = db.query("SELECT id FROM studio_track WHERE song_id = ? AND mirror_track_id IS NOT NULL AND mirror_track_id != ? AND persistent_id = ?");
  const rejected = db.query("SELECT 1 FROM studio_rejection WHERE mirror_track_id = ? AND persistent_id = ?");

  db.exec("BEGIN");
  try {
    for (const t of todo) {
      stats.tracks++;
      const res = matchTrack(t, index);
      if (res.kind === "match") {
        stats.matched.total++;
        stats.matched[res.via]++;
      } else if (res.kind === "offer") {
        stats.offered.total++;
        if (res.why === "name-only") stats.offered.nameOnly++;
        else stats.offered.ambiguous++;
      } else stats.none++;
      if (!t.songId) continue;
      stats.withSong++;

      let fresh = res.kind === "match" ? res.track.persistentId : null;
      if (fresh && rejected.get(t.id, fresh)) {
        stats.rejectedSkipped++;
        fresh = null;
      }
      const row = getRow.get(t.id) as StudioRow | null;
      if (row && row.song_id !== t.songId) db.query("UPDATE studio_track SET song_id = ? WHERE id = ?").run(t.songId, row.id);

      const local = fresh ? (findLocal.get(t.songId, fresh) as StudioRow | null) : null;
      if (local && (!row || row.suggested)) {
        if (row) deleteStudioRow(db, row.id, local.id);
        db.query("UPDATE studio_track SET mirror_track_id = ? WHERE id = ?").run(t.id, local.id);
        stats.absorbed++;
        continue;
      }
      if (row && !row.suggested) {
        if (ids.has(row.persistent_id)) continue; // confirmed and still resolvable: the person's choice stands
        if (fresh && fresh !== row.persistent_id) {
          db.query("UPDATE studio_track SET persistent_id = ?, suggested = 1 WHERE id = ?").run(fresh, row.id);
          stats.demoted++;
        } else stats.stale++;
        continue;
      }
      if (row) {
        if (!fresh) {
          deleteStudioRow(db, row.id);
          stats.dropped++;
        } else if (fresh !== row.persistent_id) {
          db.query("UPDATE studio_track SET persistent_id = ? WHERE id = ?").run(fresh, row.id);
          stats.updated++;
        }
        continue;
      }
      if (!fresh) continue;
      if (sameSong.get(t.songId, t.id, fresh)) continue; // the Song already lists this recording through another Track
      db.query("INSERT INTO studio_track (song_id, mirror_track_id, persistent_id, suggested, added_at) VALUES (?, ?, ?, 1, ?)").run(t.songId, t.id, fresh, now);
      stats.inserted++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  stats.studioRows = (db.query("SELECT COUNT(*) n FROM studio_track").get() as { n: number }).n;
  stats.songsWithStudio = (db.query("SELECT COUNT(DISTINCT song_id) n FROM studio_track").get() as { n: number }).n;
  return stats;
}

/** Stale id on one Track (spec 7.3): re-match just that Mirror Track against the (freshly re-read) dump. */
export function rematchTrack(db: Db, dump: readonly DumpTrack[], mirrorTrackId: string): MatchStats {
  return applyMatches(db, dump, { onlyTrackId: mirrorTrackId });
}

export interface MatcherDeps {
  dump: DumpCache;
}

/**
 * The import hook: re-read the library from Music.app, then match. If Music.app refuses, the cached dump is used; with
 * neither, the pass is skipped and the log says so. Under `bun test` it does nothing unless a dump is injected, so no
 * test ever talks to the real Music.app.
 */
export async function runStudioMatcher(db: Db, deps?: MatcherDeps): Promise<MatchStats | null> {
  if (!deps) {
    if (process.env.NODE_ENV === "test") return null;
    const { loadConfig } = await import("../config");
    const { DumpCache } = await import("./dump");
    deps = { dump: new DumpCache(loadConfig().studioDumpPath) };
  }
  let file;
  try {
    file = await deps.dump.refresh(true);
  } catch (e) {
    file = deps.dump.peek();
    log(`studio matcher: Music.app dump failed (${String((e as Error).message ?? e)})${file ? "; using the cached dump" : "; skipped"}`);
  }
  if (!file) return null;
  const stats = applyMatches(db, file.tracks);
  log(`studio matcher: ${stats.matched.total} matched, ${stats.offered.total} offered, ${stats.none} none of ${stats.tracks} Mirror Tracks; ${stats.studioRows} Studio rows over ${stats.songsWithStudio} Songs`);
  return stats;
}
