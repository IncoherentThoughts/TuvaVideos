// Folding for search (spec 6.1/6.2, #12 prototype). Pure. Folds Cyrillic and Latin onto one ASCII form so a Latin
// query hits Cyrillic rows and the reverse: ŋ/ñ -> ng, ö/ü -> o/u, x and х -> kh. The index folds every row once;
// only the (short) query is folded per keystroke.

const TR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m",
  н: "n", ң: "ng", ҥ: "ng", о: "o", ө: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ү: "u", ф: "f", х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ŋ: "ng", ñ: "ng", x: "kh", ɨ: "y",
};

export interface Folded {
  /** The folded string. */
  f: string;
  /** For each char of `f`, the index in the original string it came from. */
  map: number[];
  /** Length of the original string. */
  len: number;
}

export function foldWithMap(s: string): Folded {
  const chars: string[] = [];
  const map: number[] = [];
  let i = 0;
  for (const ch of s) {
    const lc = ch.toLowerCase();
    let r = TR[lc];
    if (r === undefined) r = lc.normalize("NFKD").replace(/\p{M}/gu, "");
    if (r in TR && r !== lc) r = TR[r]!;
    for (const c of r) {
      chars.push(c);
      map.push(i);
    }
    i += ch.length;
  }
  return { f: chars.join(""), map, len: i };
}

/** The `text_folded` form of one string. `|` is reserved as the segment separator so it is folded to `/`. */
export function foldText(s: string): string {
  return foldWithMap(s).f.replace(/\|/g, "/");
}

export const SEGMENT_SEP = " | ";

/** `text_folded` of a row that has several names (title + Latin title, a Song's alternates): folded segments joined. */
export function foldSegments(parts: string[]): string {
  return parts.map((p) => foldText(p).replace(/\s+/g, " ").trim()).join(SEGMENT_SEP);
}

/** A query folded and whitespace-normalised. */
export function foldQuery(q: string): string {
  return foldText(q).replace(/\s+/g, " ").trim();
}

/** [start, end) ranges of `text` whose folded form contains `needle` (already folded). */
export function matchRanges(text: string, needle: string): [number, number][] {
  const out: [number, number][] = [];
  if (!needle) return out;
  const { f, map, len } = foldWithMap(text);
  let from = 0;
  while ((from = f.indexOf(needle, from)) >= 0) {
    const s = map[from]!;
    const e = from + needle.length < map.length ? map[from + needle.length]! : len;
    out.push([s, e]);
    from += needle.length;
  }
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Text with each match wrapped in <mark>, everything escaped. */
export function highlightHtml(text: string, needle: string): string {
  const ms = matchRanges(text, needle);
  if (!ms.length) return escapeHtml(text);
  let out = "";
  let p = 0;
  for (const [s, e] of ms) {
    out += escapeHtml(text.slice(p, s)) + "<mark>" + escapeHtml(text.slice(s, e)) + "</mark>";
    p = e;
  }
  return out + escapeHtml(text.slice(p));
}
