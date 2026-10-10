// The #12 scorer (spec 6.2). Pure. Lower is better.
//   exact 0 / prefix 1 / word-start 1.5 / contains 2, +3 for a match on an English title, +4 on an alternate title
//   or spelling, lyrics-only 5. Lyrics are searched only from 3 characters.
import { SEGMENT_SEP } from "./fold";

export const LYRICS_ONLY_SCORE = 5;
export const LYRICS_MIN_CHARS = 3;
export const ENGLISH_PENALTY = 3;
export const ALTERNATE_PENALTY = 4;

/** Score of one folded string against a folded needle; null when it does not contain it. */
export function scoreFolded(text: string, needle: string): number | null {
  if (!needle) return null;
  if (text === needle) return 0;
  if (text.startsWith(needle)) return 1;
  const i = text.indexOf(needle);
  if (i < 0) return null;
  return i > 0 && /[\s\-'’"(/]/.test(text[i - 1]!) ? 1.5 : 2;
}

/** Penalty by segment position for a Song row: name 0, English name +3, alternates +4. Other kinds: 0. */
export const songPenalty = (i: number) => (i === 0 ? 0 : i === 1 ? ENGLISH_PENALTY : ALTERNATE_PENALTY);
export const noPenalty = () => 0;

/** Best score over the ` | `-separated segments of a `text_folded` value. */
export function scoreSegments(textFolded: string, needle: string, penalty: (segment: number) => number = noPenalty): number | null {
  let best: number | null = null;
  const segs = textFolded.split(SEGMENT_SEP);
  for (let i = 0; i < segs.length; i++) {
    const s = scoreFolded(segs[i]!, needle);
    if (s === null) continue;
    const adj = s + penalty(i);
    if (best === null || adj < best) best = adj;
  }
  return best;
}

export const lyricsSearchable = (needle: string) => needle.length >= LYRICS_MIN_CHARS;
