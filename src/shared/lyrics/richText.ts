// Ported from the archive, src/lib/lyrics/richText.ts. The storage-shape test for a Script: rich HTML or NULL
// (ADR-0003 there). Used here as an import-time assertion on the Mirror, never as a read-time branch.
export const RICH_TEXT_PATTERN = /<[a-zA-Z]/;

export function isRichText(text: string): boolean {
  return RICH_TEXT_PATTERN.test(text);
}
