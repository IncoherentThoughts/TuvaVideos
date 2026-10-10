// Library grid filter/sort state and its URL form (spec 5.2). Pure.
//   /?type=song,concert&available=1&fav=1&artist=Radik_Tyulush&sort=title&dir=asc
import { foldQuery } from "./fold";
import { TYPES, type VideoType } from "./filters";
import type { VideoDto } from "./types";

export const SORTS = ["added", "title", "duration", "played"] as const;
export type SortKey = (typeof SORTS)[number];

export interface LibraryState {
  types: VideoType[];
  availableOnly: boolean;
  fav: boolean;
  /** Artist name, spaces (not underscores). */
  artist: string | null;
  sort: SortKey;
  dir: "asc" | "desc";
}

/** Natural direction of each sort: title A-Z, everything else biggest / newest first. */
export const defaultDir = (s: SortKey): "asc" | "desc" => (s === "title" ? "asc" : "desc");

export const defaultLibraryState = (): LibraryState => ({
  types: [], availableOnly: false, fav: false, artist: null, sort: "added", dir: "desc",
});

export function parseLibrarySearch(search: string): LibraryState {
  const p = new URLSearchParams(search);
  const st = defaultLibraryState();
  st.types = (p.get("type") ?? "").split(",").filter((t): t is VideoType => (TYPES as readonly string[]).includes(t));
  st.availableOnly = p.get("available") === "1";
  st.fav = p.get("fav") === "1";
  const artist = p.get("artist");
  st.artist = artist ? artist.replace(/_/g, " ") : null;
  const sort = p.get("sort");
  if (sort && (SORTS as readonly string[]).includes(sort)) st.sort = sort as SortKey;
  st.dir = defaultDir(st.sort);
  const dir = p.get("dir");
  if (dir === "asc" || dir === "desc") st.dir = dir;
  return st;
}

/** Query string (with leading `?`, or empty) holding only the non-default parts. */
export function libraryQuery(st: LibraryState): string {
  const p = new URLSearchParams();
  if (st.types.length) p.set("type", st.types.join(","));
  if (st.availableOnly) p.set("available", "1");
  if (st.fav) p.set("fav", "1");
  if (st.artist) p.set("artist", st.artist.replace(/ /g, "_"));
  if (st.sort !== "added") p.set("sort", st.sort);
  if (st.dir !== defaultDir(st.sort)) p.set("dir", st.dir);
  const s = p.toString().replace(/%2C/g, ",");
  return s ? `?${s}` : "";
}

const foldedNames = new WeakMap<object, string[]>();
function artistKeys(v: VideoDto): string[] {
  let k = foldedNames.get(v);
  if (!k) {
    k = v.artists.flatMap((a) => [foldQuery(a.name), ...(a.nameLatin ? [foldQuery(a.nameLatin)] : [])]);
    foldedNames.set(v, k);
  }
  return k;
}

/** Does the Video have an Artist whose folded name (or Latin name) equals the folded filter? */
export function hasArtistNamed(v: VideoDto, name: string): boolean {
  const want = foldQuery(name);
  return artistKeys(v).includes(want);
}

export function filterVideos(videos: VideoDto[], st: LibraryState): VideoDto[] {
  return videos.filter(
    (v) =>
      (!st.types.length || st.types.includes(v.type)) &&
      (!st.availableOnly || v.available) &&
      (!st.fav || !!v.favoritedAt) &&
      (!st.artist || hasArtistNamed(v, st.artist)),
  );
}

const cmpStr = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

export function sortVideos(videos: VideoDto[], st: LibraryState): VideoDto[] {
  const sign = st.dir === "asc" ? 1 : -1;
  const nullsLast = (a: number | string | null, b: number | string | null, cmp: (x: any, y: any) => number) => {
    if (a == null && b == null) return 0;
    if (a == null) return 1; // missing values go last in either direction
    if (b == null) return -1;
    return sign * cmp(a, b);
  };
  const out = [...videos];
  out.sort((x, y) => {
    let c = 0;
    if (st.sort === "title") c = sign * cmpStr(x.title, y.title);
    else if (st.sort === "duration") c = nullsLast(x.durationS, y.durationS, (a, b) => a - b);
    else if (st.sort === "played") c = nullsLast(x.lastPlayedAt, y.lastPlayedAt, (a, b) => (a < b ? -1 : a > b ? 1 : 0));
    else c = nullsLast(x.addedAt ?? x.createdAt, y.addedAt ?? y.createdAt, (a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return c || y.id - x.id;
  });
  return out;
}

export const viewVideos = (videos: VideoDto[], st: LibraryState) => sortVideos(filterVideos(videos, st), st);
