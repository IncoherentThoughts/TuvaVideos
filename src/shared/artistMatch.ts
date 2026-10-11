// The Artist matcher (spec 2.3): Suggested Artists for a Video from its title (and the uploader name when the
// YouTube info is cached), the way the Song matcher suggests Songs. Pure: the server supplies the names.
//
// The title is cut into segments at the usual separators (" - ", "|", "/", "&", ",", "feat.", parentheses…); every
// window of 1–4 words in a segment is folded and scored with Jaro-Winkler against every folded name of every Artist.
// A window matches at >= TIER_ARTIST; a window two different Artists both match within NEAR_TIE of each other is
// dropped; a window longer than the name is never compared; overlapping windows in one segment go to the better
// score, then the longer window. Generic words of the field (tuva, khoomei, live…) match nothing on their own.
import { jaroWinkler, foldForMatch, NEAR_TIE } from "./songMatch";

/** Accept at or above this. Names are short, so the bar is the Song matcher's whole-Mirror tier. */
export const TIER_ARTIST = 0.9;
/** A one-word name needs a closer match: short strings pass Jaro-Winkler too easily. */
export const TIER_ONE_WORD = 0.92;
/** Each word of a window against its word of the name, when the words are aligned. */
export const TIER_WORD = 0.85;
/** Folded strings shorter than this (window or name) are never compared: too easy to hit by accident. */
export const MIN_LEN = 4;

/** Words that say "a group" in either script, dropped from both sides: "Alash Ensemble" and "группа Алаш" are Alash. */
const NOISE = new Set(["ensemble", "ansambl", "group", "gruppa", "band", "quartet", "trio", "duo", "the", "feat", "ft", "with", "and"]);
/** Generic words of the field: a window made only of these never matches, a name made only of these needs an exact match. */
const STOP = new Set(["tuva", "tuvan", "tyva", "tyvan", "hoomei", "hoomeizhi", "kargyraa", "sygyt", "throat", "singing", "singer", "music", "concert", "live", "festival", "solo", "song", "folk", "overtone", "mongolia", "mongolian", "altai"]);
const onlyStop = (w: string) => w.split(" ").every((x) => STOP.has(x));

/** foldForMatch, then kh -> h (Huun / Khuun, Khovalyg / Hovalyg) and the group words dropped. */
export function foldArtist(s: string): string {
  return foldForMatch(s)
    .replace(/kh/g, "h")
    .split(" ")
    .filter((w) => w && !NOISE.has(w))
    .join(" ");
}

/** Title segments: the pieces between separators, plus the contents of every parenthesis or bracket, plus the whole. */
export function titleSegments(title: string): string[] {
  const out: string[] = [];
  const inner = [...title.matchAll(/[(\[（【]([^)\]）】]*)[)\]）】]/gu)].map((m) => m[1]!);
  const body = title.replace(/[(\[（【][^)\]）】]*[)\]）】]/gu, " ");
  const parts = body.split(/\s+[-–—|/⧸｜_:×x&+,;·•]+\s+|[|/⧸｜&,;·•]+|\s+(?:feat\.?|ft\.?|with|и|и\s+ансамбль|vs\.?)\s+|#/iu);
  for (const p of [...parts, ...inner]) {
    const t = p.trim();
    if (t) out.push(t);
  }
  out.push(title);
  return out;
}

export interface ArtistCandidate<Id = number> {
  id: Id;
  /** Every name the Artist is known by (name, Latin name). */
  names: string[];
}

export interface ArtistMatch<Id = number> {
  id: Id;
  score: number;
  /** The title window that matched, for reports. */
  window: string;
}

/**
 * A window against one name, both folded and split into words. null when the shapes do not fit:
 * - a one-word name takes a one-word window with the same first letter, at least 3/4 of its length, at TIER_ONE_WORD;
 * - a window never has more words than the name ("alash 1999": the shorter window matches instead);
 * - a shorter window must have at least two words (a first name alone is not a match) and is aligned with the start or
 *   the end of the name ("kongar ol" ~ "kongar ool ondar", "ool sam" ~ "ayan ool sam");
 * - aligned words must each pass TIER_WORD ("hoomei v" is not "hoomei beat"), the whole passes `tier`.
 */
