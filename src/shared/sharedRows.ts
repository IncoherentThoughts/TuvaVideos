// The Shared rows as they travel (docs/sharing-spec.md §3.1-3.6, §6.2), in the shape archive migration 130 fixed
// (Lyrics-Website PR #305, ticket #126): what `shared_changes_since` returns, what the write functions return to the
// browser, and what `POST /api/cache/apply` takes. Supabase table names and columns; uuid ids; timestamps as ISO
// strings; booleans as booleans (the Local copy stores them as 0/1); jsonb as JSON values (the Local copy stores them
// as JSON text). test/fixtures/migration-130-columns.json is the checked-in column list these types follow. Types only;
// the RPC names, ops, payloads and error codes are in src/shared/archiveWire.ts.

export type Iso = string;

export type VideoType = "song" | "concert" | "interview" | "other";
export type LatinSource = "archive" | "table" | "manual";
export type ChapterSource = "manual" | "comment" | "description" | "performance";
export type SuggestionSource = ChapterSource | "title";

/**
 * `videos`. The archive leaves `type` nullable and the value lists unchecked; the Local copy keeps `type` NOT NULL with
 * its CHECK (the companion is the only writer), so a row breaking them fails the apply.
 */
export interface SharedVideoRow {
  id: string;
  youtube_id: string | null;
  content_hash: string | null;
  instagram_id: string | null;
  rutube_id: string | null;
  title: string;
  title_latin: string | null;
  title_latin_source: LatinSource | null;
  type: VideoType | null;
  type_suggested: boolean;
  song_id: string | null;
  proposed_song_id: string | null;
  version_id: string | null;
  proposed_version_id: string | null;
  song_suggested: boolean;
  suggestion_source: SuggestionSource | null;
  poster_path: string | null;
  deleted_at: Iso | null;
  deleted_by: string | null;
  delete_reason: string | null;
  created_at: Iso;
  updated_at: Iso;
}

/**
 * `video_chapters`. `start_s` is double precision. No `title_latin_source` on the wire: that column is Local-only. The
 * archive leaves `title` and `source` nullable; the Local copy keeps them NOT NULL, as for `videos.type`.
 */
export interface SharedChapterRow {
  id: string;
  video_id: string;
  start_s: number;
  title: string | null;
  title_latin: string | null;
  song_id: string | null;
  proposed_song_id: string | null;
  version_id: string | null;
  proposed_version_id: string | null;
  suggested: boolean;
  source: ChapterSource | null;
  created_at: Iso;
  updated_at: Iso;
}

/** `video_artists`: exactly one of `artist_id` / `proposed_artist_id`. */
export interface SharedVideoArtistRow {
  id: string;
  video_id: string;
  artist_id: string | null;
  proposed_artist_id: string | null;
  position: number;
  suggested: boolean;
  created_at: Iso;
  updated_at: Iso;
}

