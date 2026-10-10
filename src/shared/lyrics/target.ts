// Which Song the lyrics drawer shows (spec 5.4): the current Chapter's Song (the Chapter the playhead is in), else the
// Video's Song, else nothing ("no lyrics"). Chapters are empty until ticket #26; the lookup already takes one.

export interface SongPointer {
  songId: string | null;
  versionId: string | null;
}

export interface LyricsTarget {
  songId: string;
  /** The Version the drawer opens on; null = the first in display order. */
  versionId: string | null;
  /** The pointer came from a Chapter, so its Version pill carries "· this chapter". */
  fromChapter: boolean;
}

export function lyricsTarget(chapter: SongPointer | null | undefined, video: SongPointer | null | undefined): LyricsTarget | null {
  if (chapter?.songId) return { songId: chapter.songId, versionId: chapter.versionId, fromChapter: true };
  if (video?.songId) return { songId: video.songId, versionId: video.versionId, fromChapter: false };
  return null;
}

/** The Chapter the playhead is in: the last one starting at or before `t`. A Chapter has no end time. */
export function chapterAt<C extends { startS: number }>(chapters: readonly C[], t: number): C | null {
  let best: C | null = null;
  for (const c of chapters) if (c.startS <= t && (!best || c.startS > best.startS)) best = c;
  return best;
}
