// Shapes of the JSON the server sends and the web UI reads.
import type { VideoType } from "./filters";

export interface ArtistRef {
  id: number;
  name: string;
  nameLatin: string | null;
  /** A Local Artist (no Mirror row). */
  local: boolean;
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
  width: number | null;
  height: number | null;
  durationS: number | null;
  available: boolean;
  missing: boolean;
  playback: string;
  fallback: { state: string; progress?: number | null };
  url: string;
}

export interface VideoDto {
  id: number;
  youtubeId: string | null;
  title: string;
  titleLatin: string | null;
  type: VideoType;
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
  | { kind: "track"; id: string; name: string; album: string | null; by: string[]; songId: string | null }
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
