// Shapes of the JSON the server sends and the web UI reads.
import type { VideoType } from "./filters";

export interface ArtistRef {
  id: number;
  name: string;
  nameLatin: string | null;
  /** A Local Artist (no Mirror row). */
  local: boolean;
}

/** What the header shows of a Video's Song. `name: null` is a dangling uuid ("unknown song", ADR-0001). */
export interface SongRef {
  id: string;
  name: string | null;
  englishName: string | null;
  versions: { id: string; label: string }[];
}

export interface StripDto {
  url: string;
  frames: number;
  columns: number;
  rows: number;
  frameWidth: number | null;
  frameHeight: number | null;
  intervalS: number | null;
}

export interface CopyDto {
  id: number;
  rootKind: "local" | "external";
  size: number;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  durationS: number | null;
  rFrameRate: string | null;
  /** r_frame_rate as a number (29.97), for frame stepping. */
  frameRate: number | null;
  available: boolean;
  missing: boolean;
  playback: "native" | "remux" | "transcode";
  fallback: { state: string; progress?: number | null; error?: string };
  url: string;
}

export interface VideoDto {
  id: number;
  youtubeId: string | null;
  title: string;
  titleLatin: string | null;
  titleLatinSource: "archive" | "table" | "manual" | null;
  type: VideoType;
  /** The Type came from an automatic source and is not yet confirmed (dashed tag). */
  typeSuggested: boolean;
  songId: string | null;
  versionId: string | null;
  song: SongRef | null;
  songSuggested: boolean;
  suggestionSource: "manual" | "comment" | "description" | "performance" | null;
  favoritedAt: string | null;
  resumeS: number | null;
  lastPlayedAt: string | null;
  createdAt: string;
  durationS: number | null;
  available: boolean;
  preferredCopyId: number | null;
  width: number | null;
  height: number | null;
  /** Newest Copy mtime, ISO; the "date added" of a Video. */
  addedAt: string | null;
  chapterCount: number;
  artists: ArtistRef[];
  /** "local" | "external" for the Preferred Copy, or null when no Copy is mounted. */
  availability: "local" | "external" | null;
  thumbnail: null | {
    generatedAt: string;
    copyId: number | null;
    poster: string;
    strip: StripDto | null;
  };
  copies: CopyDto[];
}

export interface ArtistDto {
  id: number;
  mirrorId: string | null;
  name: string;
  nameLatin: string | null;
  local: boolean;
  videoCount: number;
  /** Latest Video's id, for the poster. */
  posterVideoId: number | null;
}

export interface ChapterDto {
  id: number;
  videoId: number;
  startS: number;
  title: string;
  titleLatin: string | null;
  suggested: boolean;
  favoritedAt: string | null;
}

export type FavoriteItem =
  | { kind: "video"; favoritedAt: string; video: VideoDto }
  | { kind: "chapter"; favoritedAt: string; video: VideoDto; chapter: ChapterDto };

export interface ScanDto {
  running: boolean;
  phase: "idle" | "walking" | "probing" | "finishing";
  filesSeen: number;
  filesToProbe: number;
  filesProbed: number;
  queued: number[];
  lastFinishedAt: string | null;
}

// ---- search ----

export type SearchRow =
  | { kind: "video"; id: number; title: string; type: VideoType; durationS: number | null; available: boolean; songs: string[] }
  | { kind: "chapter"; id: number; videoId: number; videoTitle: string; title: string; startS: number; available: boolean }
  | { kind: "artist"; id: number; name: string; local: boolean; videoCount: number }
  | { kind: "song"; id: string; name: string; englishName: string | null; viaLyrics: boolean; lyric: string | null }
  | { kind: "track"; id: string; name: string; album: string | null; by: string[]; songId: string | null; versionId: string | null }
  | { kind: "album"; id: string; name: string; year: number | null; by: string | null };

export interface SearchGroup {
  key: "songs" | "videos" | "artists" | "tracks" | "albums";
  label: string;
  total: number;
  rows: SearchRow[];
}

export interface SearchResponse {
  /** The folded search text, for highlighting. */
  needle: string;
  groups: SearchGroup[];
  ms: number;
}

// ---- lyrics and editing ----

import type { VersionDto } from "./lyrics/types";

export interface SongDto {
  id: string;
  name: string;
  englishName: string | null;
  alternateTitles: string[];
  versions: VersionDto[];
  /** Videos performing the Song (its Song pointer or a Performance with the Video YouTube id): playable ones first. */
  videos: { id: number; title: string; available: boolean; pointed: boolean; startS: number | null }[];
}

/** PATCH /api/videos/:id. Any key may be left out; songId null clears the Song. */
export interface VideoPatch {
  title?: string;
  /** Typing a Latin title sets its source to manual; null or an empty string hands it back to the generator. */
  titleLatin?: string | null;
  type?: VideoType;
  songId?: string | null;
  versionId?: string | null;
}
