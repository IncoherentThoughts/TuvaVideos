// Edit history as the browser reads it (docs/sharing-spec.md §3.6, §4.7, §4.8, §7.4; ticket #147): the rows of
// `video_edit_history` in the Local copy as DTOs, grouped into the writes that made them, and the Shelved edits the
// drawer lists. Pure: the companion's reads are src/server/editHistory.ts, the inversion table is writeOps.ts.
import type { DiffRow } from "./shelvedDiff";

/** One `video_edit_history` row (`GET /api/videos/:id/history`, `GET /api/edits`). Values are decoded JSON. */
export interface HistoryEntry {
  id: string;
  videoId: string | null;
  /** The Video's title now (the Edits view lists many Videos); null when the Video is gone. */
  videoTitle: string | null;
  targetType: string;
  targetId: string | null;
  editorId: string | null;
  eventType: string;
  fieldName: string | null;
  oldValue: unknown;
  newValue: unknown;
  description: string;
  /** The row this one undoes (§4.7). */
  reverses: string | null;
  /** The newest row that undoes this one, if any. */
  reversedBy: string | null;
  /** For `chapter.rejected` / `artist_link.rejected`: the rejection row an undo unrejects, while it is still held. */
  rejectionId: string | null;
  createdAt: string;
}

/** `GET /api/edits`: a page of the library's history, newest first, and the filter choices. */
export interface EditsPage {
  entries: HistoryEntry[];
  editors: string[];
  /** `created_at` of the last entry when more are older (pass as `before`). */
  next: string | null;
}

/** A write as the archive made it: the Edits one call filed (same Video, editor and transaction time). */
export interface WriteGroup {
  key: string;
  videoId: string | null;
  videoTitle: string | null;
  editorId: string | null;
  createdAt: string;
  entries: HistoryEntry[];
}

/**
 * Groups history rows into writes, keeping the input's order (newest first). One call's Edits share the Video, the
 * editor and `created_at` (Postgres `now()` is the transaction's time), and arrive next to each other.
 */
export function groupWrites(entries: HistoryEntry[]): WriteGroup[] {
  const out: WriteGroup[] = [];
  for (const e of entries) {
    const key = `${e.videoId ?? ""}|${e.editorId ?? ""}|${e.createdAt}`;
    const last = out[out.length - 1];
    if (last && last.key === key) last.entries.push(e);
    else out.push({ key, videoId: e.videoId, videoTitle: e.videoTitle, editorId: e.editorId, createdAt: e.createdAt, entries: [e] });
  }
  return out;
}

/** Who made an Edit. The Local copy holds no editor names (§4.9's amendment), so: you, or another Video Editor. */
export const editorLabel = (editorId: string | null, me: string | null): string =>
  !editorId ? "Unknown editor" : me && editorId === me ? "You" : `Video Editor ${editorId.slice(0, 8)}`;

/** The event families the Edits view filters by (`type`). */
export const EVENT_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All edits" },
  { value: "video.", label: "Video" },
  { value: "chapter.", label: "Chapters" },
  { value: "artists.|artist_link.", label: "Artists" },
  { value: "proposed.", label: "Proposed rows" },
  { value: "exposure.", label: "Exposure" },
];

/** A stored value as a short string for the list. */
export function showValue(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" && "name" in x ? String((x as { name: unknown }).name) : showValue(x))).join(", ") || "—";
  if (typeof v === "object" && v && "title" in v) return String((v as { title: unknown }).title) || "untitled";
  return JSON.stringify(v);
}

/** A history value as SQLite holds it (strings raw, numbers as numbers, objects and arrays as JSON text) decoded. */
export function decodeValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? null;
  const t = raw.trimStart();
  if (t.startsWith("{") || t.startsWith("[") || t.startsWith('"')) {
    try {
      const v = JSON.parse(raw);
      return typeof v === "string" && v !== raw ? decodeValue(v) : v;
    } catch {}
  }
  return raw;
}

// ---------------------------------------------------------------------------------------------------------------
// Shelved edits (§2.3, §7.4)
// ---------------------------------------------------------------------------------------------------------------

/** One Shelved edit as the drawer lists it: the kept values, with the names of what they point at. */
export interface ShelvedItem {
  id: number;
  videoId: string;
  videoTitle: string;
  shared: boolean;
  shelvedAt: string;
  kind: "title" | "type" | "song" | "artists" | "chapter";
  /** The values, as `shelved_edit.payload` keeps them. */
  payload: Record<string, unknown>;
  /** One line: what this edit was. */
  summary: string;
  /** The kept value (red) against what the Video says now (green), #157. */
  diff: DiffRow;
}
