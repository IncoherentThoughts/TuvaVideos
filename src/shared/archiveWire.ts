// The archive's RPC wire as migration 130 fixed it (Lyrics-Website PR #305; docs/sharing-spec.md §4.1, §4.2, §6.2;
// ticket #126): the 13 function names, each write function's ops and payloads, the Edits every write carries, the
// error codes (SQLSTATE -> wire word, DETAIL shapes) and the read RPCs' returns. The browser's write and sign-in code
// (#114, #116) and Sync (#115) import from here; the row types are in src/shared/sharedRows.ts. Pure: no Supabase
// client, no I/O.
import type { Iso, SharedTables, SharedTombstoneRow, ChapterSource, LatinSource, SuggestionSource, VideoType } from "./sharedRows";

// ---------------------------------------------------------------------------------------------------------------
// Function names
// ---------------------------------------------------------------------------------------------------------------

/** The ten write functions, all `(p_op, p_target, p_payload, p_expected_updated_at, p_edits) returns jsonb`. */
export const WRITE_FUNCTIONS = [
  "write_videos",
  "write_video_chapters",
  "write_video_artists",
  "write_proposed_songs",
  "write_proposed_versions",
  "write_proposed_artists",
  "set_song_exposure",
  "elevate_song",
  "elevate_version",
  "elevate_artist",
] as const;
export type WriteFunction = (typeof WRITE_FUNCTIONS)[number];

/** The read-side RPCs. `video_access_profile_ids` is the lyrics website's (admin only); listed for completeness. */
export const READ_FUNCTIONS = ["video_whoami", "shared_changes_since", "video_access_profile_ids"] as const;
export type ReadFunction = (typeof READ_FUNCTIONS)[number];

/** All 13 RPCs of migration 130 a client may call. (`video_shared_schema()` also exists; `video_whoami` carries its value.) */
export const ARCHIVE_FUNCTIONS = [...WRITE_FUNCTIONS, ...READ_FUNCTIONS] as const;
export type ArchiveFunction = WriteFunction | ReadFunction;

/** The Shared schema migration 130 ships (`video_shared_schema()`); the companion's `SHARED_SCHEMA` must equal it. */
export const ARCHIVE_SHARED_SCHEMA = 1;

// ---------------------------------------------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------------------------------------------

export const OPS = {
  write_videos: ["insert", "update", "delete", "restore"],
  write_video_chapters: ["add", "update", "delete", "confirm", "confirm_all", "reject", "unreject"],
  write_video_artists: ["replace", "confirm_all", "reject", "unreject", "repoint"],
  write_proposed_songs: ["create", "update", "delete"],
  write_proposed_versions: ["create", "update", "delete"],
  write_proposed_artists: ["create", "update", "delete"],
  set_song_exposure: ["expose", "unexpose"],
  elevate_song: ["elevate"],
  elevate_version: ["elevate"],
  elevate_artist: ["elevate"],
} as const satisfies Record<WriteFunction, readonly string[]>;

export type OpOf<F extends WriteFunction> = (typeof OPS)[F][number];
export type WriteVideosOp = OpOf<"write_videos">;
export type WriteVideoChaptersOp = OpOf<"write_video_chapters">;
export type WriteVideoArtistsOp = OpOf<"write_video_artists">;
export type WriteProposedOp = OpOf<"write_proposed_songs">;
export type SetSongExposureOp = OpOf<"set_song_exposure">;
export type ElevateOp = OpOf<"elevate_song">;

/** Ops that require `p_expected_updated_at` (the target's stamp; for `write_video_artists replace`, the Video's). */
export const STAMP_REQUIRED: { [F in WriteFunction]?: readonly OpOf<F>[] } = {
  write_videos: ["update", "delete", "restore"],
  write_video_chapters: ["update", "delete", "reject"],
  write_video_artists: ["replace"],
  write_proposed_songs: ["update"],
  write_proposed_versions: ["update"],
  write_proposed_artists: ["update"],
};

// ---------------------------------------------------------------------------------------------------------------
// Edits (p_edits) and the event registry (130's CHECK on video_edit_history)
// ---------------------------------------------------------------------------------------------------------------

