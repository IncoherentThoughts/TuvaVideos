// The project's transliteration table (docs/data-model.md "Latin titles", spec 2.5). Pure.
// Case follows the source letter; a digraph is Capitalised after an upper-case source letter and lower-cased inside
// a word (Жаа -> Zhaa), and only upper-cased when the letter beside it is upper case too (ЖАА -> ZHAA).
// Й is J before a vowel (а е ё и о ө у ү ы э ю я) and I anywhere else; Ъ and Ь are dropped.

/** Lower-case rows of the table, in the order of data-model.md. Й is special-cased below. */
export const TRANSLIT: readonly (readonly [string, string])[] = [
  ["а", "a"], ["б", "b"], ["в", "v"], ["г", "g"], ["д", "d"], ["е", "e"], ["ё", "jo"], ["ж", "zh"], ["з", "z"], ["и", "i"],
  ["к", "k"], ["л", "l"], ["м", "m"], ["н", "n"], ["ң", "ŋ"], ["о", "o"], ["ө", "ö"], ["п", "p"], ["р", "r"], ["с", "s"],
  ["т", "t"], ["у", "u"], ["ү", "ü"], ["ф", "f"], ["х", "x"], ["ц", "ts"], ["ч", "ch"], ["ш", "sh"], ["щ", "sh"],
  ["ъ", ""], ["ы", "y"], ["ь", ""], ["э", "e"], ["ю", "ju"], ["я", "ja"],
];

const MAP = new Map<string, string>(TRANSLIT);
const VOWELS = new Set([..."аеёиоөуүыэюя"]);
const CYRILLIC = /[Ѐ-ӿ]/;

export const hasCyrillic = (s: string) => CYRILLIC.test(s);

const isUpper = (ch: string | undefined) => !!ch && ch !== ch.toLowerCase() && ch === ch.toUpperCase();

/** Cyrillic text to Latin through the table; everything that is not a Cyrillic letter passes through. */
export function transliterate(text: string): string {
  const chars = [...text];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const lc = ch.toLowerCase();
    let lat: string | undefined;
    if (lc === "й") lat = VOWELS.has((chars[i + 1] ?? "").toLowerCase()) ? "j" : "i";
    else lat = MAP.get(lc);
    if (lat === undefined) {
      out += ch;
      continue;
    }
    if (!isUpper(ch) || lat === "") out += lat;
    else if ([...lat].length === 1) out += lat.toUpperCase();
    else {
      const inCaps = isUpper(chars[i + 1]) || isUpper(chars[i - 1]);
      out += inCaps ? lat.toUpperCase() : lat[0]!.toUpperCase() + lat.slice(1);
    }
  }
  return out;
}

/** The Latin title of a title, or null when it holds no Cyrillic (already Latin: nothing to store). */
export function latinByTable(title: string): string | null {
  return hasCyrillic(title) ? transliterate(title) : null;
}
