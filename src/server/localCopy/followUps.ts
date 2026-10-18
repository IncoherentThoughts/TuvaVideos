// What runs after archive rows change in the Local copy (a Sync that brought Songs, Performances, Artists or Tracks):
// the follow-ups the retired Mirror import ran, in the order that lets each see the previous one's rows. They touch
// Unshared Videos only (the matchers' rule, sharing-spec §4.3). Sync (ticket #115) calls this after `applyShared` when
// the batch held archive rows; tests call it after loading an archive fixture.
import type { Db } from "../db";
import { applyPerformanceDefaults, type DefaultsStats } from "../defaults";
import { suggestArtists, type ArtistSuggestStats } from "../artistSuggest";
import { suggestSongsFromTitles, type SongSuggestStats } from "../songSuggest";
import { fillLatinTitles, type LatinFillStats } from "../latin";
import { rebuildSearchIndex, type IndexStats } from "../search";
import { runStudioMatcher, type MatcherDeps, type MatchStats } from "../studio/match";

export interface FollowUps {
  defaults: DefaultsStats;
  titleSongs: SongSuggestStats;
  latin: LatinFillStats;
  artists: ArtistSuggestStats;
  index: IndexStats;
  /** null when the Studio matcher was skipped (no Music.app dump). */
  studio: MatchStats | null;
  totalMs: number;
}

export async function runArchiveFollowUps(db: Db, opts: { studio?: MatcherDeps; cacheDir?: string } = {}): Promise<FollowUps> {
  const t0 = performance.now();
  const defaults = applyPerformanceDefaults(db);
  const titleSongs = suggestSongsFromTitles(db); // after the defaults: Performances win over titles
  const latin = fillLatinTitles(db); // after the defaults: a Video that just got a Song may now have an archive spelling
  const artists = suggestArtists(db, { cacheDir: opts.cacheDir }); // the archive's Artists may have changed: offer them again
  const index = rebuildSearchIndex(db); // after the Latin titles: they are part of the indexed text
  const studio = await runStudioMatcher(db, opts.studio); // after the archive rows exist: it matches every archive Track
  return { defaults, titleSongs, latin, artists, index, studio, totalMs: Math.round(performance.now() - t0) };
}
