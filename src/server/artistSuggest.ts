// The Artist matcher's server pass (spec 2.3): Suggested Artists written to `video_artists` with `suggested = 1`.
// A Video the person has curated (any confirmed Artist link) is left alone; otherwise its Suggested links are replaced
// by the matcher's current answer minus the rejections. Runs for a new Video at scan time, after every scan, after
// archive rows change, and from `bun run suggest-artists`. Unshared Videos only (sharing-spec §4.3): a Shared Video's
// suggestions are the Shared data's.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db";
import { writeArtistLinks } from "./edit";
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

export function suggestArtists(db: Db, opts: { videoId?: string; cacheDir?: string; dryRun?: boolean } = {}): ArtistSuggestStats {
  const stats: ArtistSuggestStats = { videos: 0, suggested: 0, cleared: 0, skippedCurated: 0 };
  const candidates: ArtistCandidate<string>[] = (db.query("SELECT id, name, name_latin FROM artist_all").all() as { id: string; name: string; name_latin: string | null }[]).map((a) => ({
    id: a.id,
    names: [a.name, ...(a.name_latin ? [a.name_latin] : [])],
  }));
  if (!candidates.length) return stats;
  const videos = db
    .query(`SELECT id, youtube_id, title FROM video_full WHERE shared = 0 ${opts.videoId != null ? "AND id = ?" : ""} ORDER BY created_at, id`)
    .all(...(opts.videoId != null ? [opts.videoId] : [])) as { id: string; youtube_id: string | null; title: string }[];
  const curated = new Set((db.query("SELECT DISTINCT video_id FROM video_artists WHERE suggested = 0").all() as { video_id: string }[]).map((r) => r.video_id));
  const rejected = new Map<string, Set<string>>();
  for (const r of db.query("SELECT video_id, COALESCE(artist_id, proposed_artist_id) AS artist_id FROM video_artist_rejections").all() as { video_id: string; artist_id: string }[])
    (rejected.get(r.video_id) ?? rejected.set(r.video_id, new Set()).get(r.video_id)!).add(r.artist_id);
  const del = db.prepare("DELETE FROM video_artists WHERE video_id = ? AND suggested = 1");
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
      writeArtistLinks(db, v.id, matches.map((m) => m.id), 1);
      stats.suggested += matches.length;
    }
  })();
  return stats;
}
