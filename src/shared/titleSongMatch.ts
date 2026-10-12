// The Song matcher on Video titles (spec 2.3): a Suggested Song for a Video from its own title, the way the Artist
// matcher suggests Artists. Pure: the server supplies the Songs and the Artist names.
//
// The title is cut into segments at the usual separators and brackets (not at commas: "Aa-shuu, dekei-oo" is one
// name). In each segment the Artist names, the band names below and filler words ("live", "ensemble", "исп."…) are
// removed; what is left is matched window by window against every name of every Song, never across segments. A match
// must also cover the segment: at least half of what is left, or its start ("Alash live" is not "Alash-Xem"; "Ydyk
// yry, the anthem of…" is "Ydyk yry"). A one-word name needs the segment to be that word alone.
import { foldForMatch, jaroWinkler, type PreparedSong } from "./songMatch";

/** Accept at or above this. Higher than the whole-Mirror tier: a title holds far more than a Chapter title does. */
export const TIER_TITLE = 0.95;
/** A Song's English name must match (nearly) exactly: short English phrases are everywhere in titles. */
export const TIER_ENGLISH = 0.98;
/** A one-word name: almost exact. */
export const TIER_ONE_WORD = 0.97;
/** The best must lead the runner-up Song by this much, unless it covers more of the segment. */
export const NEAR_TIE_TITLE = 0.04;
/** Folded names shorter than this (spaces aside) are never matched from titles. */
export const MIN_NAME_LEN = 5;
/** A match must cover at least this share of its segment's remaining words, or start the segment. */
export const MIN_COVERAGE = 0.5;

/** Throat-singing styles that are also Song names: a title naming the style is a demonstration, not the Song. */
const STYLE_NAMES = ["kargyraa", "ezengileer", "sygyt", "xöömei", "borbangnadyr", "sygyt xöömei", "xöömei sygyt", "sygyt kargyraa", "dembildei", "dembildey"];
/** Bands named like a Song: removed from titles like Artist names, and never matched as the Song. */
const BAND_NAMES = ["alash", "ene-sai", "chirgilchin", "yat-kha", "huun-huur-tu"];
/** Words that say nothing about which Song it is. Folded at load, so either script can be listed. */
const FILLER = [
  "live", "performance", "performing", "performed", "perform", "ensemble", "band", "group", "feat", "ft", "with", "and", "by", "at", "in",
  "the", "of", "a", "official", "video", "audio", "lyrics", "hd", "hq", "4k", "cover", "version", "full", "album", "tuvan", "throat",
  "singing", "concert", "festival", "ансамбль", "группа", "исп", "песня", "тувинское", "горловое", "пение", "концерт", "фольклорный",
  "фольклорная", "и",
];

const fold = (xs: string[]) => new Set(xs.map(foldForMatch).filter(Boolean));
const STYLE = fold(STYLE_NAMES);
const FILL = fold(FILLER);
const BANDS = [...fold(BAND_NAMES)].map((b) => b.split(" "));

/** Segments of a title: the pieces between separators, plus the contents of every bracket. */
export function songSegments(title: string): string[] {
  const inner = [...title.matchAll(/[(\[（【«“"＂]([^)\]）】»”"＂]*)[)\]）】»”"＂]/gu)].map((m) => m[1]!);
  const body = title.replace(/[(\[（【«“"＂][^)\]）】»”"＂]*[)\]）】»”"＂]/gu, " ");
  const parts = body.split(/\s+[-–—_×x+]+\s+|[|/⧸｜&;·•:：.#]+|\s+(?:feat\.?|ft\.?|vs\.?)\s+/iu);
  return [...parts, ...inner].map((p) => p.trim()).filter(Boolean);
}

/** Removes every occurrence of each word sequence in `drop` from `words`. */
function without(words: string[], drop: string[][]): string[] {
  let out = words;
  for (const d of drop) {
    if (!d.length) continue;
    const next: string[] = [];
    for (let i = 0; i < out.length; ) {
      if (d.every((w, j) => out[i + j] === w)) i += d.length;
      else next.push(out[i++]!);
    }
    out = next;
  }
  return out;
}

export interface TitleSong extends PreparedSong {
  /** Folded English name, held to TIER_ENGLISH. */
  english?: string | null;
}

export interface TitleMatch {
  songId: string;
  score: number;
  /** The title words that matched, folded, for reports. */
  window: string;
  /** Words of the segment the window covered. */
  len: number;
}

/** Folds Artist names for `matchSongInTitle`, longest first (so "alash ensemble" goes before "alash"). */
export function prepareArtistNames(names: string[]): string[][] {
  return [...new Set(names.map(foldForMatch).filter((n) => n.length >= 4))].sort((a, b) => b.length - a.length).map((n) => n.split(" "));
}

/** The Suggested Song for a title, or null. `artists` from `prepareArtistNames`. */
export function matchSongInTitle(title: string, songs: readonly TitleSong[], artists: string[][] = []): TitleMatch | null {
  const best = new Map<string, TitleMatch>();
  for (const seg of songSegments(title)) {
    const words = without(foldForMatch(seg).split(" ").filter(Boolean), [...artists, ...BANDS]).filter((w) => !FILL.has(w) && !/^\d+$/.test(w));
    if (!words.length) continue;
    for (const s of songs) {
      for (const n of s.names) {
        if (n.folded.replace(/ /g, "").length < MIN_NAME_LEN || STYLE.has(n.folded) || BANDS.some((b) => b.join(" ") === n.folded)) continue;
        const nw = n.folded.split(" ");
        const english = !!s.english && s.english === n.folded;
        const sizes = nw.length === 1 ? [1] : english ? [nw.length] : [nw.length - 1, nw.length, nw.length + 1];
        for (const k of sizes) {
          if (k < 1 || k > words.length) continue;
          for (let i = 0; i + k <= words.length; i++) {
            const window = words.slice(i, i + k).join(" ");
            const sc = jaroWinkler(window, n.folded);
            if (sc < (english ? TIER_ENGLISH : nw.length === 1 ? TIER_ONE_WORD : TIER_TITLE)) continue;
            if (nw.length === 1 ? words.length !== k : k / words.length < MIN_COVERAGE && i !== 0) continue;
            const cur = best.get(s.id);
            if (!cur || sc > cur.score || (sc === cur.score && k > cur.len)) best.set(s.id, { songId: s.id, score: sc, window, len: k });
          }
        }
      }
    }
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score || b.len - a.len);
  const [top, second] = ranked;
  if (!top) return null;
  // near-tie: a runner-up as good that covers as much leaves nothing; one that covers less loses to the longer match
  if (second && top.score - second.score < NEAR_TIE_TITLE && second.len >= top.len) return null;
  return top;
}
