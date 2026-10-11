// The Artist matcher's server pass (spec 2.3): Suggested Artists written to `video_artist` with `suggested = 1`.
// A Video the person has curated (any confirmed Artist row) is left alone; otherwise its Suggested rows are replaced
// by the matcher's current answer minus the rejections. Runs for a new Video at scan time, after every scan, after a
// Mirror import, and from `bun run suggest-artists`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db";
import { matchArtists, type ArtistCandidate } from "../shared/artistMatch";

export interface ArtistSuggestStats {
  videos: number;
  suggested: number;
  cleared: number;
  skippedCurated: number;
}

function uploaderOf(cacheDir: string | undefined, youtubeId: string | null): string[] {
  if (!cacheDir || !youtubeId) return [];
  const f = join(cacheDir, `${youtubeId}.info.json`);
  if (!existsSync(f)) return [];
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as { uploader?: string; channel?: string };
    return [...new Set([j.uploader, j.channel].filter((x): x is string => typeof x === "string" && x.trim() !== ""))];
  } catch {
    return [];
  }
}

export function suggestArtists(db: Db, opts: { videoId?: number; cacheDir?: string; dryRun?: boolean } = {}): ArtistSuggestStats {
  const stats: ArtistSuggestStats = { videos: 0, suggested: 0, cleared: 0, skippedCurated: 0 };
  const candidates: ArtistCandidate[] = (db.query("SELECT id, name, name_latin FROM artist").all() as { id: number; name: string; name_latin: string | null }[]).map((a) => ({
    id: a.id,
    names: [a.name, ...(a.name_latin ? [a.name_latin] : [])],
  }));
  if (!candidates.length) return stats;
  const videos = db
    .query(`SELECT id, youtube_id, title FROM video ${opts.videoId != null ? "WHERE id = ?" : ""} ORDER BY id`)
    .all(...(opts.videoId != null ? [opts.videoId] : [])) as { id: number; youtube_id: string | null; title: string }[];
  const curated = new Set((db.query("SELECT DISTINCT video_id FROM video_artist WHERE suggested = 0").all() as { video_id: number }[]).map((r) => r.video_id));
  const rejected = new Map<number, Set<number>>();
  for (const r of db.query("SELECT video_id, artist_id FROM artist_rejection").all() as { video_id: number; artist_id: number }[])
    (rejected.get(r.video_id) ?? rejected.set(r.video_id, new Set()).get(r.video_id)!).add(r.artist_id);
  const del = db.prepare("DELETE FROM video_artist WHERE video_id = ? AND suggested = 1");
  const ins = db.prepare("INSERT INTO video_artist (video_id, artist_id, position, suggested) VALUES (?, ?, ?, 1)");
  db.transaction(() => {
    for (const v of videos) {
      stats.videos++;
      if (curated.has(v.id)) {
        stats.skippedCurated++;
        continue;
      }
      const skip = rejected.get(v.id);
      const matches = matchArtists(v.title, candidates, uploaderOf(opts.cacheDir, v.youtube_id)).filter((m) => !skip?.has(m.id));
      if (opts.dryRun) {
        stats.suggested += matches.length;
        continue;
      }
      stats.cleared += (del.run(v.id) as { changes: number }).changes;
      matches.forEach((m, i) => ins.run(v.id, m.id, i));
      stats.suggested += matches.length;
    }
  })();
  return stats;
}
