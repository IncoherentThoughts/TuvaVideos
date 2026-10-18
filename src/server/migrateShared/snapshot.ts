// Reads a Local copy (library.db after migrations 0015-0017) into the migration's `LibrarySnapshot` (plan.ts), and
// finds each Video's local poster file. Read-only. The CLI runs this on a migrated temporary copy, never on the
// owner's file itself.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db";
import { legacyIdOf } from "../localCopy/ids";
import type { LibrarySnapshot, PosterFile } from "./plan";

const bool = (rows: Record<string, unknown>[], ...cols: string[]) => {
  for (const r of rows) for (const c of cols) r[c] = !!r[c];
  return rows;
};

export function readSnapshot(db: Db): LibrarySnapshot {
  const all = (sql: string) => db.query(sql).all() as Record<string, unknown>[];
  return {
    videos: bool(all(`SELECT id, youtube_id, content_hash, instagram_id, rutube_id, title, title_latin, title_latin_source, type,
        type_suggested, song_id, proposed_song_id, version_id, proposed_version_id, song_suggested, suggestion_source,
        deleted_at, delete_reason, created_at FROM videos ORDER BY created_at, id`), "type_suggested", "song_suggested") as never,
    chapters: bool(all(`SELECT id, video_id, start_s, title, title_latin, song_id, proposed_song_id, version_id, proposed_version_id,
        suggested, source FROM video_chapters ORDER BY video_id, start_s`), "suggested") as never,
    links: bool(all(`SELECT video_id, artist_id, proposed_artist_id, position, suggested FROM video_artists ORDER BY video_id, position`), "suggested") as never,
    chapterRejections: all(`SELECT id, video_id, source, start_s, created_at FROM video_chapter_rejections ORDER BY video_id, start_s`) as never,
    artistRejections: all(`SELECT id, video_id, artist_id, proposed_artist_id, created_at FROM video_artist_rejections ORDER BY video_id`) as never,
    deletedVideos: all(`SELECT id, youtube_id, content_hash, title, deleted_at FROM deleted_video ORDER BY id`) as never,
    localSongs: all(`SELECT id, name, english_name, alternate_titles, alternate_spellings FROM local_song ORDER BY name, id`) as never,
    localVersions: all(`SELECT id, song_id, label, cyrillic, transliteration, translation, footnotes_cyrillic, footnotes_transliteration,
        footnotes_translation FROM local_version ORDER BY song_id, display_order, label`) as never,
    localArtists: all(`SELECT id, name FROM local_artist ORDER BY name, id`) as never,
    archiveSongs: bool(all(`SELECT id, name, english_name, alternate_titles, alternate_spellings, is_hidden FROM archive_song`), "is_hidden") as never,
    archiveVersions: all(`SELECT id, song_id FROM archive_version`) as never,
    archiveArtists: bool(all(`SELECT id, name, is_hidden FROM archive_artist WHERE is_various_artists = 0`), "is_hidden") as never,
  };
}

/**
 * A Video's poster on disk: `thumbs/<uuid>.poster.webp`, or a file still under an older name: the Video's YouTube id
 * or content hash (how posters were named before 0015 on the owner's machine) or its integer id (`<n>.poster.webp`).
 */
export function findPoster(thumbsDir: string, v: { id: string; youtube_id: string | null; content_hash: string | null }): PosterFile | null {
  const legacy = legacyIdOf(v.id);
  const names = [v.id, v.youtube_id, v.content_hash, legacy?.kind === "video" ? String(legacy.id) : null].filter((x): x is string => !!x);
  for (const n of names) {
    const file = join(thumbsDir, `${n}.poster.webp`);
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    return { file, bytes: statSync(file).size, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  return null;
}
