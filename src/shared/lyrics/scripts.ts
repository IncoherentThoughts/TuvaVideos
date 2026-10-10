// Ported from the Tuvan Lyrics Archive, src/lib/lyrics/scripts.ts. The i18n label keys and the edit-history event
// type are gone (the Mirror is read-only); the columns are the Mirror's names (`cyrillic`, not `lyrics_cyrillic`).
import type { FootnoteEntry, ScriptKey } from "./types";

export interface ScriptDef {
  key: ScriptKey;
  /** `mirror_version` text column. */
  column: ScriptKey;
  /** `mirror_version` Footnote column. */
  footnoteColumn: "footnotes_cyrillic" | "footnotes_transliteration" | "footnotes_translation";
  /** BCP-47: `tyv` is Tuvan (no two-letter code), `tyv-Latn` the same in Latin script. */
  lang: string;
  /** Segmented-control label. */
  label: string;
}

/** Reading order, and the order every switcher renders in. */
export const SCRIPTS: readonly ScriptDef[] = [
  { key: "cyrillic", column: "cyrillic", footnoteColumn: "footnotes_cyrillic", lang: "tyv", label: "Cyrillic" },
  { key: "transliteration", column: "transliteration", footnoteColumn: "footnotes_transliteration", lang: "tyv-Latn", label: "Latin" },
  { key: "translation", column: "translation", footnoteColumn: "footnotes_translation", lang: "en", label: "English" },
] as const;

export const SCRIPT_KEYS: readonly ScriptKey[] = SCRIPTS.map((s) => s.key);

export const LYRICS_LANG: Record<ScriptKey, string> = Object.fromEntries(SCRIPTS.map((s) => [s.key, s.lang])) as Record<ScriptKey, string>;

export function scriptDef(key: ScriptKey): ScriptDef {
  const d = SCRIPTS.find((s) => s.key === key);
  if (!d) throw new Error(`unknown script: ${key}`);
  return d;
}

/** Anything with the three Script texts (a `mirror_version` row, or a flattened `VersionDto`). */
export type ScriptTexts = Partial<Record<ScriptKey, string | null>>;

export function scriptText(v: ScriptTexts | null | undefined, key: ScriptKey): string {
  return v?.[key] ?? "";
}

/** The Scripts a Version carries, in reading order. `.trim()`, not truthiness: a whitespace-only column is empty. */
export function presentScripts(v: ScriptTexts | null | undefined): ScriptKey[] {
  return SCRIPTS.filter((s) => scriptText(v, s.key).trim() !== "").map((s) => s.key);
}

/**
 * Clamp a preferred Script to one the shown Version has. Pure and derived, so switching Version re-clamps by itself.
 * Falls back to the first present Script, and to `cyrillic` only when the Version carries nothing.
 */
export function effectiveScript(preferred: ScriptKey, present: readonly ScriptKey[]): ScriptKey {
  return present.includes(preferred) ? preferred : (present[0] ?? "cyrillic");
}

/** Parses a stored footnote column (JSON text) into entries, dropping anything that is not `{id:number,text:string}`. */
export function parseFootnotes(json: unknown): FootnoteEntry[] {
  let v: unknown = json;
  if (typeof json === "string") {
    try {
      v = JSON.parse(json);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is { id: unknown; text: unknown } => !!e && typeof e === "object")
    .map((e) => ({ id: Number(e.id), text: typeof e.text === "string" ? e.text : "" }))
    .filter((e) => Number.isInteger(e.id));
}
