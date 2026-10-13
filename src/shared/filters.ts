// Typed filters in the search box (spec 5.2, 6.2). Pure.
//   #songs #videos #artists #tracks #albums   restrict the dropdown groups
//   #lyrics                                    match lyric text only
//   #available #fav #type:<t> #artist:<Name_With_Underscores>
// Any unknown #word stays in the search text.

export const GROUPS = ["songs", "videos", "artists", "tracks", "albums"] as const;
export type Group = (typeof GROUPS)[number];
export const TYPES = ["song", "concert", "interview", "other"] as const;
export type VideoType = (typeof TYPES)[number];

const GROUP_WORDS: Record<string, Group> = {
  song: "songs", songs: "songs", video: "videos", videos: "videos", artist: "artists", artists: "artists",
  track: "tracks", tracks: "tracks", album: "albums", albums: "albums",
};

export interface ParsedQuery {
  /** The search text with every recognised filter removed. */
  text: string;
  /** Groups named by the user (empty = not restricted). */
  groups: Group[];
  lyricsOnly: boolean;
  available: boolean;
  fav: boolean;
  types: VideoType[];
  /** Artist names with underscores turned back into spaces. */
  artists: string[];
}

export interface FilterChip {
  /** The token as typed, e.g. `#type:concert`. */
  token: string;
  label: string;
}

export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { text: "", groups: [], lyricsOnly: false, available: false, fav: false, types: [], artists: [] };
  const words: string[] = [];
  for (const w of q.split(/\s+/)) {
    if (!w) continue;
    if (w[0] !== "#") {
      words.push(w);
      continue;
    }
    const body = w.slice(1);
    const lower = body.toLowerCase();
    const colon = body.indexOf(":");
    if (colon > 0) {
      const key = lower.slice(0, colon);
      const val = body.slice(colon + 1);
      if (key === "type" && (TYPES as readonly string[]).includes(val.toLowerCase())) {
        const t = val.toLowerCase() as VideoType;
        if (!out.types.includes(t)) out.types.push(t);
        continue;
      }
      if (key === "artist" && val) {
        out.artists.push(val.replace(/_/g, " "));
        continue;
      }
      words.push(w);
      continue;
    }
    if (GROUP_WORDS[lower]) {
      const g = GROUP_WORDS[lower]!;
      if (!out.groups.includes(g)) out.groups.push(g);
    } else if (lower === "lyrics" || lower === "lyric") out.lyricsOnly = true;
    else if (lower === "available") out.available = true;
    else if (lower === "fav" || lower === "favorite" || lower === "favorites") out.fav = true;
    else words.push(w);
  }
  out.text = words.join(" ");
  return out;
}

/** Filters that narrow Videos (and Chapters) rather than choosing groups. */
export const hasVideoFilters = (p: ParsedQuery) => p.available || p.fav || p.types.length > 0 || p.artists.length > 0;
export const hasAnyFilter = (p: ParsedQuery) => hasVideoFilters(p) || p.groups.length > 0 || p.lyricsOnly;
/** A query made only of filters (no search text). */
export const isFilterOnly = (p: ParsedQuery) => p.text.trim() === "" && hasAnyFilter(p);

/** Groups the dropdown shows: those typed; else Songs for #lyrics; else Videos alone when only Video filters are present; else all. */
export function effectiveGroups(p: ParsedQuery): Group[] {
  if (p.groups.length) return GROUPS.filter((g) => p.groups.includes(g));
  if (p.lyricsOnly) return ["songs"];
  if (hasVideoFilters(p)) return ["videos"];
  return [...GROUPS];
}

export function filterChips(p: ParsedQuery): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const g of p.groups) chips.push({ token: `#${g}`, label: `#${g}` });
  if (p.lyricsOnly) chips.push({ token: "#lyrics", label: "#lyrics" });
  if (p.available) chips.push({ token: "#available", label: "#available" });
  if (p.fav) chips.push({ token: "#fav", label: "#fav" });
  for (const t of p.types) chips.push({ token: `#type:${t}`, label: `#type:${t}` });
  for (const a of p.artists) chips.push({ token: `#artist:${a.replace(/ /g, "_")}`, label: `#artist:${a}` });
  return chips;
}

/** Row cap per group: 8, or 40 when the user filtered (spec 6.2). */
export const rowCap = (p: ParsedQuery) => (p.groups.length || p.lyricsOnly || hasVideoFilters(p) ? 40 : 8);

/** A single word the parser takes as a filter (it leaves no search text behind): shown as a pill in the search box. */
export const isFilterToken = (w: string) => w.startsWith("#") && !/\s/.test(w) && isFilterOnly(parseQuery(w));

/** Colour slot (1-8, the tag palette) of a filter pill: Groups use their result colours, Types their tag colours. */
export function filterSlot(token: string): number {
  const p = parseQuery(token);
  const GROUP_SLOT: Record<Group, number> = { songs: 1, videos: 3, artists: 5, tracks: 6, albums: 7 };
  const TYPE_SLOT: Record<VideoType, number> = { song: 1, concert: 3, interview: 5, other: 8 };
  if (p.groups[0]) return GROUP_SLOT[p.groups[0]];
  if (p.types[0]) return TYPE_SLOT[p.types[0]];
  if (p.lyricsOnly) return 7;
  if (p.available) return 4;
  if (p.fav) return 2;
  return 6; // #artist:… (the box colours it by the Artist's own slot)
}
