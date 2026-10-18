// The TV UI's way to the TV Server: every fetch and media URL goes through `base` (docs/tv-spec.md 4.1). In the
// shell `window.tuvaTv.base` names the Mac; standalone in a desktop browser it is the page origin.
import type { AudioState } from "../shared/audio"
import type { ArtistDto, ChapterDto, FavoriteItem, KeyframeStatusDto, SearchResponse, SongDto, SongListDto, VideoDto } from "../shared/types"

export interface TuvaTvShell {
  base: string
  keys?: unknown
  exit: () => void
  restart: () => void
}

declare global {
  interface Window {
    tuvaTv?: TuvaTvShell
  }
}

export const shell = (): TuvaTvShell | undefined => (typeof window !== "undefined" ? window.tuvaTv : undefined)

/** No trailing slash. */
export const base = (): string => (shell()?.base ?? (typeof location !== "undefined" ? location.origin : "")).replace(/\/+$/, "")

/** A server-relative path (`/thumbs/1/poster.webp`, `/copy/2`) as a URL the TV can load. */
export const url = (path: string): string => (/^https?:\/\//.test(path) ? path : base() + path)

export class ApiError extends Error {
  constructor(public status: number, path: string) {
    super(`${status} ${path}`)
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  // No custom header: the UI runs on the packaged shell's origin, and a header would turn every read into a preflight.
  const r = await fetch(url(path), { signal })
  if (r.status === 403) shell()?.restart() // not approved (any more): the shell looks again
  if (!r.ok) throw new ApiError(r.status, path)
  return (await r.json()) as T
}

export const api = {
  videos: () => get<VideoDto[]>("/api/videos"),
  artists: () => get<ArtistDto[]>("/api/artists"),
  songs: () => get<SongListDto[]>("/api/songs"),
  favorites: () => get<FavoriteItem[]>("/api/favorites"),
  song: (id: string) => get<SongDto>(`/api/songs/${encodeURIComponent(id)}`),
  video: (id: string) => get<VideoDto>(`/api/videos/${id}`),
  chapters: (id: string) => get<ChapterDto[]>(`/api/videos/${id}/chapters`),
  keyframes: (copyId: number) => get<KeyframeStatusDto>(`/api/copies/${copyId}/keyframes`),
  audio: (id: string) => get<{ state: AudioState | null }>(`/api/videos/${id}/audio`),
  search: (q: string, signal?: AbortSignal, limit = 20) => get<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, signal),
}

export function exitApp(): boolean {
  const s = shell()
  if (!s) return false // a desktop browser has nothing to exit
  s.exit()
  return true
}

/**
 * The two writes the TV makes (docs/tv-spec.md 2.5). Fire and forget, `keepalive` so leaving the Player still sends
 * them; `text/plain` keeps the request "simple" (no preflight from the shell's origin), the server reads the body as
 * JSON whatever the content type.
 */
function post(path: string, body: unknown): void {
  try {
    void fetch(url(path), { method: "POST", headers: { "content-type": "text/plain" }, body: body === undefined ? undefined : JSON.stringify(body), keepalive: true }).catch(() => {})
  } catch {
    /* a write that cannot be sent is lost; Resume is rewritten every 5 s */
  }
}
export const writes = {
  resume: (videoId: string, resumeS: number, copyId: number | null) => post(`/api/videos/${videoId}/resume`, { resumeS, copyId }),
  view: (videoId: string) => post(`/api/videos/${videoId}/view`, undefined),
}
