// Client-side data: the whole library (~1100 Videos) is fetched once and filtered in memory (ticket #23).
import { useEffect, useRef, useState } from "preact/hooks";
import type { AudioPreset, AudioState } from "../shared/audio";
import { pickRandomVideo } from "../shared/random";
import type { DumpHitDto, SongStudioDto, StudioStateDto } from "../shared/studio";
import type { VersionInput } from "../shared/lyrics/types";
import type { ArtistDto, TvStateDto, ChapterCreate, ChapterDto, ChapterPatch, FavoriteItem, KeyframeStatusDto, LocalSongCreate, ScanDto, SearchResponse, SongDto, SongListDto, VideoDto, VideoPatch } from "../shared/types";
import { navigate, playHref } from "./router";

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text().catch(() => "")}`);
  return (await r.json()) as T;
}

/** The server's `{error}` message out of an Error thrown by `get`/`post`/`send`, else the raw text. */
export function apiError(e: unknown): string {
  const m = String((e as Error)?.message ?? e).replace(/^\/api\/\S+: \d+ /, "");
  try {
    const j = JSON.parse(m) as { error?: string };
    if (j.error) return j.error;
  } catch {}
  return m;
}

async function send<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text().catch(() => "")}`);
  return (await r.json()) as T;
}

const songCache = new Map<string, Promise<SongDto>>();

/** Forgets a cached Song (a Local Version was written, or a Local Song renamed) so the next read is fresh. */
export const forgetSong = (id: string) => void songCache.delete(id);