export const TARGET_TYPES = [
  "video", "chapter", "artist_link", "chapter_rejection", "artist_rejection",
  "proposed_song", "proposed_version", "proposed_artist", "exposure",
] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export const EVENT_TYPES = [
  "video.scanned", "video.migrated", "video.title_changed", "video.type_changed",
  "video.song_changed", "video.version_changed", "video.title_latin_changed",
  "video.provenance_changed", "video.poster_changed", "video.suggested",
  "video.deleted", "video.restored",
  "chapter.added", "chapter.changed", "chapter.deleted", "chapter.suggested",
  "chapter.confirmed", "chapter.rejected", "chapter.unrejected",
  "artists.replaced", "artists.suggested", "artists.confirmed",
  "artist_link.rejected", "artist_link.unrejected", "artist_link.repointed",
  "proposed.song_created", "proposed.song_changed", "proposed.song_deleted", "proposed.song_elevated",
  "proposed.version_created", "proposed.version_changed", "proposed.version_deleted", "proposed.version_elevated",
  "proposed.artist_created", "proposed.artist_changed", "proposed.artist_deleted", "proposed.artist_elevated",
  "proposed.migrated",
  "exposure.exposed", "exposure.unexposed",
] as const;
export type EditEventType = (typeof EVENT_TYPES)[number];

/** The event families (the part before the dot) each write function accepts; the `elevate_*` functions take none. */
export const EVENT_FAMILIES: Record<WriteFunction, readonly string[]> = {
  write_videos: ["video"],
  write_video_chapters: ["chapter"],
  write_video_artists: ["artists", "artist_link"],
  write_proposed_songs: ["proposed"],
  write_proposed_versions: ["proposed"],
  write_proposed_artists: ["proposed"],
  set_song_exposure: ["exposure"],
  elevate_song: [],
  elevate_version: [],
  elevate_artist: [],
};

/**
 * One Edit in `p_edits`. The function fills in `video_id`, `target_type`, `target_id` and `editor_id = auth.uid()`.
 * Every write but `elevate_*` needs at least one (else `22023`); `elevate_*` need `[]` (they write their own history).
 */
export interface EditInput {
  event_type: EditEventType;
  field_name?: string | null;
  old_value?: unknown;
  new_value?: unknown;
  description: string;
  /** The history row this Edit undoes (§4.7). */
  reverses?: string | null;
}

/** True when the Edit's event family belongs to the function (the archive refuses the call with `22023` otherwise). */
export function editBelongsTo(fn: WriteFunction, e: Pick<EditInput, "event_type">): boolean {
  return EVENT_FAMILIES[fn].includes(e.event_type.split(".")[0]!);
}

// ---------------------------------------------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------------------------------------------

/** An Artist named by a pointer pair: exactly one of the two. */
export type ArtistRef = { artist_id: string; proposed_artist_id?: null } | { artist_id?: null; proposed_artist_id: string };

/** The `videos` columns `write_videos update` may set (`youtube_id` / `content_hash` only to backfill a null). */
export interface VideoColumns {
  title: string;
  type: VideoType | null;
  type_suggested: boolean;
  song_id: string | null;
  proposed_song_id: string | null;
  version_id: string | null;
  proposed_version_id: string | null;
  song_suggested: boolean;
  suggestion_source: SuggestionSource | null;
  title_latin: string | null;
  title_latin_source: LatinSource | null;
  instagram_id: string | null;
  rutube_id: string | null;
  poster_path: string | null;
  youtube_id: string | null;
  content_hash: string | null;
}

/** The `video_chapters` columns `add` / `update` take. */
export interface ChapterColumns {
  start_s: number;
  title: string | null;
  title_latin: string | null;
  song_id: string | null;
  proposed_song_id: string | null;
  version_id: string | null;
  proposed_version_id: string | null;
  suggested: boolean;
  source: ChapterSource | null;
}

export type ArtistLinkInput = ArtistRef & { suggested?: boolean };

export interface WriteVideosPayloads {
  /** `p_target` is the client-minted id (never `id` in the payload). Chapters and Artists in order. */
  insert: Partial<VideoColumns> & { title: string; chapters?: (Partial<ChapterColumns> & { id?: string; start_s: number })[]; artists?: ArtistLinkInput[] };
  update: Partial<VideoColumns>;
  delete: { reason: string };
  restore: Record<string, never>;
}

export interface WriteVideoChaptersPayloads {
  /** Target = the Video (its stamp optional); `id` may be client-minted. */
  add: Partial<ChapterColumns> & { id?: string; start_s: number };
  /** Target = the Chapter (its stamp required). */
  update: Partial<ChapterColumns>;
  delete: Record<string, never>;
  /** Target = the Chapter (stamp optional). */
  confirm: Record<string, never>;
  /** Target = the Video. */
  confirm_all: Record<string, never>;
  /** Target = the Chapter (stamp required). */
  reject: Record<string, never>;
  /** Target = the rejection id. */
  unreject: Record<string, never>;
}

