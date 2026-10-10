// The Song matcher (docs/chapter-pipeline.md, spec 8). Pure: folds both sides, scores with Jaro-Winkler against every
// name of every candidate Song, applies the two tiers and the near-tie rule. The server supplies the candidate lists.
import { allSongNames, type SongNameSource } from "./songNames";
import { transliterate } from "./translit";

/** Accept at or above this among the Songs the Video's id links to through Performances. */
export const TIER_LINKED = 0.8;
/** Accept at or above this over the whole Mirror. */
export const TIER_MIRROR = 0.9;
/** The best must lead the runner-up Song by at least this much, else nothing is attached. */
export const NEAR_TIE = 0.05;

/**
 * NFKD, strip diacritics, casefold, Cyrillic -> Latin through the project's table, ŋ -> ng, x/kh folded together,
 * parentheticals and punctuation dropped, whitespace collapsed.
 */
export function foldForMatch(s: string): string {
  let t = s.replace(/\([^)]*\)|\[[^\]]*\]|（[^）]*）/gu, " ");
  t = transliterate(t).toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  t = t.replace(/[ŋñ]/g, "ng").replace(/ʼ|’|'/g, "");
  t = t.replace(/x/g, "kh");
  t = t.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return t;
}

/** Jaro-Winkler similarity in [0,1] (prefix scale 0.1, up to 4 characters, boost only above 0.7). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  const A = [...a];
  const B = [...b];
  if (!A.length || !B.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(A.length, B.length) / 2) - 1);
  const am = new Array<boolean>(A.length).fill(false);
  const bm = new Array<boolean>(B.length).fill(false);
  let matches = 0;
  for (let i = 0; i < A.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(B.length - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (bm[j] || A[i] !== B[j]) continue;
      am[i] = bm[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let trans = 0;
  for (let i = 0; i < A.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (A[i] !== B[k]) trans++;
    k++;
  }
  const m = matches;
  const jaro = (m / A.length + m / B.length + (m - trans / 2) / m) / 3;
  if (jaro <= 0.7) return jaro;
  let l = 0;
  while (l < 4 && l < A.length && l < B.length && A[l] === B[l]) l++;
  return jaro + l * 0.1 * (1 - jaro);
}

export interface MatcherSong extends SongNameSource {
  id: string;
}

export interface SongScore {
  songId: string;
  score: number;
  /** The name that scored. */
  name: string;
}

export interface MatchOutcome {
  /** The attached Song, or null. */
  songId: string | null;
  tier: "linked" | "mirror" | null;
  best: SongScore | null;
  runnerUp: SongScore | null;
  /** The title was empty after folding, so nothing was tried. */
  empty?: boolean;
  /** Best led the runner-up by less than NEAR_TIE inside the tier that accepted it. */
  nearTie: boolean;
  /** Best score seen overall (for the miss report). */
  verdict: "hit" | "near-tie" | "miss" | "empty";
}

export interface PreparedSong {
  id: string;
  names: { text: string; folded: string }[];
}

export function prepareSongs(songs: Iterable<MatcherSong>): PreparedSong[] {
  const out: PreparedSong[] = [];
  for (const s of songs) {
    const seen = new Set<string>();
    const names: PreparedSong["names"] = [];
    for (const n of allSongNames(s)) {
      const f = foldForMatch(n.text);
      if (!f || seen.has(f)) continue;
      seen.add(f);
      names.push({ text: n.text, folded: f });
    }
    out.push({ id: s.id, names });
  }
  return out;
}

/** Each Song's best score over its names, highest first. */
export function rank(titleFolded: string, songs: readonly PreparedSong[]): SongScore[] {
  const out: SongScore[] = [];
  for (const s of songs) {
    let best: SongScore | null = null;
    for (const n of s.names) {
      const sc = jaroWinkler(titleFolded, n.folded);
      if (!best || sc > best.score) best = { songId: s.id, score: sc, name: n.text };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score || (a.songId < b.songId ? -1 : 1));
}

/**
 * The two tiers. Linked Songs first: if the best of them reaches `linked`, the decision is made there (a near-tie among
 * them attaches nothing and does not fall through to the Mirror). Otherwise the whole Mirror at `mirror`.
 */
export function matchSong(
  title: string,
  linked: readonly PreparedSong[],
  mirror: readonly PreparedSong[],
  th: { linked: number; mirror: number; nearTie: number } = { linked: TIER_LINKED, mirror: TIER_MIRROR, nearTie: NEAR_TIE },
): MatchOutcome {
  const f = foldForMatch(title);
  if (!f) return { songId: null, tier: null, best: null, runnerUp: null, nearTie: false, empty: true, verdict: "empty" };
  const decide = (ranked: SongScore[], accept: number, tier: "linked" | "mirror"): MatchOutcome | null => {
    const best = ranked[0];
    if (!best || best.score < accept) return null;
    const runnerUp = ranked[1] ?? null;
    if (runnerUp && best.score - runnerUp.score < th.nearTie) return { songId: null, tier, best, runnerUp, nearTie: true, verdict: "near-tie" };
    return { songId: best.songId, tier, best, runnerUp, nearTie: false, verdict: "hit" };
  };
  const linkedRanked = rank(f, linked);
  const a = decide(linkedRanked, th.linked, "linked");
  if (a) return a;
  const mirrorRanked = rank(f, mirror);
  const b = decide(mirrorRanked, th.mirror, "mirror");
  if (b) return b;
  const top = mirrorRanked[0] ?? null;
  return { songId: null, tier: null, best: top, runnerUp: mirrorRanked[1] ?? null, nearTie: false, verdict: "miss" };
}
