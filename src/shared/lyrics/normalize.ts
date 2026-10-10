// Ported from the archive, src/lib/lyrics/normalize.ts: the read-path half (lines, stanzas, Marker order, integrity).
// The editor's renumbering, diffing and paste sanitizing are left behind: the Mirror is read-only.
import type { FootnoteEntry, LyricLine, LyricsFieldIssues, Stanza, StanzaLine } from "./types";

export function escapeHtml(text: string): string {
  return (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function stripHtml(s: string): string {
  return (s || "").replace(/<[^>]*>/g, "");
}

/**
 * HTML into a flat list of lines. Each `<p>` is one line; a `<p>` whose content is only a `<br>`, empty, or a lone
 * nbsp is a blank separator. HTML with no `<p>` at all is one line.
 */
export function parseHtmlToLines(html: string): LyricLine[] {
  if (!html) return [];
  const results: LyricLine[] = [];
  const re = /<p(?:[^>]*)>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const inner = m[1]!;
    const isBlank = inner === "<br>" || inner === "<br/>" || inner === "<br />" || inner === "" || inner === " " || inner === "&nbsp;" || inner.trim() === "<br>";
    results.push({ innerHTML: isBlank ? "" : inner, isBlank });
  }
  if (results.length === 0 && html.trim()) results.push({ innerHTML: html, isBlank: false });
  return results;
}

/**
 * Group lines into stanzas, delimited by runs of blank lines (leading and trailing blanks ignored). Line numbers are
 * continuous across stanzas: 1-based, counting only non-blank lines.
 */
export function groupLinesIntoStanzas(lines: readonly LyricLine[]): Stanza[] {
  const stanzas: Stanza[] = [];
  let current: StanzaLine[] = [];
  let number = 0;
  for (const line of lines) {
    if (line.isBlank) {
      if (current.length > 0) {
        stanzas.push({ lines: current });
        current = [];
      }
      continue;
    }
    number++;
    current.push({ innerHTML: line.innerHTML, number });
  }
  if (current.length > 0) stanzas.push({ lines: current });
  return stanzas;
}

/** Footnote ids as their Markers appear in the HTML (reading order). Duplicates are preserved. */
export function markersInReadingOrder(html: string): number[] {
  if (!html) return [];
  const out: number[] = [];
  const re = /<sup\b[^>]*\bdata-fn="(\d+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(parseInt(m[1]!, 10));
  return out;
}

/** Footnote integrity for one Script: orphaned Markers, unreferenced entries, empty bodies. */
export function validateLyricsField(html: string, footnotes: readonly FootnoteEntry[]): LyricsFieldIssues {
  const markerIds = new Set(markersInReadingOrder(html));
  const entryIds = new Set(footnotes.map((f) => f.id));
  const orphanMarkers: number[] = [];
  markerIds.forEach((id) => { if (!entryIds.has(id)) orphanMarkers.push(id); });
  const orphanEntries: number[] = [];
  entryIds.forEach((id) => { if (!markerIds.has(id)) orphanEntries.push(id); });
  const emptyFootnotes = [...new Set(footnotes.filter((f) => !stripHtml(f.text).trim()).map((f) => f.id))];
  return { orphanMarkers: orphanMarkers.sort((a, b) => a - b), orphanEntries: orphanEntries.sort((a, b) => a - b), emptyFootnotes };
}

/** Display lines for the drawer: a blank run is one spacer, numbers are continuous over the non-blank lines. */
export interface NumberedLine {
  blank: boolean;
  html: string;
  n: number;
}

export function numberedLines(html: string): NumberedLine[] {
  return numberLines(parseHtmlToLines(html));
}

export function numberLines(lines: readonly LyricLine[]): NumberedLine[] {
  const out: NumberedLine[] = [];
  let n = 0;
  let lastBlank = true; // leading blanks are dropped
  for (const l of lines) {
    if (l.isBlank) {
      if (!lastBlank) out.push({ blank: true, html: "", n: 0 });
      lastBlank = true;
      continue;
    }
    out.push({ blank: false, html: l.innerHTML, n: ++n });
    lastBlank = false;
  }
  while (out.length && out[out.length - 1]!.blank) out.pop();
  return out;
}
