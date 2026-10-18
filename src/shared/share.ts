// The `pending_share` drain and its one question (docs/sharing-spec.md §4.3, §6.6; ticket #140), the pure parts: the
// question's trigger rules, the shape the companion hands the browser, the substitution of `local_*` pointers by the
// Proposed rows the drain creates first, and the drain itself over injected calls (src/web/sharing.ts binds them to
// supabase-js and the companion; the tests bind them to mocks).
import type { ArchiveError, EditInput, WriteResult, WriteVideosPayloads } from "./archiveWire";

// ---------------------------------------------------------------------------------------------------------------
// What the companion reports (GET /api/share, GET /api/share/pending)
// ---------------------------------------------------------------------------------------------------------------

/** The queue at a glance, for the question and the chip row. */
export interface PendingShareSummary {
  /** Videos in the queue. */
  count: number;
  /** Of those, how many have no YouTube id, Instagram shortcode or Rutube id (§6.6's question shows it). */
  noProvenance: number;
  /** The Roots their Copies live in, most Videos first. */
  folders: { path: string; count: number }[];
  /** `created_at` of the newest queued Video: a scan that added to the queue moves it. */
  newestAt: string | null;
  /** This machine answered "Share" once: later drains run without asking (§6.6). */
  auto: boolean;
}

/** A `local_*` row a queued Video points at: it becomes a Proposed row in the same drain, Song → Version → Artist. */
export interface LocalSongToPropose {
  id: string;
  create: { name: string; english_name: string | null; alternate_titles: string | null };
}
export interface LocalVersionToPropose {
  id: string;
  /** The parent: an archive Song id or a `local_*` Song id (resolved through the map). */
  songId: string;
  create: {
    label: string; lyrics_cyrillic: string | null; lyrics_transliteration: string | null; lyrics_translation: string | null;
    footnotes_cyrillic: unknown; footnotes_transliteration: unknown; footnotes_translation: unknown;
  };
}
export interface LocalArtistToPropose {
  id: string;
  create: { name: string };
}

export type InsertPayload = WriteVideosPayloads["insert"];

/** One queued Video: its `write_videos insert` payload with `local_*` ids still in the pointer fields. */
export interface PendingShareItem {
  videoId: string;
  insert: InsertPayload;
}

export interface PendingShareBatch {
  items: PendingShareItem[];
  locals: { songs: LocalSongToPropose[]; versions: LocalVersionToPropose[]; artists: LocalArtistToPropose[] };
}

// ---------------------------------------------------------------------------------------------------------------
// The question's trigger rules
// ---------------------------------------------------------------------------------------------------------------

/** When the browser considers the queue: a scan just finished, a Sync just succeeded, the chip row was clicked. */
export type ShareEvent = "scan-end" | "sync" | "open";

export interface ShareFacts {
  /** Edit controls are enabled (§5.3): a Video Editor's machine, this browser the record's user, online, settled. */
  canEdit: boolean;
  /** The last probe or Sync reached the archive. Never offline (§6.6). */
  online: boolean;
  /** A scan is running or queued. Never mid-scan (§6.6). */
  scanning: boolean;
  summary: Pick<PendingShareSummary, "count" | "newestAt" | "auto">;
}

export interface ShareMemory {
  /** This Sync is the first successful one since this browser signed in (the question rides on it, not on launches). */
  firstSyncAfterSignIn: boolean;
  /** `newestAt` when the question was last shown here (answered or declined); a scan asks again only for newer Videos. */
  askedNewestAt: string | null;
}

export type ShareStep = "none" | "ask" | "drain";

/**
 * §6.6's rule. Never offline, never mid-scan, nothing on a non-editor machine or with an empty queue. After one
 * "Share" every scan end and Sync drains without asking. Otherwise the question shows at the end of a scan that added
 * to the queue, right after the first Sync after a sign-in that finds the queue non-empty, and whenever the chip row
 * is clicked. A launch's Sync does not ask: the chip row stays for a declined queue.
 */
export function shareStep(event: ShareEvent, f: ShareFacts, m: ShareMemory): ShareStep {
  if (!f.canEdit || !f.online || f.scanning || f.summary.count <= 0) return "none";
  if (event === "open") return "ask";
  if (f.summary.auto) return "drain";
  if (event === "scan-end") return f.summary.newestAt != null && (m.askedNewestAt == null || f.summary.newestAt > m.askedNewestAt) ? "ask" : "none";
  return m.firstSyncAfterSignIn ? "ask" : "none";
}

