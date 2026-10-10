// Ported from the archive, src/components/search/highlightSnippet.tsx, as a framework-free split into plain and
// matched parts (the archive returned React children). The search dropdown uses the app's folded highlighter
// (shared/fold.ts `highlightHtml`); this plain case-insensitive loop is the documented port.
export type SnippetPart = { text: string; match: boolean };

export function highlightSnippet(snippet: string, query: string): SnippetPart[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text: snippet, match: false }];
  const lower = snippet.toLowerCase();
  const parts: SnippetPart[] = [];
  let from = 0;
  let i = lower.indexOf(needle, from);
  while (i !== -1) {
    if (i > from) parts.push({ text: snippet.slice(from, i), match: false });
    parts.push({ text: snippet.slice(i, i + needle.length), match: true });
    from = i + needle.length;
    i = lower.indexOf(needle, from);
  }
  if (from < snippet.length) parts.push({ text: snippet.slice(from), match: false });
  return parts;
}
