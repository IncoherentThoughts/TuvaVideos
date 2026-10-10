// Client-side data: the whole library (~1100 Videos) is fetched once and filtered in memory (ticket #23).
import { useEffect, useRef, useState } from "preact/hooks";
import type { ArtistDto, FavoriteItem, ScanDto, SearchResponse, VideoDto } from "../shared/types";

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

export const api = {
  videos: () => get<VideoDto[]>("/api/videos"),
  video: (id: number) => get<VideoDto>(`/api/videos/${id}`),
  artists: () => get<ArtistDto[]>("/api/artists"),
  favorites: () => get<FavoriteItem[]>("/api/favorites"),
  scan: () => get<ScanDto>("/api/scan"),
  search: (q: string, signal?: AbortSignal) => get<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`, signal),
  rescan: () => post<{ queued: number[] }>("/api/rescan"),
  setFavorite: (kind: "video" | "chapter", id: number, favorite?: boolean) =>
    post<{ favorite: boolean; favoritedAt: string | null }>(`/api/${kind === "video" ? "videos" : "chapters"}/${id}/favorite`, favorite === undefined ? {} : { favorite }),
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
