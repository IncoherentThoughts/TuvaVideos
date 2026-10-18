// The companion's reads of edit history and Shelved edits (docs/sharing-spec.md §3.6, §4.7, §4.8, §7.4; ticket #147).
// History is Shared data the pull and `/api/cache/apply` deliver; the companion only reads it here. Shelved edits are
// this machine's (`shelved_edit`, §2.3): listed, and cleared one, one Video's, or all at once.
import type { Db } from "./db";
import { clearShelved, listShelved } from "./localCopy/meta";
import { decodeValue, showValue, type EditsPage, type HistoryEntry, type ShelvedItem } from "../shared/editHistory";

interface HistoryDbRow {
  id: string;
  video_id: string | null;
  video_title: string | null;
  target_type: string;
  target_id: string | null;
  editor_id: string | null;
  event_type: string;
  field_name: string | null;
  old_value: unknown;
  new_value: unknown;
  description: string | null;
  reverses: string | null;
  reversed_by: string | null;
  created_at: string;
}

const SELECT = `SELECT h.*, v.title AS video_title,
  (SELECT r.id FROM video_edit_history r WHERE r.reverses = h.id ORDER BY r.created_at DESC LIMIT 1) AS reversed_by
  FROM video_edit_history h LEFT JOIN videos v ON v.id = h.video_id`;

/** The rejection an undo of a rejection takes back, while the Local copy still holds it. */
function rejectionOf(db: Db, r: HistoryDbRow, oldValue: unknown): string | null {
  if (!r.video_id) return null;
  // old_value is a TEXT column: a number comes back as its text
  if (r.event_type === "chapter.rejected" && oldValue != null && Number.isFinite(Number(oldValue)))
    return (db.query("SELECT id FROM video_chapter_rejections WHERE video_id = ? AND start_s = ? ORDER BY created_at DESC LIMIT 1").get(r.video_id, Number(oldValue)) as { id: string } | null)?.id ?? null;
  if (r.event_type === "artist_link.rejected" && typeof oldValue === "string")
    return (db.query("SELECT id FROM video_artist_rejections WHERE video_id = ? AND (artist_id = ?2 OR proposed_artist_id = ?2) ORDER BY created_at DESC LIMIT 1").get(r.video_id, oldValue) as { id: string } | null)?.id ?? null;
  return null;
}

function entry(db: Db, r: HistoryDbRow): HistoryEntry {
  const oldValue = decodeValue(r.old_value);
  return {
    id: r.id, videoId: r.video_id, videoTitle: r.video_title, targetType: r.target_type, targetId: r.target_id, editorId: r.editor_id,
    eventType: r.event_type, fieldName: r.field_name, oldValue, newValue: decodeValue(r.new_value), description: r.description ?? r.event_type,
    reverses: r.reverses, reversedBy: r.reversed_by, rejectionId: rejectionOf(db, r, oldValue), createdAt: r.created_at,
  };
}

// one write's Edits share created_at; `id` keeps them in a stable order inside it
const ORDER = "ORDER BY h.created_at DESC, h.video_id, h.editor_id, h.id";

/** `GET /api/videos/:id/history`: the Video's Edits, newest first (the History tab, §4.8). */
export function videoHistory(db: Db, videoId: string): HistoryEntry[] {
  return (db.query(`${SELECT} WHERE h.video_id = ? ${ORDER}`).all(videoId) as HistoryDbRow[]).map((r) => entry(db, r));
}

export interface EditsQuery {
  editor?: string | null;
  /** Event-type prefixes, `|`-separated (`EVENT_FILTERS`). */
  type?: string | null;
  /** Only Edits older than this `created_at` (the next page). */
  before?: string | null;
  limit?: number;
}

/** `GET /api/edits?editor=&type=&before=&limit=`: the library-wide Edits view (§4.8), newest first. */
export function listEdits(db: Db, q: EditsQuery = {}): EditsPage {
  const where: string[] = [];
  const args: string[] = [];
  if (q.editor) (where.push("h.editor_id = ?"), args.push(q.editor));
  const prefixes = (q.type ?? "").split("|").map((s) => s.trim()).filter((s) => /^[a-z_]+\.?$/.test(s));
  if (prefixes.length) {
    where.push(`(${prefixes.map(() => "h.event_type LIKE ?").join(" OR ")})`);
    args.push(...prefixes.map((p) => `${p}%`));
  }
  if (q.before) (where.push("h.created_at < ?"), args.push(q.before));
  const limit = Math.max(1, Math.min(500, Math.floor(q.limit ?? 200)));
  const rows = db.query(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ${ORDER} LIMIT ${limit + 1}`).all(...args) as HistoryDbRow[];
  let page = rows.slice(0, limit);
  let next: string | null = null;
  if (rows.length > limit) {
    // never split one write across pages: the page ends before the write the cut fell in
    const cut = page[page.length - 1]!.created_at;
    const whole = page.filter((r) => r.created_at !== cut);
    page = whole.length ? whole : page;
    next = page[page.length - 1]!.created_at;
  }
  const editors = (db.query("SELECT DISTINCT editor_id FROM video_edit_history WHERE editor_id IS NOT NULL ORDER BY editor_id").all() as { editor_id: string }[]).map((r) => r.editor_id);
  return { entries: page.map((r) => entry(db, r)), editors, next };
}

// ---------------------------------------------------------------------------------------------------------------
// Shelved edits (§7.4)
// ---------------------------------------------------------------------------------------------------------------

/** `GET /api/shelved[?video=]`: the drawer's list, with the names of what each kept value points at. */
export function shelvedItems(db: Db, videoId?: string): ShelvedItem[] {
  const video = db.prepare("SELECT v.title, COALESCE(l.shared, 0) AS shared FROM videos v LEFT JOIN video_local l ON l.video_id = v.id WHERE v.id = ?");
  const song = db.prepare("SELECT name FROM song_all WHERE id = ?");
  const artist = db.prepare("SELECT name FROM artist_all WHERE id = ?");
  const name = (q: typeof song, id: unknown) => (typeof id === "string" ? ((q.get(id) as { name: string } | null)?.name ?? "an unknown row") : null);
  return listShelved(db, videoId).map((s) => {
    const v = video.get(s.videoId) as { title: string; shared: number } | null;
    const p = s.payload as Record<string, unknown> & { kind: ShelvedItem["kind"] };
    let summary: string;
    switch (p.kind) {
      case "title":
        summary = `Title: ${p.title}`;
        break;
      case "type":
        summary = `Type: ${p.type}`;
        break;
      case "song":
        summary = p.songId ? `Song: ${name(song, p.songId)}` : "No Song";
        break;
      case "artists":
        summary = `Artists: ${showValue((p.artistIds as string[]).map((id) => name(artist, id)))}`;
        break;
      case "chapter": {
        const t = Number(p.startS);
        summary = `Chapter at ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}${p.title ? ` “${p.title}”` : ""}${p.songId ? ` · ${name(song, p.songId)}` : ""}`;
        break;
      }
      default:
        summary = String((p as { kind: string }).kind);
    }
    const { kind, ...payload } = p;
    return { id: s.id, videoId: s.videoId, videoTitle: v?.title ?? "(gone)", shared: !!v?.shared, shelvedAt: s.shelvedAt, kind, payload, summary };
  });
}

/** One Shelved edit gone (after its copy back). Returns whether it was there. */
export function dropShelved(db: Db, id: number): boolean {
  return db.query("DELETE FROM shelved_edit WHERE id = ?").run(id).changes > 0;
}

export { clearShelved };