export const api = {
  /** The TV Server (docs/tv-spec.md 2): state, turn on/off, and the Approved TVs prompt. */
  tv: () => get<TvStateDto>("/api/tv"),
  tvOn: () => post<TvStateDto>("/api/tv/on"),
  tvOff: () => post<TvStateDto>("/api/tv/off"),
  tvApprove: (ip: string) => post<TvStateDto>("/api/tv/approve", { ip }),
  tvDeny: (ip: string) => post<TvStateDto>("/api/tv/deny", { ip }),
  tvRemove: (ip: string) => send<TvStateDto>("DELETE", `/api/tv/approved/${encodeURIComponent(ip)}`),
  /** A Song with its Versions. Cached for the page's life: the Mirror only changes through the CLI import, and the
   *  local edits call forgetSong. */
  song: (id: string): Promise<SongDto> => {
    let p = songCache.get(id);
    if (!p) {
      p = get<SongDto>(`/api/songs/${encodeURIComponent(id)}`);
      p.catch(() => songCache.delete(id));
      songCache.set(id, p);
    }
    return p;
  },
  patchVideo: (id: number, patch: VideoPatch) => send<VideoDto>("PATCH", `/api/videos/${id}`, patch),
  /** One more view of the Video; the answer is the updated Video. */
  recordView: (id: number) => send<VideoDto>("POST", `/api/videos/${id}/view`),
  resetViews: (id: number) => send<VideoDto>("DELETE", `/api/videos/${id}/view`),
  /** Delete the Video from the library; `media` also moves its files to the Trash. */
  deleteVideo: (id: number, media: boolean) =>
    send<{ deleted: true; trashed: string[]; kept: { path: string; reason: string }[]; tombstoned: boolean }>("DELETE", `/api/videos/${id}`, { media }),
  /** Show the Copy's file in the Finder. */
  revealCopy: (id: number) => send<{ ok: true }>("POST", `/api/copies/${id}/reveal`),
  /** The Copy's keyframe index (spec 4.1): `ready` with the times, `indexing` while ffprobe reads it, `none` when it cannot be made now. */
  keyframes: (id: number) => get<KeyframeStatusDto>(`/api/copies/${id}/keyframes`),
  relocate: (videoId: number, body: { path: string; copyId?: number | null; merge?: boolean }) => post<VideoDto>(`/api/videos/${videoId}/relocate`, body),
  chooseFile: (start: string) => post<{ path?: string; cancelled?: true }>("/api/choose-file", { start }),
  /** The A-B loop kept on a Video; null clears it (spec 4.3). */
  setLoop: (id: number, loop: { a: number; b: number } | null) => post<{ id: number; loop: { a: number; b: number } | null }>(`/api/videos/${id}/loop`, { loop }),
  setVideoArtists: (id: number, artistIds: number[]) => send<VideoDto>("PUT", `/api/videos/${id}/artists`, { artistIds }),
  createArtist: (name: string) => post<{ id: number; name: string; local: boolean; created: boolean }>("/api/artists", { name }),
  // Local Songs and Local Versions (lyrics written here, outside the Mirror).
  createSong: (body: LocalSongCreate) => post<{ id: string; name: string; englishName: string | null; local: boolean; created: boolean }>("/api/songs", body),
  patchSong: (id: string, body: Partial<LocalSongCreate>) => send<{ id: string; name: string; englishName: string | null }>("PATCH", `/api/songs/${encodeURIComponent(id)}`, body).finally(() => forgetSong(id)),
  deleteSong: (id: string) => send<{ deleted: true }>("DELETE", `/api/songs/${encodeURIComponent(id)}`).finally(() => forgetSong(id)),
  addVersion: (songId: string, body: VersionInput) => post<{ id: string }>(`/api/songs/${encodeURIComponent(songId)}/versions`, body).finally(() => forgetSong(songId)),
  patchVersion: (songId: string, id: string, body: VersionInput) => send<{ id: string }>("PATCH", `/api/versions/${encodeURIComponent(id)}`, body).finally(() => forgetSong(songId)),
  deleteVersion: (songId: string, id: string) => send<{ deleted: true }>("DELETE", `/api/versions/${encodeURIComponent(id)}`).finally(() => forgetSong(songId)),
  chapters: (videoId: number) => get<ChapterDto[]>(`/api/videos/${videoId}/chapters`),
  // Audio settings (spec 4.7): per Video; `state: null` clears them. Presets: built-in and custom EQ curves.
  audio: (videoId: number) => get<{ state: AudioState | null }>(`/api/videos/${videoId}/audio`),
  setAudio: (videoId: number, state: AudioState | null) => send<{ state: AudioState | null }>("PUT", `/api/videos/${videoId}/audio`, { state }),
  audioPresets: () => get<AudioPreset[]>("/api/audio-presets"),
  savePreset: (name: string, eq: number[]) => send<AudioPreset>("PUT", `/api/audio-presets/${encodeURIComponent(name)}`, { eq }),
  deletePreset: (name: string) => send<{ deleted: true }>("DELETE", `/api/audio-presets/${encodeURIComponent(name)}`),
  addChapter: (videoId: number, body: ChapterCreate) => post<ChapterDto>(`/api/videos/${videoId}/chapters`, body),
  patchChapter: (id: number, patch: ChapterPatch) => send<ChapterDto>("PATCH", `/api/chapters/${id}`, patch),
  deleteChapter: (id: number) => send<{ deleted: true; tombstoned: boolean }>("DELETE", `/api/chapters/${id}`),
  confirmChapter: (id: number) => post<ChapterDto>(`/api/chapters/${id}/confirm`),
  rejectChapter: (id: number) => post<{ rejected: true }>(`/api/chapters/${id}/reject`),
  confirmAllChapters: (videoId: number) => post<{ confirmed: number; chapters: ChapterDto[] }>(`/api/videos/${videoId}/chapters/confirm-all`),
  // Studio playback (spec 7). Transport calls answer with the new StudioStateDto.
  studio: (songId: string) => get<SongStudioDto>(`/api/songs/${encodeURIComponent(songId)}/studio`),
  studioSearch: (q: string) => get<{ results: DumpHitDto[] }>(`/api/studio/search?q=${encodeURIComponent(q)}`),
  studioState: () => get<StudioStateDto>("/api/studio/state"),
  studioPlay: (studioTrackId: number) => post<StudioStateDto>("/api/studio/play", { studioTrackId }),
  studioPause: () => post<StudioStateDto>("/api/studio/pause"),
  studioResume: () => post<StudioStateDto>("/api/studio/resume"),
  studioStop: () => post<StudioStateDto>("/api/studio/stop"),
  studioSeek: (position: number) => post<StudioStateDto>("/api/studio/seek", { position }),
  studioLoop: (active: boolean) => post<StudioStateDto>("/api/studio/loop", { active }),
  matchTrack: (mirrorTrackId: string, persistentId: string) => post<{ id: number }>(`/api/tracks/${mirrorTrackId}/match`, { persistentId }),
  addLocal: (songId: string, persistentId: string) => post<{ id: number }>(`/api/songs/${songId}/studio`, { persistentId }),
  confirmStudio: (id: number) => post<{ id: number }>(`/api/studio-tracks/${id}/confirm`),
  removeStudio: (id: number) => send<{ removed: true; tombstoned: boolean }>("DELETE", `/api/studio-tracks/${id}`),
  videos: () => get<VideoDto[]>("/api/videos"),
  video: (id: number) => get<VideoDto>(`/api/videos/${id}`),
  artists: () => get<ArtistDto[]>("/api/artists"),
  songs: () => get<SongListDto[]>("/api/songs"),
  favorites: () => get<FavoriteItem[]>("/api/favorites"),
  scan: () => get<ScanDto>("/api/scan"),
  search: (q: string, signal?: AbortSignal, limit?: number) => get<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`, signal),
  rescan: () => post<{ queued: number[] }>("/api/rescan"),
  quit: () => post<{ quitting: true }>("/api/quit"),
  setFavorite: (kind: "video" | "chapter", id: number, favorite?: boolean) =>
    post<{ favorite: boolean; favoritedAt: string | null }>(`/api/${kind === "video" ? "videos" : "chapters"}/${id}/favorite`, favorite === undefined ? {} : { favorite }),
  confirmArtists: (videoId: number) => post<VideoDto>(`/api/videos/${videoId}/artists/confirm`),
  removeArtist: (videoId: number, artistId: number) => send<VideoDto>("DELETE", `/api/videos/${videoId}/artists/${artistId}`),
  renameArtist: (id: number, name: string) => send<{ id: number; name: string }>("PATCH", `/api/artists/${id}`, { name }),
  merge: (sourceId: number, targetId: number) => post<{ merged: boolean; moved: number }>(`/api/artists/${sourceId}/merge-into/${targetId}`),
};

// ---- a tiny store ----

interface State {
  videos: VideoDto[] | null;
  artists: ArtistDto[] | null;
  error: string | null;
  /** Bumped on every Favorite change so list screens refetch. */
  favVersion: number;
}

let state: State = { videos: null, artists: null, error: null, favVersion: 0 };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};

export function useStore(): State {
  const [, force] = useState(0);
  const seen = useRef(state);
  seen.current = state;
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    // A set() that landed between this render and the effect (the first fetch resolves in ~15 ms,
    // before Preact runs effects) would otherwise never be rendered.
    if (seen.current !== state) f();
    return () => void subs.delete(f);
  }, []);
  return state;
}

export async function loadVideos() {
  try {
    set({ videos: await api.videos(), error: null });
  } catch (e) {
    set({ error: String((e as Error).message ?? e) });
  }
}

/** Puts an edited Video (the server's answer) into the in-memory library so grids and tags agree. */
export function replaceVideo(v: VideoDto) {
  if (state.videos) set({ videos: state.videos.map((x) => (x.id === v.id ? v : x)) });
}

/** Drops a deleted Video from the in-memory library (and from "Now playing" if it was the last one played). */
export function removeVideo(id: number) {
  if (lastPlayed === id) {
    lastPlayed = null;
    try {
      sessionStorage.removeItem("tuva.lastPlayed");
    } catch {}
  }
  set({ videos: state.videos?.filter((x) => x.id !== id) ?? null, favVersion: state.favVersion + 1 });
}

export async function loadArtists() {
  try {
    set({ artists: await api.artists() });
  } catch (e) {
    set({ error: String((e as Error).message ?? e) });
  }
}

export const reloadAll = () => Promise.all([loadVideos(), loadArtists()]);

/** Toggles a Favorite everywhere: optimistic in the in-memory library, then the server's answer. */
export async function toggleFavorite(kind: "video" | "chapter", id: number) {
  const before = state.videos;
  if (kind === "video" && state.videos) {
    set({ videos: state.videos.map((v) => (v.id === id ? { ...v, favoritedAt: v.favoritedAt ? null : new Date().toISOString() } : v)) });
  }
  try {
    const r = await api.setFavorite(kind, id);
    if (kind === "video" && state.videos) set({ videos: state.videos.map((v) => (v.id === id ? { ...v, favoritedAt: r.favoritedAt } : v)) });
    set({ favVersion: state.favVersion + 1 });
  } catch (e) {
    set({ videos: before, error: String((e as Error).message ?? e) });
  }
}

/** Last Video opened in the player, for the "Now playing" tab. */
let lastPlayed: number | null = null;
try {
  const s = sessionStorage.getItem("tuva.lastPlayed");
  if (s) lastPlayed = Number(s);
} catch {}
export const getLastPlayed = () => lastPlayed;
export function setLastPlayed(id: number) {
  lastPlayed = id;
  try {
    sessionStorage.setItem("tuva.lastPlayed", String(id));
  } catch {}
  set({});
}

/** The in-memory library, for code outside components. */
export const currentVideos = () => state.videos;

/**
 * Plays a random Available Video (the top-bar button and `r`), skipping the one on screen so a repeat always moves.
 * Returns the chosen id, or null when the library has no other Available Video.
 */
export function playRandom(): number | null {
  const cur = location.pathname.match(/^\/play\/(\d+)$/);
  const id = pickRandomVideo(state.videos ?? [], cur ? Number(cur[1]) : null);
  if (id != null) navigate(playHref(id));
  return id;
}
