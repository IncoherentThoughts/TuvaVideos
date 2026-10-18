// The Shared rows as they travel (docs/sharing-spec.md §3.1-3.6, §6.2): what `shared_changes_since` returns, what the
// write functions return to the browser, and what `POST /api/cache/apply` takes. Supabase table names and columns;
// uuid ids; timestamps as ISO strings; booleans as booleans (the Local copy stores them as 0/1). Columns a table gains
// in the archive that the Local copy does not hold are ignored by the apply. Types only.

export type Iso = string;

export interface SharedVideoRow {
  id: string;
  youtube_id: string | null;
  content_hash: string | null;
  instagram_id: string | null;
  rutube_id: string | null;
  title: string;
  title_latin: string | null;
  title_latin_source: "archive" | "table" | "manual" | null;
  type: "song" | "concert" | "interview" | "other";
  type_suggested: boolean;
  song_id: string | null;
  proposed_song_id: string | null;
  version_id: string | null;
  proposed_version_id: string | null;
  song_suggested: boolean;
  suggestion_source: "manual" | "comment" | "description" | "performance" | "title" | null;
  poster_path: string | null;
  deleted_at: Iso | null;
  deleted_by: string | null;
  delete_reason: string | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface SharedChapterRow {
  id: string;
  video_id: string;
  start_s: number;
  title: string;
  title_latin: string | null;
  title_latin_source: "archive" | "table" | "manual" | null;
  song_id: string | null;
  proposed_song_id: string | null;
  version_id: string | null;
  proposed_version_id: string | null;
  suggested: boolean;
  source: "manual" | "comment" | "description" | "performance";
  updated_at: Iso;
}

export interface SharedVideoArtistRow {
  id: string;
  video_id: string;
  artist_id: string | null;
  proposed_artist_id: string | null;
  position: number;
  suggested: boolean;
  updated_at: Iso;
}

export interface SharedChapterRejectionRow {
  id: string;
  video_id: string;
  source: string;
  start_s: number;
  rejected_at: Iso | null;
  updated_at: Iso;
}

export interface SharedArtistRejectionRow {
  id: string;
  video_id: string;
  artist_id: string | null;
  proposed_artist_id: string | null;
  rejected_at: Iso;
  updated_at: Iso;
}

export interface SharedProposedSongRow {
  id: string;
  name: string;
  english_name: string | null;
  alternate_titles: string | null;
  alternate_spellings?: string | null;
  notes: string | null;
  created_at?: Iso;
  updated_at: Iso;
}

/** `text` in `song_lyrics`'s shape (§3.1); the parent is an archive Song or a Proposed Song, exactly one. */
export interface SharedProposedVersionRow {
  id: string;
  song_id: string | null;
  proposed_song_id: string | null;
  version_label: string;
  display_order?: number;
  lyrics_cyrillic: string | null;
  lyrics_transliteration: string | null;
  lyrics_translation: string | null;
  footnotes_cyrillic?: unknown;
  footnotes_transliteration?: unknown;
  footnotes_translation?: unknown;
  created_at?: Iso;
  updated_at: Iso;
}

export interface SharedProposedArtistRow {
  id: string;
  name: string;
  created_at?: Iso;
  updated_at: Iso;
}

export interface SharedExposedSongRow {
  id: string;
  song_id: string | null;
  artist_id?: string | null;
  exposed_by: string | null;
  exposed_at: Iso | null;
  updated_at: Iso;
}

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
  description: string | null;
  created_at: Iso;
}

export interface SharedTombstoneRow {
  /** The Shared table the row was in (`video_proposed_songs`, ...). `table` is accepted too. */
  table_name?: string;
  table?: string;
  row_id: string;
  kind: "deleted" | "elevated";
  at: Iso;
}

/** An archive row in the archive's own shape (`songs`, `song_lyrics`, `artists`, `albums`, ...). */
export type ArchiveRow = Record<string, unknown> & { id?: string; updated_at?: Iso | null };

/**
 * One batch of Shared rows. A Video's children (Chapters, Artist links, rejections) that arrive with their Video replace
 * the ones held for it; children arriving without their Video are upserted one by one.
 */
export interface SharedChanges {
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
  albums?: ArchiveRow[];
  album_artists?: ArchiveRow[];
  album_tracks?: ArchiveRow[];
  album_track_artists?: ArchiveRow[];
  song_performances?: ArchiveRow[];
  tombstones?: SharedTombstoneRow[];
  /** The server's clock at the read, if the RPC returns it (informational). */
  server_now?: Iso;
}

/** What `POST /api/cache/apply` and `applyShared` report. */
export interface ApplySharedResult {
  /** Rows written per Local copy table. */
  applied: Record<string, number>;
  /** Rows skipped per table because the held row is as new or newer (the pull-vs-push guard). */
  skipped: Record<string, number>;
  /** Held children dropped because their bumped parent arrived without them. */
  removed: number;
  /** Tombstones applied (Proposed rows deleted or elevated). */
  tombstones: number;
  /** Max `updated_at` seen in the batch (the next watermark candidate), or null. */
  watermark: Iso | null;
  /** How the search index followed: per row, one full rebuild (above 200 changed rows), or nothing. */
  reindex: "rows" | "rebuild" | "none";
  ms: number;
}
