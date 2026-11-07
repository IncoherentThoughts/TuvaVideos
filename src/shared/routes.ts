// The web app's client routes (hand-rolled history routing, spec 9), in one place: the router (src/web/router.tsx)
// matches them, and the server (src/server/api.ts) serves the app shell for exactly these paths, so a reload, a
// bookmark or a pasted link lands on every page the in-app navigation can reach. Pure.
import { UUID_PATTERN } from "./ids";

/** The pages with a fixed path. */
export const PAGE_PATHS = {
  library: "/",
  favorites: "/favorites",
  artists: "/artists",
  songs: "/songs",
  edits: "/edits",
  search: "/search",
} as const;

/** A Now playing path: `/play/<uuid>` (the Video id). */
export const PLAY_PATH = new RegExp(`^\\/play\\/(${UUID_PATTERN})$`);
/** A Lyrics page: `/lyrics/<song id>`. */
export const LYRICS_PATH = /^\/lyrics\/([0-9a-fA-F-]+)$/;

/** The path as the router reads it: trailing slashes dropped, the root stays `/`. */
export const normalPath = (path: string): string => path.replace(/\/+$/, "") || "/";

const PAGES = new Set<string>(Object.values(PAGE_PATHS));

/** Whether the path is one of the client routes (anything else is the router's "No such page"). */
export function isClientRoute(path: string): boolean {
  const p = normalPath(path);
  return PAGES.has(p) || PLAY_PATH.test(p) || LYRICS_PATH.test(p);
}

/** Whether the server answers the path with the app shell (`index.html`). */
export const servesShell = (path: string): boolean => path === "/index.html" || isClientRoute(path);
