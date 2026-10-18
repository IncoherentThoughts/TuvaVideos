// Ported from the Tuvan Lyrics Archive, src/lib/lyrics/types.ts (read side only). Vocabulary is CONTEXT.md's:
// a Script is one of the three renderings of a lyric, a Version carries all three and their Footnotes, a Marker is
// the inline reference to a Footnote.

export interface FootnoteEntry {
  /** 1-based, matches `<sup data-fn="N">`; need not be unique or dense. */
  id: number;
  /** Inline HTML. */
  text: string;
}

export type ScriptKey = "cyrillic" | "transliteration" | "translation";

/** One Script of a Version as the API sends it: sanitized HTML and sanitized Footnote bodies. */
export interface ScriptDto {
  html: string;
  footnotes: FootnoteEntry[];
}

export interface VersionDto {
  id: string;
  label: string;
  displayOrder: number;
  /** A Local Version: written here, not in the archive; editable and deletable. */
  local: boolean;
  /** A Proposed Version (a Video Editor's, sharing-spec §3.4): read-only here, marked Proposed. */
  proposed?: boolean;
  scripts: Record<ScriptKey, ScriptDto>;
}

/** POST /api/songs/:id/versions and PATCH /api/versions/:id: any key may be left out; a null Script clears it. */
export interface VersionInput {
  label?: string;
  scripts?: Partial<Record<ScriptKey, ScriptDto | null>>;
}

/** One `<p>` of a lyric. */
export interface LyricLine {
  innerHTML: string;
  isBlank: boolean;
}

/** A non-blank line inside a stanza, carrying its continuous line number. */
export interface StanzaLine {
  innerHTML: string;
  number: number;
}

export interface Stanza {
  lines: StanzaLine[];
}

/** Footnote integrity problems in one Script. */
export interface LyricsFieldIssues {
  /** Marker ids in the HTML with no matching entry. */
  orphanMarkers: number[];
  /** Entry ids with no Marker in the HTML. */
  orphanEntries: number[];
  /** Entry ids whose body is empty or whitespace. */
  emptyFootnotes: number[];
}