/** Levenshtein distance, for the short words Jaro-Winkler cannot judge ("ol" / "ool": its match window is 0 wide). */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}
const wordsAlike = (a: string, b: string) => jaroWinkler(a, b) >= TIER_WORD || (Math.min(a.length, b.length) <= 3 && editDistance(a, b) <= 1);

export function scoreWindow(ww: string[], window: string, nw: string[], name: string, tier: number): number | null {
  if (nw.length === 1) {
    if (ww.length !== 1 || window[0] !== name[0] || window.length < name.length * 0.75) return null;
    const j = jaroWinkler(window, name);
    return j >= TIER_ONE_WORD ? j : null;
  }
  if (ww.length > nw.length || ww.length < 2) return null;
  const aligned = (offset: number) => ww.every((w, i) => wordsAlike(w, nw[offset + i]!));
  if (!aligned(0) && !aligned(nw.length - ww.length)) return null;
  const target = ww.length === nw.length ? name : aligned(0) ? nw.slice(0, ww.length).join(" ") : nw.slice(nw.length - ww.length).join(" ");
  const j = jaroWinkler(window, target);
  // a partial window scores against its part of the name, capped just under a full match
  return j >= tier ? (ww.length === nw.length ? j : Math.min(j, 0.97)) : null;
}

interface Hit<Id> {
  id: Id;
  score: number;
  start: number;
  len: number;
  window: string;
}

/** Suggested Artists for one text, best first, each Artist once. `extra` texts (an uploader name) are segments too. */
export function matchArtists<Id>(title: string, candidates: ArtistCandidate<Id>[], extra: string[] = [], tier = TIER_ARTIST): ArtistMatch<Id>[] {
  const folded = candidates
    .map((c) => ({ id: c.id, names: [...new Set(c.names.map(foldArtist).filter((n) => n.length >= MIN_LEN))].map((n) => ({ n, words: n.split(" "), generic: onlyStop(n) })) }))
    .filter((c) => c.names.length);
  const best = new Map<Id, ArtistMatch<Id>>();
  for (const seg of [...titleSegments(title), ...extra]) {
    const words = foldArtist(seg).split(" ").filter(Boolean);
    const hits: Hit<Id>[] = [];
    for (let start = 0; start < words.length; start++) {
      for (let len = 1; len <= 4 && start + len <= words.length; len++) {
        const window = words.slice(start, start + len).join(" ");
        if (window.length < MIN_LEN || onlyStop(window)) continue;
        // the best Artist for this window, and the runner-up among the other Artists (the near-tie rule)
        let top: Hit<Id> | null = null;
        let second = 0;
        for (const c of folded) {
          let s = 0;
          for (const { n, words: nw, generic } of c.names) {
            const j = scoreWindow(words.slice(start, start + len), window, nw, n, tier);
            if (j === null || (generic && j < 1)) continue;
            s = Math.max(s, j);
          }
          if (s < tier) continue;
          if (!top || s > top.score) {
            if (top && top.id !== c.id) second = Math.max(second, top.score);
            top = { id: c.id, score: s, start, len, window };
          } else if (c.id !== top.id) second = Math.max(second, s);
        }
        if (top && top.score - second >= NEAR_TIE) hits.push(top);
      }
    }
    // overlapping windows: the better score wins, then the longer window
    hits.sort((a, b) => b.score - a.score || b.len - a.len || a.start - b.start);
    const taken: boolean[] = new Array(words.length).fill(false);
    for (const h of hits) {
      let free = true;
      for (let i = h.start; i < h.start + h.len; i++) if (taken[i]) free = false;
      if (!free) continue;
      for (let i = h.start; i < h.start + h.len; i++) taken[i] = true;
      const cur = best.get(h.id);
      if (!cur || h.score > cur.score) best.set(h.id, { id: h.id, score: h.score, window: h.window });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}
