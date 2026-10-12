// Plain text <-> the Mirror's lyric HTML, for Local Versions written in the drawer's editor. One line of text is one
// `<p>`; an empty line is a stanza break (`<p class="ln-blank"><br></p>`, the archive's shape); `[3]` in a line is
// the Marker for Footnote 3 (`<sup data-fn="3">3</sup>`). Footnotes are typed one per line as `3: text` (or `3. text`).
// Round-trips through the reader's parser (normalize.ts), so an edited Local Version comes back as it was typed.
import type { FootnoteEntry } from "./types";
import { escapeHtml } from "./normalize";

const MARKER = /\[(\d{1,3})\]/g;

export function linesToHtml(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (!lines.length) return null;
  return lines
    .map((l) => (l.trim() ? `<p>${escapeHtml(l).replace(MARKER, (_, n: string) => `<sup data-fn="${Number(n)}">${Number(n)}</sup>`)}</p>` : '<p class="ln-blank"><br></p>'))
    .join("\n");
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const unescape = (s: string) => s.replace(/&(#?\w+);/g, (m, e: string) => ENT[e] ?? (/^#\d+$/.test(e) ? String.fromCodePoint(Number(e.slice(1))) : m));

/** The reverse: `<p>` per line, Markers back to `[n]`, every other tag stripped. */
export function htmlToPlain(html: string | null | undefined): string {
  if (!html) return "";
  const out: string[] = [];
  const re = /<p(?:[^>]*)>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(html)) !== null) {
    any = true;
    out.push(innerToPlain(m[1]!));
  }
  if (!any) return html.split(/<br\s*\/?>/i).map(innerToPlain).join("\n");
  return out.join("\n");
}

function innerToPlain(inner: string): string {
  return unescape(
    inner
      .replace(/<sup\b[^>]*\bdata-fn="(\d+)"[^>]*>[\s\S]*?<\/sup>/gi, (_, n: string) => `[${Number(n)}]`)
      .replace(/<br\s*\/?>/gi, "")
      .replace(/<[^>]*>/g, ""),
  ).replace(/ /g, " ").trimEnd();
}

/** `3: text` or `3. text` per line; a line that does not start with a number continues the previous entry. */
export function parseFootnotesText(text: string): FootnoteEntry[] {
  const out: FootnoteEntry[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d{1,3})\s*[:.)\]]\s*(.*)$/.exec(line);
    if (m) out.push({ id: Number(m[1]), text: escapeHtml(m[2]!) });
    else if (out.length) out[out.length - 1]!.text += ` ${escapeHtml(line)}`;
  }
  return out;
}

export function footnotesToText(entries: readonly FootnoteEntry[]): string {
  return entries.map((f) => `${f.id}: ${unescape(f.text.replace(/<[^>]*>/g, ""))}`).join("\n");
}
