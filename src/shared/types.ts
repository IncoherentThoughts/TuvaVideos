// Shapes of the JSON the server sends and the web UI reads.
import type { VideoType } from "./filters";
import type { TvDecision } from "./playbackProfile";

export type { TvDecision };

export interface ArtistRef {
  /** An archive Artist's uuid, a Proposed Artist's, or a Local Artist's (migration 0015). */
  id: string;
  name: string;
  nameLatin: string | null;
  /** A Local Artist: this machine's own row, on Unshared Videos only. */
  local: boolean;
  /** A Proposed Artist (a Video Editor's, not yet in the archive; marked Proposed wherever shown, sharing-spec §7.5). */
  proposed: boolean;
  /** Offered by the Artist matcher and not yet confirmed (dashed tag). */
  suggested: boolean;
  /** The `video_artists` link's id (a Shared reject targets it, sharing-spec §4.1); absent outside a Video. */
  linkId?: string;
}

/** What the header shows of a Video's Song. `name: null` is a dangling uuid ("unknown song", ADR-0001). */
export interface SongRef {
  id: string;
  name: string | null;
  englishName: string | null;
  /** Hidden in the archive (un-reviewed); shown with a badge. */
  hidden: boolean;
  /** A Local Song: this machine's own row. */
  local: boolean;
  /** A Proposed Song (sharing-spec §3.4). */
  proposed: boolean;
  versions: { id: string; label: string; local: boolean; proposed: boolean }[];
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

/** The TV Playback profile's result for a Copy and the source the TV plays (docs/tv-spec.md 3.1, 3.2). */
export interface TvCopyDto {
  /** Null until the Copy is judged (a moment after a scan or a new profile version). */
  decision: TvDecision | null;
  order: "file" | "fallback" | "live";
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
  tv: TvCopyDto;
  fallback: { state: string; progress?: number | null; error?: string };
  url: string;
  /** Absolute path of the file on disk. */
  path: string;
}

/** `GET /api/copies/:id/keyframes` (spec 4.1). */
export type KeyframeStatusDto = { state: "ready"; keyframes: number[] } | { state: "indexing" } | { state: "none" };

export interface VideoDto {
  /** The Video's uuid (migration 0015; the Shared id once the Video is Shared). */
  id: string;
  youtubeId: string | null;
  /** Shortcode of the Instagram post the Video was downloaded from, if known (provenance only, ADR 0005). */
  instagramId: string | null;
  /** The rutube.ru video id the Video was downloaded from, if known (provenance only, ADR 0008). */
  rutubeId: string | null;
  /** The Shared data knows this Video (a Sync or cache apply delivered it); false = Unshared or Standalone. */
  shared: boolean;
  /** The row's `updated_at`: a Shared write's `p_expected_updated_at` (sharing-spec §4.2). */
  updatedAt: string;
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
  suggestionSource: "manual" | "comment" | "description" | "performance" | "title" | null;
  favoritedAt: string | null;
  resumeS: number | null;
  lastPlayedAt: string | null;
  /** Times the Player started this Video here (migration 0009); reset by right-click in any list. */
  viewCount: number;
  /** The A-B loop left set on this Video, restored when it reopens (spec 4.3). */
  loop: { a: number; b: number } | null;
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
  /**
   * home-server-spec §5.2: the connected Home Server has a usable Copy of this Video (a match by id, youtube_id or
   * content_hash, or a `homeOnly` row). With no usable local Copy the Video is On the Home Server. Absent = false.
   */
  home?: { copies: number; server: string | null };
  /** A `home_video` row: a Video only the Home Server has, shown read-only with its titles, Type and Chapters. */
  homeOnly?: boolean;
}

// ---- the Home Server (docs/home-server-spec.md §4.1, §5.1) ----

/** `GET /api/home` (localhost): this Mac's Home Server setting and connection. */
export interface HomeStatusDto {
  /** A Home Server is set (and this Mac is not it). */
  configured: boolean;
  /** "This Mac is the Home Server". */
  self: boolean;
  /** The stored field, as typed. */
  address: string | null;
  /** `TUVA_HOME_SERVER` overrides the field (tests, smoke runs). */
  override: boolean;
  /** The Library Server base URL the field resolves to. */
  base: string | null;
  /** The last check answered. */
  connected: boolean;
  checkedAt: string | null;
  /** The Home Server's computer name (from health, else from the last index). */
  server: string | null;
  version: string | null;
  drive: "mounted" | "unmounted" | null;
  /** Why the last check failed. */
  error: string | null;
  /** The stored home index, when one was fetched. */
  index: { at: string; videos: number; copies: number; homeOnly: number } | null;
  /** Resume and Favorites following through it (home-server-spec §6); added by the routes. */
  sync?: HomeSyncDto;
}

/** home-server-spec §6: this Mac's Resume and Favorites sync with its Home Server. */
export interface HomeSyncDto {
  /** The first-connect replace (§6.2) has run against the Home Server set now; until then Favorites stay here. */
  firstSyncDone: boolean;
  firstSyncAt: string | null;
  /** Writes waiting in `home_outbox`. */
  outbox: number;
  pulledAt: string | null;
  error: string | null;
}

/** `POST /api/home/test` (localhost): one health check of an address, not saved. */
export type HomeTestDto =
  | { ok: true; base: string; name: string | null; version: string | null; drive: "mounted" | "unmounted"; home: boolean }
  | { ok: false; base: string | null; error: string };

export interface ArtistDto {
  id: string;
  name: string;
  nameLatin: string | null;
  local: boolean;
  proposed: boolean;
  videoCount: number;
  /** Latest Video's id, for the poster. */
  posterVideoId: string | null;
}

/** GET /api/songs: a Mirror Song some Video or Chapter points at. */
export interface SongListDto {
  id: string;
  name: string;
  englishName: string | null;
  /** Videos whose Song pointer is this Song (confirmed or Suggested). */
  videoCount: number;
  /** Chapters pointing at this Song. */
  chapterCount: number;
  /** Lyrics Versions (Mirror and Local); 0 = no lyrics. */
  versionCount: number;
  /** Local Versions among them. */
  localVersionCount: number;
  /** A Local Song (this machine's own row); listed even before any Video points at it. */
  local: boolean;
  proposed: boolean;
  /** The newest of its Videos (else the Video of its newest Chapter), for the poster. */
  posterVideoId: string | null;
  /** Newest Copy mtime over its Videos and Chapters' Videos, ISO. */
  addedAt: string | null;
}

export interface ChapterDto {
  id: string;
  videoId: string;
  startS: number;
  title: string;
  titleLatin: string | null;
  suggested: boolean;
  /** Where a Suggested Chapter came from; `manual` for one made by hand (confirmed Chapters keep their source). */
  source: "manual" | "comment" | "description" | "performance";
  songId: string | null;
  versionId: string | null;
  /** The Chapter's Song (name and Version labels), or null. `name: null` is a dangling uuid. */
  song: SongRef | null;
  favoritedAt: string | null;
  /** The row's `updated_at`: a Shared write's `p_expected_updated_at` (sharing-spec §4.2). */
  updatedAt: string;
}

/** POST /api/videos/:id/chapters */
export interface ChapterCreate {
  startS: number;
  title?: string;
  songId?: string | null;
  versionId?: string | null;
}

/** PATCH /api/chapters/:id. Any key may be left out. Editing the title or start confirms a Suggested Chapter; the Song does not. */
export interface ChapterPatch {
  title?: string;
  startS?: number;
  songId?: string | null;
  versionId?: string | null;
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
  | { kind: "video"; id: string; title: string; type: VideoType; durationS: number | null; available: boolean; songs: string[]; songSuggested: boolean }
  | { kind: "chapter"; id: string; videoId: string; videoTitle: string; title: string; startS: number; available: boolean }
  | { kind: "artist"; id: string; name: string; local: boolean; proposed: boolean; videoCount: number }
  | { kind: "song"; id: string; name: string; englishName: string | null; hidden: boolean; local: boolean; proposed: boolean; viaLyrics: boolean; lyric: string | null; /** Videos performing the Song (their Song pointer, or a Chapter with `startS`), so the results page can list them. */ videos: { id: string; startS: number | null }[] }
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
  hidden: boolean;
  /** A Local Song: created here, renamable and deletable; its Versions are all Local. */
  local: boolean;
  /** A Proposed Song (sharing-spec §3.4). */
  proposed: boolean;
  alternateTitles: string[];
  alternateSpellings: string[];
  /** Every name with its kind (name, english, alternate_title, alternate_spelling). */
  names: { text: string; kind: "name" | "english" | "alternate_title" | "alternate_spelling" }[];
  versions: VersionDto[];
  /** Videos performing the Song (its Song pointer, a Chapter pointing at it, or a Performance with the Video YouTube id): playable ones first. */
  videos: { id: string; title: string; available: boolean; pointed: boolean; startS: number | null }[];
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

/** POST /api/songs: a Local Song. An existing Song with the same name (case-insensitively) is returned instead. */
export interface LocalSongCreate {
  name: string;
  englishName?: string | null;
}

/** A row of `approved_device` (docs/home-server-spec.md §3): a TV or a Mac the Library Server serves. */
export interface ApprovedDeviceDto {
  ip: string;
  kind: "tv" | "mac";
  /** The Mac's computer name (a TV has only its model). */
  name: string | null;
  model: string | null;
  /** How it came in: an Allow click, or on sight through Tailscale. */
  via: "tailscale" | "click";
  approvedAt: string;
  lastSeenAt: string | null;
}

/** The Library Server's `GET /api/approvals` (home-server-spec §3.2), for Approved Macs. */
export interface RemoteApprovalsDto {
  /** The server Mac's computer name: "Allow TV at ‹IP› on ‹name›?". */
  server: string;
  pending: { ip: string; model: string | null }[];
}

/** `GET /api/home/approvals` (localhost): the Home Server's pending approvals, as this Mac sees them. */
export interface HomeApprovalsDto {
  /** False when no Home Server is set on this Mac: the top bar shows nothing and stops asking. */
  configured: boolean;
  /** False when the Home Server did not answer, or refused this Mac. */
  connected: boolean;
  server: string | null;
  pending: { ip: string; model: string | null }[];
}

/** `GET /api/tv` (localhost listener only). */
export interface TvStateDto {
  /** False on a passive server: the Library Server never starts there. */
  available: boolean;
  on: boolean;
  port: number | null;
  /** The Mac's LAN IPv4 addresses. */
  addresses: string[];
  pending: { ip: string; model: string | null }[];
  approved: ApprovedDeviceDto[];
  /** An Approved TV that made a request in the last 60 s; `title` is the Video whose stream it asked for last. */
  playing: { ip: string; model: string | null; title: string | null } | null;
}

/** GET /api/onboarding (docs/sharing-spec.md §8.4): the machine's mode, its Root count and the surface to show. */
export interface OnboardingDto {
  mode: "standalone" | "no-grant" | "member" | "editor";
  rootCount: number;
  /** "panel": the first-launch panel (folder field, Sign in); "bar": the dismissable "No videos folder yet" bar. */
  show: "panel" | "bar" | "none";
}

/** `GET /api/serve-on-launch` (docs/home-server-spec.md §2.2). */
export interface ServeSettingsDto {
  /** False off macOS and on a passive server: neither setting can be used there. */
  available: boolean;
  serveOnLaunch: boolean;
  /** The LaunchAgent exists. Only offered while Serve on launch is on. */
  openAtLogin: boolean;
}
