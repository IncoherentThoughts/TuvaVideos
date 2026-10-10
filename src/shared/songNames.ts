// Every name a Mirror Song goes by, tagged with where it came from. Shared by the search index (one folded segment per
// name, so the scorer's +3 English / +4 alternate bonus applies), the Latin-title fill, GET /api/songs/:id and, later,
// the Song matcher (ticket #26). The archive stores `alternate_titles` and `alternate_spellings` as comma-separated
// strings (or, defensively, a JSON array); entries are split on commas and trimmed. A Song's own name is never split
// ("Aa-shuu, dekei-oo" is one name).
import { hasCyrillic } from "./translit";

export type SongNameKind = "name" | "english" | "alternate_title" | "alternate_spelling";

export interface SongName {
  text: string;
  kind: SongNameKind;
}

export interface SongNameSource {
  name: string;
  english_name?: string | null;
  alternate_titles?: string | null;
  alternate_spellings?: string | null;
}

/** Comma-separated alternates, or a JSON array. */
export function splitAlternates(v: string | null | undefined): string[] {
  if (!v) return [];
  const t = v.trim();
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.map(String).map((s) => s.trim()).filter(Boolean);
    } catch {}
  }
  return t.split(",").map((s) => s.trim()).filter(Boolean);
}

/** All names, deduplicated by exact text (first kind wins), in the order name, English, titles, spellings. */
export function allSongNames(s: SongNameSource): SongName[] {
  const out: SongName[] = [];
  const seen = new Set<string>();
  const add = (text: string | null | undefined, kind: SongNameKind) => {
    const t = (text ?? "").trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push({ text: t, kind });
  };
  add(s.name, "name");
  add(s.english_name, "english");
  for (const a of splitAlternates(s.alternate_titles)) add(a, "alternate_title");
  for (const a of splitAlternates(s.alternate_spellings)) add(a, "alternate_spelling");
  return out;
}

/** The names a Video or Chapter title could be written as in Cyrillic (the name itself when it is Cyrillic). */
export const cyrillicNames = (s: SongNameSource) => allSongNames(s).filter((n) => n.kind !== "english" && hasCyrillic(n.text));

/** The Song's Latin spelling for an `archive` Latin title: the Latin name field, else the first Latin alternate spelling, else title. */
export function latinSpelling(s: SongNameSource): string | null {
  if (!hasCyrillic(s.name)) return s.name;
  const names = allSongNames(s);
  return (names.find((n) => n.kind === "alternate_spelling" && !hasCyrillic(n.text)) ?? names.find((n) => n.kind === "alternate_title" && !hasCyrillic(n.text)))?.text ?? null;
}