/** "Share n new Videos from <folder>?" */
export function shareQuestionLine(s: Pick<PendingShareSummary, "count" | "folders">): string {
  const n = s.count;
  const what = n === 1 ? "1 new Video" : `${n} new Videos`;
  const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
  const from = s.folders.length === 1 ? ` from ${base(s.folders[0]!.path)}` : s.folders.length > 1 ? ` from ${s.folders.length} folders` : "";
  return `Share ${what}${from}?`;
}

/** The question's second line: how many have no YouTube id, Instagram shortcode or Rutube id. */
export function noProvenanceLine(s: Pick<PendingShareSummary, "count" | "noProvenance">): string | null {
  if (!s.noProvenance) return null;
  return s.noProvenance === s.count
    ? `${s.count === 1 ? "It has" : "None of them have"} a YouTube id, Instagram shortcode or Rutube id.`
    : `${s.noProvenance} of them have no YouTube id, Instagram shortcode or Rutube id.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Local pointers → Proposed rows
// ---------------------------------------------------------------------------------------------------------------

/** Where a `local_*` id ended up: a Proposed row this drain created, or an existing row the dedupe pointed at. */
export type Resolved = { kind: "proposed" | "archive"; id: string };
export type ResolvedMap = Map<string, Resolved>;

type PointerPair = { [k: string]: unknown };

/** Rewrites `<idKey>` / `<proposedKey>` when the id is a `local_*` one in the map; other values pass through. */
function swap(o: PointerPair, idKey: string, proposedKey: string, map: ResolvedMap) {
  const id = o[idKey];
  if (typeof id !== "string") return;
  const r = map.get(id);
  if (!r) return;
  if (r.kind === "proposed") {
    o[idKey] = null;
    o[proposedKey] = r.id;
  } else {
    o[idKey] = r.id;
    o[proposedKey] = null;
  }
}

/** The insert payload with every `local_*` pointer replaced (Video, Chapters, Artists). Pure; the input is untouched. */
export function resolveInsert(insert: InsertPayload, map: ResolvedMap): InsertPayload {
  const out = structuredClone(insert) as InsertPayload & PointerPair;
  swap(out, "song_id", "proposed_song_id", map);
  swap(out, "version_id", "proposed_version_id", map);
  for (const c of out.chapters ?? []) {
    swap(c as PointerPair, "song_id", "proposed_song_id", map);
    swap(c as PointerPair, "version_id", "proposed_version_id", map);
  }
  for (const a of out.artists ?? []) swap(a as PointerPair, "artist_id", "proposed_artist_id", map);
  return out;
}

/** Which `local_*` ids a batch's items still point at (only those become Proposed rows). */
export function localIdsUsed(batch: PendingShareBatch): Set<string> {
  const ids = new Set<string>();
  const add = (v: unknown) => typeof v === "string" && ids.add(v);
  for (const { insert } of batch.items) {
    add(insert.song_id);
    add(insert.version_id);
    for (const c of insert.chapters ?? []) {
      add(c.song_id);
      add(c.version_id);
    }
    for (const a of insert.artists ?? []) add(a.artist_id);
  }
  // A used Version's parent Song is used too.
  for (const v of batch.locals.versions) if (ids.has(v.id)) ids.add(v.songId);
  return ids;
}

// ---------------------------------------------------------------------------------------------------------------
// The drain
// ---------------------------------------------------------------------------------------------------------------

export type CallOutcome = { ok: true; value: WriteResult } | { ok: false; error: ArchiveError };

/** The calls the drain makes; each `write*` is one archive write function, `apply` is `POST /api/cache/apply`. */
export interface DrainDeps {
  newId(): string;
  createProposedSong(id: string, payload: LocalSongToPropose["create"], edits: EditInput[]): Promise<CallOutcome>;
  createProposedVersion(id: string, payload: LocalVersionToPropose["create"] & { song_id: string | null; proposed_song_id: string | null }, edits: EditInput[]): Promise<CallOutcome>;
  createProposedArtist(id: string, payload: LocalArtistToPropose["create"], edits: EditInput[]): Promise<CallOutcome>;
  insertVideo(id: string, payload: InsertPayload, edits: EditInput[]): Promise<CallOutcome>;
  apply(result: WriteResult): Promise<boolean>;
}

export interface DrainResult {
  shared: number;
  failed: number;
  proposed: number;
  /** A `local_*` row folded into an existing archive or Proposed row by the dedupe. */
  deduped: number;
  /** One line per failure, for the log and the chip's error line. */
  errors: string[];
}

/** The first candidate of a `duplicate-candidate` refusal, archive rows first. */
function dedupeTarget(e: ArchiveError): Resolved | null {
  if (e.word !== "duplicate-candidate" || !Array.isArray(e.detail) || !e.detail.length) return null;
  const c = e.detail.find((d) => d.kind === "archive") ?? e.detail[0]!;
  return { kind: c.kind === "archive" ? "archive" : "proposed", id: c.id };
}

const why = (e: ArchiveError) => e.word + (e.message ? `: ${e.message}` : "");

/**
 * Shares the queued Videos (§6.6): the Proposed rows they need first (Song → Version → Artist, §4.3), each applied to
 * the Local copy as it returns, then one `write_videos insert` per Video with its defaults and Chapters, applied too
 * (the apply clears `pending_share`). A failed Video stays queued; a failed Proposed row leaves its Videos queued.
 */
export async function drainPendingShare(batch: PendingShareBatch, d: DrainDeps): Promise<DrainResult> {
  const out: DrainResult = { shared: 0, failed: 0, proposed: 0, deduped: 0, errors: [] };
  const used = localIdsUsed(batch);
  const map: ResolvedMap = new Map();
  const broken = new Set<string>();
  const settle = async (localId: string, r: CallOutcome, id: string, what: string) => {
    if (r.ok) {
      if (!(await d.apply(r.value))) {
        broken.add(localId);
        out.errors.push(`${what}: the Local copy refused the result`);
        return;
      }
      map.set(localId, { kind: "proposed", id });
      out.proposed++;
      return;
    }
    const hit = dedupeTarget(r.error);
    if (hit) {
      map.set(localId, hit);
      out.deduped++;
      return;
    }
    broken.add(localId);
    out.errors.push(`${what}: ${why(r.error)}`);
  };
  for (const s of batch.locals.songs) {
    if (!used.has(s.id)) continue;
    const id = d.newId();
    await settle(s.id, await d.createProposedSong(id, s.create, [{ event_type: "proposed.song_created", new_value: s.create.name, description: `Proposed Song "${s.create.name}" (shared from a scan)` }]), id, `Proposed Song "${s.create.name}"`);
  }
  for (const v of batch.locals.versions) {
    if (!used.has(v.id)) continue;
    if (broken.has(v.songId)) {
      broken.add(v.id);
      continue;
    }
    const parent = map.get(v.songId) ?? { kind: "archive" as const, id: v.songId };
    const id = d.newId();
    const payload = { ...v.create, song_id: parent.kind === "archive" ? parent.id : null, proposed_song_id: parent.kind === "proposed" ? parent.id : null };
    await settle(v.id, await d.createProposedVersion(id, payload, [{ event_type: "proposed.version_created", new_value: v.create.label, description: `Proposed Version "${v.create.label}" (shared from a scan)` }]), id, `Proposed Version "${v.create.label}"`);
  }
  for (const a of batch.locals.artists) {
    if (!used.has(a.id)) continue;
    const id = d.newId();
    await settle(a.id, await d.createProposedArtist(id, a.create, [{ event_type: "proposed.artist_created", new_value: a.create.name, description: `Proposed Artist "${a.create.name}" (shared from a scan)` }]), id, `Proposed Artist "${a.create.name}"`);
  }
  for (const item of batch.items) {
    const needs = localIdsUsed({ items: [item], locals: batch.locals });
    if ([...needs].some((id) => broken.has(id))) {
      out.failed++;
      out.errors.push(`Video ${item.videoId}: a Proposed row it needs could not be created`);
      continue;
    }
    const r = await d.insertVideo(item.videoId, resolveInsert(item.insert, map), [{ event_type: "video.scanned", description: "Scanned and shared" }]);
    if (!r.ok) {
      out.failed++;
      out.errors.push(`Video ${item.videoId}: ${why(r.error)}`);
      continue;
    }
    if (await d.apply(r.value)) out.shared++;
    else {
      out.failed++;
      out.errors.push(`Video ${item.videoId}: the Local copy refused the result`);
    }
  }
  return out;
}
