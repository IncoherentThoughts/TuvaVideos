// Filter and sort state of the list screens (Artists, Songs, Favorites) and its URL form, like libraryView.ts for the
// grid. Pure. Every screen has a name filter (`q`), a sort and a direction; the rest is per screen.
//   /artists?q=alash&kind=local&sort=videos
//   /songs?q=saryg&lyrics=1&sort=chapters&dir=asc
//   /favorites?show=chapters&type=song,concert&available=1&sort=title
import { foldQuery } from "./fold";
import { TYPES, type VideoType } from "./filters";

export type Dir = "asc" | "desc";

export const ARTIST_SORTS = ["name", "videos", "added"] as const;
export type ArtistSort = (typeof ARTIST_SORTS)[number];
export const ARTIST_KINDS = ["all", "mirror", "local"] as const;
export type ArtistKind = (typeof ARTIST_KINDS)[number];
export interface ArtistsState { q: string; kind: ArtistKind; sort: ArtistSort; dir: Dir }

export const SONG_SORTS = ["name", "videos", "chapters", "added"] as const;
export type SongSort = (typeof SONG_SORTS)[number];
export interface SongsState { q: string; lyricsOnly: boolean; sort: SongSort; dir: Dir }

export const FAV_SORTS = ["starred", "title", "duration", "added", "views"] as const;
export type FavSort = (typeof FAV_SORTS)[number];
export const FAV_SHOWS = ["both", "videos", "chapters"] as const;
export type FavShow = (typeof FAV_SHOWS)[number];
export interface FavoritesState { q: string; show: FavShow; types: VideoType[]; availableOnly: boolean; sort: FavSort; dir: Dir }

/** Natural direction of a sort: names and titles A-Z, counts and dates biggest / newest first. */
export const naturalDir = (sort: string): Dir => (sort === "name" || sort === "title" ? "asc" : "desc");

const pick = <T extends string>(v: string | null, all: readonly T[], dflt: T): T => (v && (all as readonly string[]).includes(v) ? (v as T) : dflt);

function readCommon<S extends string>(p: URLSearchParams, sorts: readonly S[], dfltSort: S): { q: string; sort: S; dir: Dir } {
  const sort = pick(p.get("sort"), sorts, dfltSort);
  const d = p.get("dir");
  return { q: (p.get("q") ?? "").trim(), sort, dir: d === "asc" || d === "desc" ? d : naturalDir(sort) };
}

function writeCommon(p: URLSearchParams, st: { q: string; sort: string; dir: Dir }, dfltSort: string) {
  if (st.q.trim()) p.set("q", st.q.trim());
  if (st.sort !== dfltSort) p.set("sort", st.sort);
  if (st.dir !== naturalDir(st.sort)) p.set("dir", st.dir);
}

const done = (p: URLSearchParams) => {
  const s = p.toString().replace(/%2C/g, ",");
  return s ? `?${s}` : "";
};

// ---- Artists ----

export const defaultArtistsState = (): ArtistsState => ({ q: "", kind: "all", sort: "name", dir: "asc" });

export function parseArtistsSearch(search: string): ArtistsState {
  const p = new URLSearchParams(search);
  return { ...readCommon(p, ARTIST_SORTS, "name"), kind: pick(p.get("kind"), ARTIST_KINDS, "all") };
}

export function artistsQuery(st: ArtistsState): string {
  const p = new URLSearchParams();
  writeCommon(p, st, "name");
  if (st.kind !== "all") p.set("kind", st.kind);
  return done(p);
}

// ---- Songs ----

export const defaultSongsState = (): SongsState => ({ q: "", lyricsOnly: false, sort: "name", dir: "asc" });

export function parseSongsSearch(search: string): SongsState {
  const p = new URLSearchParams(search);
  return { ...readCommon(p, SONG_SORTS, "name"), lyricsOnly: p.get("lyrics") === "1" };
}

export function songsQuery(st: SongsState): string {
  const p = new URLSearchParams();
  writeCommon(p, st, "name");
  if (st.lyricsOnly) p.set("lyrics", "1");
  return done(p);
}

// ---- Favorites ----

export const defaultFavoritesState = (): FavoritesState => ({ q: "", show: "both", types: [], availableOnly: false, sort: "starred", dir: "desc" });

export function parseFavoritesSearch(search: string): FavoritesState {
  const p = new URLSearchParams(search);
  return {
    ...readCommon(p, FAV_SORTS, "starred"),
    show: pick(p.get("show"), FAV_SHOWS, "both"),
    types: (p.get("type") ?? "").split(",").filter((t): t is VideoType => (TYPES as readonly string[]).includes(t)),
    availableOnly: p.get("available") === "1",
  };
}

export function favoritesQuery(st: FavoritesState): string {
  const p = new URLSearchParams();
  if (st.show !== "both") p.set("show", st.show);
  if (st.types.length) p.set("type", st.types.join(","));
  if (st.availableOnly) p.set("available", "1");
  writeCommon(p, st, "starred");
  return done(p);
}

// ---- matching and ordering ----

/** Does any of the names contain the folded filter text? An empty filter matches everything. */
export function nameMatches(q: string, ...names: (string | null | undefined)[]): boolean {
  const want = foldQuery(q.trim());
  if (!want) return true;
  return names.some((n) => !!n && foldQuery(n).includes(want));
}

export const cmpText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/** Compare two values for a sort, `sign` applied; a missing value goes last in either direction. */
export function cmpNullsLast<T extends number | string>(a: T | null | undefined, b: T | null | undefined, sign: 1 | -1): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "string" && typeof b === "string") return sign * (a < b ? -1 : a > b ? 1 : 0);
  return sign * ((a as number) - (b as number));
}