export interface SharedChapterRejectionRow {
  id: string;
  video_id: string;
  source: string;
  start_s: number;
  created_by: string | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface SharedArtistRejectionRow {
  id: string;
  video_id: string;
  artist_id: string | null;
  proposed_artist_id: string | null;
  created_by: string | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface SharedProposedSongRow {
  id: string;
  name: string;
  english_name: string | null;
  alternate_titles: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: Iso;
  updated_at: Iso;
}

/** `song_lyrics`'s column names (`label`, `lyrics_*`, `footnotes_*`); the parent is an archive Song or a Proposed Song, exactly one. */
export interface SharedProposedVersionRow {
  id: string;
  song_id: string | null;
  proposed_song_id: string | null;
  label: string;
  lyrics_cyrillic: string | null;
  lyrics_transliteration: string | null;
  lyrics_translation: string | null;
  source: string | null;
  /** jsonb, `[]` when there are none. */
  footnotes_cyrillic: unknown;
  footnotes_transliteration: unknown;
  footnotes_translation: unknown;
  created_by: string | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface SharedProposedArtistRow {
  id: string;
  name: string;
  created_by: string | null;
  created_at: Iso;
  updated_at: Iso;
}

/** One Exposed hidden Song **or** Artist (§3.5): exactly one of `song_id` / `artist_id`. */
export interface SharedExposedSongRow {
  id: string;
  song_id: string | null;
  artist_id: string | null;
  exposed_by: string | null;
  exposed_at: Iso;
  updated_at: Iso;
}

/** `video_edit_history` (§3.6). `video_id` is null for rows about Proposed rows and exposure; `reverses` points an undo at the row it inverts. */
export interface SharedHistoryRow {
  id: string;
  video_id: string | null;
  target_type: string;
  target_id: string | null;
  editor_id: string | null;
  event_type: string;
  field_name: string | null;
  old_value: unknown;
  new_value: unknown;
  description: string;
  reverses: string | null;
  created_at: Iso;
  updated_at: Iso;
}

export type TombstoneTable = "video_proposed_songs" | "video_proposed_versions" | "video_proposed_artists";

/** A Proposed row deleted or elevated (§6.3). `replaced_by` names the archive row an elevated row became. */
export interface SharedTombstoneRow {
  id: string;
  table_name: TombstoneTable;
  row_id: string;
  kind: "deleted" | "elevated";
  replaced_by: string | null;
  at: Iso;
}

/** An archive row in the archive's own shape (`songs`, `song_lyrics`, `artists`, `albums`, ...). */
export type ArchiveRow = Record<string, unknown> & { id?: string; updated_at?: Iso | null };

/** `shared_changes_since(...).tables`, and the `tables` of a write function's return: rows per Shared table. */
export interface SharedTables {
  videos?: SharedVideoRow[];
  video_chapters?: SharedChapterRow[];
  video_artists?: SharedVideoArtistRow[];
  video_chapter_rejections?: SharedChapterRejectionRow[];
  video_artist_rejections?: SharedArtistRejectionRow[];
  video_proposed_songs?: SharedProposedSongRow[];
  video_proposed_versions?: SharedProposedVersionRow[];
  video_proposed_artists?: SharedProposedArtistRow[];
  video_exposed_songs?: SharedExposedSongRow[];
  video_edit_history?: SharedHistoryRow[];
  songs?: ArchiveRow[];
  song_lyrics?: ArchiveRow[];
  artists?: ArchiveRow[];
  song_performances?: ArchiveRow[];
  albums?: ArchiveRow[];
  album_tracks?: ArchiveRow[];
  album_track_artists?: ArchiveRow[];
  album_artists?: ArchiveRow[];
}

export type SharedTableName = keyof SharedTables;

/** Tables the server always sends whole (no `updated_at` to filter on, or the exposure list): replaced wholesale. */
export type ReplaceWholeTable = "video_exposed_songs" | "album_tracks" | "album_track_artists" | "album_artists";

/** Every id of these archive tables the caller can read: the ids-only reconcile of hard deletes (§6.3). */
export interface ArchiveIds {
  songs?: string[];
  song_lyrics?: string[];
  artists?: string[];
  song_performances?: string[];
  albums?: string[];
}

/**
 * One batch of Shared rows: the return of `shared_changes_since(p_since)`, or a write function's
 * `{tables, tombstones}` (the same shape without the pull's fields). A Video's children (Chapters, Artist links,
 * rejections) that arrive with their Video replace the ones held for it; children arriving without their Video are
 * upserted one by one.
 */
export interface SharedChanges {
  tables?: SharedTables;
  /** Tables of `tables` that are complete: rows held here and not in the batch go. */
  replace_whole?: ReplaceWholeTable[];
  tombstones?: SharedTombstoneRow[];
  archive_ids?: ArchiveIds;
  /** The greatest `updated_at` / `at` the server returned, or `p_since` when nothing changed. */
  watermark?: Iso | null;
  since?: Iso | null;
  /** The server's clock at the read (informational). */
  server_time?: Iso;
  /** `video_shared_schema()` at the read; a batch of another schema is refused (§6.4). */
  shared_schema?: number;
}

/** What `POST /api/cache/apply` and `applyShared` report. */
export interface ApplySharedResult {
  /** Rows written per Local copy table. */
  applied: Record<string, number>;
  /** Rows skipped per table because the held row is as new or newer (the pull-vs-push guard). */
  skipped: Record<string, number>;
  /** Held rows dropped: children of a bumped parent that arrived without them, rows a whole table no longer has, archive ids no longer readable. */
  removed: number;
  /** Tombstones applied (Proposed rows deleted or elevated). */
  tombstones: number;
  /** The server's watermark when the batch carries one, else the max `updated_at` seen in the batch, or null. */
  watermark: Iso | null;
  /** How the search index followed: per row, one full rebuild (above 200 changed rows), or nothing. */
  reindex: "rows" | "rebuild" | "none";
  ms: number;
}