export interface WriteVideoArtistsPayloads {
  /** Target = the Video (the Video's stamp required). */
  replace: { artists: ArtistLinkInput[] };
  /** Target = the Video. */
  confirm_all: Record<string, never>;
  /** Target = the link id. */
  reject: Record<string, never>;
  /** Target = the rejection id. */
  unreject: Record<string, never>;
  /** Target null; exactly one `artist_link.repointed` Edit, the per-Video template, filed once per touched Video. */
  repoint: { from: ArtistRef; to: ArtistRef };
}

export interface ProposedSongColumns {
  name: string;
  english_name: string | null;
  alternate_titles: string | null;
  notes: string | null;
}

export interface ProposedVersionColumns {
  label: string;
  lyrics_cyrillic: string | null;
  lyrics_transliteration: string | null;
  lyrics_translation: string | null;
  source: string | null;
  footnotes_cyrillic: unknown;
  footnotes_transliteration: unknown;
  footnotes_translation: unknown;
}

/** `create`: target = the minted id; `force: true` skips the dedupe (`VD422`). `update`: stamp required. */
export interface WriteProposedSongsPayloads {
  create: Partial<ProposedSongColumns> & { name: string; force?: boolean };
  update: Partial<ProposedSongColumns>;
  delete: Record<string, never>;
}

export interface WriteProposedVersionsPayloads {
  /** Exactly one parent: `song_id` (archive) or `proposed_song_id`. */
  create: Partial<ProposedVersionColumns> & { label: string; song_id?: string | null; proposed_song_id?: string | null; force?: boolean };
  update: Partial<ProposedVersionColumns>;
  delete: Record<string, never>;
}

export interface WriteProposedArtistsPayloads {
  create: { name: string; force?: boolean };
  update: { name?: string };
  delete: Record<string, never>;
}

/** Target = a Song id, or an Artist id with `{kind: 'artist'}`. Admin only. */
export interface SetSongExposurePayloads {
  expose: { kind?: "song" | "artist" };
  unexpose: { kind?: "song" | "artist" };
}

/** `p_edits` must be `[]`. `use_existing` folds the Proposed row into an existing archive row instead of inserting. */
export interface ElevateSongPayloads {
  elevate: { use_existing?: string; force?: boolean; slug?: string };
}
export interface ElevateVersionPayloads {
  /** `confirm_public: true` is required for a Version under a public Song (`song_lyrics` has no `is_hidden`). */
  elevate: { use_existing?: string; force?: boolean; confirm_public?: boolean };
}
export interface ElevateArtistPayloads {
  elevate: { use_existing?: string; force?: boolean };
}

export interface PayloadsOf {
  write_videos: WriteVideosPayloads;
  write_video_chapters: WriteVideoChaptersPayloads;
  write_video_artists: WriteVideoArtistsPayloads;
  write_proposed_songs: WriteProposedSongsPayloads;
  write_proposed_versions: WriteProposedVersionsPayloads;
  write_proposed_artists: WriteProposedArtistsPayloads;
  set_song_exposure: SetSongExposurePayloads;
  elevate_song: ElevateSongPayloads;
  elevate_version: ElevateVersionPayloads;
  elevate_artist: ElevateArtistPayloads;
}

/** The named arguments of one write call, for `supabase.rpc(fn, args)`. */
export interface WriteArgs<F extends WriteFunction, O extends OpOf<F> = OpOf<F>> {
  p_op: O;
  p_target: string | null;
  p_payload: O extends keyof PayloadsOf[F] ? PayloadsOf[F][O] : never;
  p_expected_updated_at: Iso | null;
  p_edits: EditInput[];
}

/**
 * What every write function returns: the rows it touched in `shared_changes_since`'s `tables` shape (each Video with
 * its complete children, plus the history rows the call wrote), ready for `POST /api/cache/apply`. The `elevate_*`
 * bundles also carry `songs` / `song_lyrics` / `artists` and `video_exposed_songs`.
 */
export interface WriteResult {
  tables: SharedTables;
  tombstones: SharedTombstoneRow[];
}

// ---------------------------------------------------------------------------------------------------------------
// Errors: the SQLSTATE is the wire value, HINT carries the same word
// ---------------------------------------------------------------------------------------------------------------

export const ERROR_CODES = {
  "42501": "forbidden",
  P0002: "not-found",
  VD409: "conflict",
  VD422: "duplicate-candidate",
  VD423: "in-use",
  "23505": "exists",
  "22023": "malformed",
} as const;
export type ArchiveSqlState = keyof typeof ERROR_CODES;
export type WireWord = (typeof ERROR_CODES)[ArchiveSqlState];

