// Ported from the archive, src/lib/lyrics/markers.ts (the regex core; the React hooks and i18n labeller are left
// behind, a plain `label` function is passed in). A Marker is `<sup data-fn="N" class="footnote-ref">N</sup>`;
// one with no Footnote entry is orphaned.
import { stripHtml } from "./normalize";
import { escAttr, sanitizeLine } from "./sanitize";
import type { FootnoteEntry, LyricLine } from "./types";

export type MarkerCase = "orphan" | "no-text" | "with-text";

export interface MarkerContext {
  id: number;
  case: MarkerCase;
  /** The entry body, stripped and clipped to 60 chars. `""` unless `with-text`. */
  text: string;
}

export interface AugmentMarkersOptions {
  /** Id namespace, e.g. `fn`. */
  kind: string;
  /** Scope segment, e.g. `<versionId>-<script>`. */
  idPrefix: string;
  label: (ctx: MarkerContext) => string;
}

export function markerDomId(kind: string, idPrefix: string, id: number, occurrence: number): string {
  return `${kind}-marker-${idPrefix}-${id}-${occurrence}`;
}

export function footnoteDefDomId(kind: string, idPrefix: string, id: number): string {
  return `${kind}-def-${idPrefix}-${id}`;
}

/** Ids may repeat; the first entry wins so a Marker resolves deterministically. */
export function entriesById(footnotes: readonly FootnoteEntry[]): Map<number, FootnoteEntry> {
  const m = new Map<number, FootnoteEntry>();
  footnotes.forEach((f) => { if (!m.has(f.id)) m.set(f.id, f); });
  return m;
}

export function markerCaseFor(entry: FootnoteEntry | undefined): MarkerCase {
  if (!entry) return "orphan";
  return stripHtml(entry.text).trim() ? "with-text" : "no-text";
}

export const defaultMarkerLabel = ({ id, case: kase, text }: MarkerContext) =>
  kase === "orphan" ? `Footnote ${id} (missing)` : kase === "with-text" ? `Footnote ${id}: ${text}` : `Footnote ${id}`;

/**
 * Gives every Marker a unique DOM id and the a11y attributes, marks truly adjacent Markers (`data-adjacent`, so CSS
 * can draw the comma between them). The line is sanitized with the LINE profile first, which drops any payload stored
 * in the lyric HTML, ids and app classes included (WEB-14); the attributes this pass adds come after, from escaped
 * values, and a Marker keeps none of its stored attributes but its class.
 */
export function augmentMarkers(lines: readonly LyricLine[], footnotes: readonly FootnoteEntry[], { kind, idPrefix, label }: AugmentMarkersOptions): LyricLine[] {
  const byId = entriesById(footnotes);
  const occ = new Map<number, number>();
  return lines.map((line) => {
    if (line.isBlank) return { ...line };
    // sanitized first, so the stored HTML can carry no id and no app class (WEB-14), and the regex below sees the
    // sanitizer's regular `name="value"` attributes; what this pass adds is built from escaped values
    const clean = sanitizeLine(line.innerHTML);
    const inner = clean.replace(/<sup\b([^>]*)\bdata-fn="(\d+)"([^>]*)>([^<]*)<\/sup>/gi, (_full, pre: string, num: string, post: string, body: string) => {
      const id = parseInt(num, 10);
      const count = (occ.get(id) ?? 0) + 1;
      occ.set(id, count);
      const entry = byId.get(id);
      const kase = markerCaseFor(entry);
      const text = kase === "with-text" ? stripHtml(entry!.text).slice(0, 60) : "";
      const name = label({ id, case: kase, text });
      const orphanAttr = kase === "orphan" ? ' data-orphan="true"' : "";
      const describedBy = kase !== "orphan";
      // the stored attributes are dropped but its class: role, tabindex and the aria ones are this pass's to set
      const cls = /\bclass="([^"]*)"/.exec(pre + post);
      return `<sup${cls ? ` class="${cls[1]}"` : ""} data-fn="${id}" id="${escAttr(markerDomId(kind, idPrefix, id, count))}" role="doc-noteref" tabindex="0"${describedBy ? ` aria-describedby="${escAttr(footnoteDefDomId(kind, idPrefix, id))}"` : ""} aria-label="${escAttr(name)}"${orphanAttr}>${body}</sup>`;
    });
    const withAdjacency = inner.replace(/(<\/sup>)(<sup\b)([^>]*)(>)/gi, (full, close: string, supOpen: string, attrs: string, gt: string) =>
      /\bdata-fn=/.test(attrs) ? `${close}${supOpen}${attrs} data-adjacent="true"${gt}` : full,
    );
    return { ...line, innerHTML: withAdjacency };
  });
}