/** `VD409`'s DETAIL: the row's current stamp and the last history row on it (who changed it, old -> new). */
export interface ConflictDetail {
  table: string;
  id: string;
  updated_at: Iso;
  last_edit: {
    id: string;
    editor_id: string | null;
    event_type: string;
    field_name: string | null;
    old_value: unknown;
    new_value: unknown;
    created_at: Iso;
  } | null;
}

/** One entry of `VD422`'s DETAIL. */
export interface DuplicateCandidate {
  kind: "archive" | "proposed";
  id: string;
  name: string;
}

/** `VD423`'s DETAIL: how many rows still point at the Proposed row. */
export interface InUseDetail {
  count: number;
}

export type ArchiveError =
  | { word: "conflict"; code: "VD409"; message: string; detail: ConflictDetail | null }
  | { word: "duplicate-candidate"; code: "VD422"; message: string; detail: DuplicateCandidate[] }
  | { word: "in-use"; code: "VD423"; message: string; detail: InUseDetail | null }
  | { word: Exclude<WireWord, "conflict" | "duplicate-candidate" | "in-use">; code: ArchiveSqlState; message: string; detail: null }
  | { word: "unknown"; code: string | null; message: string; detail: null };

/** The wire word of a SQLSTATE, or null for a code the archive does not use as a wire value. */
export function wireWord(code: string | null | undefined): WireWord | null {
  return code != null && Object.hasOwn(ERROR_CODES, code) ? ERROR_CODES[code as ArchiveSqlState] : null;
}

/**
 * A PostgREST error (`{code, message, details, hint}`, as supabase-js hands it over) read as the archive's error:
 * the word from the SQLSTATE (falling back to HINT), the DETAIL JSON parsed for `conflict`, `duplicate-candidate`
 * and `in-use`. Unparseable DETAIL gives null (or `[]` for the candidates), never a throw.
 */
export function readArchiveError(e: { code?: string | null; message?: string | null; details?: string | null; hint?: string | null }): ArchiveError {
  const message = e.message ?? "";
  let word = wireWord(e.code);
  let code = e.code ?? null;
  if (!word && e.hint) {
    const byHint = (Object.entries(ERROR_CODES) as [ArchiveSqlState, WireWord][]).find(([, w]) => w === e.hint);
    if (byHint) [code, word] = byHint;
  }
  const json = (): unknown => {
    if (!e.details) return null;
    try {
      return JSON.parse(e.details);
    } catch {
      return null;
    }
  };
  switch (word) {
    case "conflict": {
      const d = json();
      return { word, code: "VD409", message, detail: d && typeof d === "object" && !Array.isArray(d) ? (d as ConflictDetail) : null };
    }
    case "duplicate-candidate": {
      const d = json();
      return { word, code: "VD422", message, detail: Array.isArray(d) ? (d as DuplicateCandidate[]) : [] };
    }
    case "in-use": {
      const d = json() as InUseDetail | null;
      return { word, code: "VD423", message, detail: d && typeof d.count === "number" ? d : null };
    }
    case null:
      return { word: "unknown", code, message, detail: null };
    default:
      return { word, code: code as ArchiveSqlState, message, detail: null };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Read RPCs
// ---------------------------------------------------------------------------------------------------------------

export type GrantLevel = "member" | "editor";

/** `video_whoami()`: definer, authenticated only (anon gets `42501`). Profile fields are null without a profile row. */
export interface VideoWhoami {
  user_id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  must_change_password: boolean;
  archive_role: string | null;
  grant_level: GrantLevel | null;
  granted_at: Iso | null;
  shared_schema: number;
  server_time: Iso;
}

/** One row of `video_access_profile_ids()` (definer, admin only). */
export interface VideoAccessProfileRow {
  profile_id: string;
  level: GrantLevel;
}

/** `shared_changes_since`'s argument: null asks for everything (a full refetch). */
export interface SharedChangesSinceArgs {
  p_since: Iso | null;
}

/** The tables `shared_changes_since` always sends whole, as its `replace_whole` lists them. */
export const REPLACE_WHOLE = ["video_exposed_songs", "album_tracks", "album_track_artists", "album_artists"] as const;

/** Every key of `shared_changes_since(...).tables`, in the order the archive builds them. */
export const SHARED_TABLES = [
  "videos", "video_chapters", "video_artists", "video_chapter_rejections", "video_artist_rejections",
  "video_proposed_songs", "video_proposed_versions", "video_proposed_artists", "video_exposed_songs", "video_edit_history",
  "songs", "song_lyrics", "artists", "song_performances", "albums", "album_tracks", "album_track_artists", "album_artists",
] as const satisfies readonly (keyof SharedTables)[];

/** How the pull's next `p_since` trails the watermark (the `now()` overlap, §6.2). */
export const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;
