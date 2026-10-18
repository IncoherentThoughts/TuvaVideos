// The pure half of the client write seam (docs/sharing-spec.md §4.1–§4.3, §4.5, §4.9; ticket #145): which way a write
// of link data goes (`routeFor`), the companion route an Unshared or Standalone Video's write takes (`localRequest`),
// the archive function, payload, stamp and Edits a Shared Video's write becomes (`archiveCall`), the human line for
// every wire word (`writeErrorLine`) and the conflict notice's reducer (`conflictReducer`). No I/O: src/web/writeLink.ts
// does the calls.
import type { ArchiveError, ConflictDetail, EditInput, WriteFunction } from "../shared/archiveWire";
import type { VideoType } from "../shared/filters";
import { latinByTable } from "../shared/translit";
import type { HistoryEntry } from "../shared/editHistory";
import type { ChapterCreate, ChapterDto, ChapterPatch, VideoDto, VideoPatch } from "../shared/types";

// ---------------------------------------------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------------------------------------------

/** What a write needs of the Video: its id, whether it is Shared, its stamp, and the current values the Edits quote. */
export type LinkVideo = Pick<VideoDto, "id" | "shared" | "updatedAt"> &
  Partial<Pick<VideoDto, "title" | "titleLatin" | "titleLatinSource" | "type" | "typeSuggested" | "songId" | "versionId" | "songSuggested" | "artists">>;

/** What a write needs of a Chapter. */
export type LinkChapter = Pick<ChapterDto, "id" | "videoId" | "startS" | "title" | "suggested" | "updatedAt"> & Partial<Pick<ChapterDto, "songId" | "versionId">>;

/** A matcher's Suggested values for a Shared Video (§4.3): written only where nothing was set. */
export interface SuggestPatch {
  type?: VideoType;
  songId?: string;
  source: "performance" | "title";
}

/** Every write of link data the UI makes. `video.delete` / `video.restore` / `video.suggest` exist for Shared Videos only. */
export type LinkOp =
  | { kind: "video.update"; patch: VideoPatch }
  | { kind: "video.delete"; reason: string }
  | { kind: "video.restore" }
  | { kind: "video.suggest"; patch: SuggestPatch }
  | { kind: "artists.set"; artistIds: string[] }
  | { kind: "artists.remove"; artistId: string }
  | { kind: "artists.confirm" }
  | { kind: "chapter.add"; chapter: ChapterCreate }
  | { kind: "chapter.update"; chapter: LinkChapter; patch: ChapterPatch }
  | { kind: "chapter.delete"; chapter: LinkChapter }
  | { kind: "chapter.confirm"; chapter: LinkChapter }
  | { kind: "chapter.reject"; chapter: LinkChapter }
  | { kind: "chapters.confirmAll" }
  // undo only (§4.7): a rejection taken back, by the rejection row's id
  | { kind: "chapter.unreject"; rejectionId: string }
  | { kind: "artists.unreject"; rejectionId: string };

export type LinkOpKind = LinkOp["kind"];

/** The machine's mode, as the companion's Session record gives it (`machineMode`). */
export type WriteMode = "standalone" | "no-grant" | "member" | "editor";

// ---------------------------------------------------------------------------------------------------------------
// Routing (§4.9)
// ---------------------------------------------------------------------------------------------------------------

export const READ_ONLY_LINE = "Shared Videos are edited by Video Editors; this machine is signed in without that access.";
export const SHARED_ONLY_LINE = "Only a Shared Video is deleted or restored through the archive; this one is deleted from this machine.";

export const UNDO_SHARED_LINE = "Undo works on Shared Videos' edit history; this Video is edited on this machine only.";

export type Route = { to: "archive" } | { to: "local" } | { to: "refused"; line: string };

/** A Shared Video on a Video Editor's machine goes to the archive; an Unshared or Standalone one to the companion. */
export function routeFor(video: Pick<LinkVideo, "shared">, op: Pick<LinkOp, "kind">, mode: WriteMode): Route {
  if (video.shared) return mode === "editor" ? { to: "archive" } : { to: "refused", line: READ_ONLY_LINE };
  if (op.kind === "video.delete" || op.kind === "video.restore" || op.kind === "video.suggest") return { to: "refused", line: SHARED_ONLY_LINE };
  if (op.kind === "chapter.unreject" || op.kind === "artists.unreject") return { to: "refused", line: UNDO_SHARED_LINE };
  return { to: "local" };
}

// ---------------------------------------------------------------------------------------------------------------
// The companion's routes (Unshared, Standalone): unchanged
// ---------------------------------------------------------------------------------------------------------------

export interface LocalRequest {
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  body?: unknown;
}

export function localRequest(video: Pick<LinkVideo, "id">, op: LinkOp): LocalRequest | null {
  const v = `/api/videos/${video.id}`;
  switch (op.kind) {
    case "video.update":
      return { method: "PATCH", url: v, body: op.patch };
    case "artists.set":
      return { method: "PUT", url: `${v}/artists`, body: { artistIds: op.artistIds } };
    case "artists.remove":
      return { method: "DELETE", url: `${v}/artists/${op.artistId}` };
    case "artists.confirm":
      return { method: "POST", url: `${v}/artists/confirm` };
    case "chapter.add":
      return { method: "POST", url: `${v}/chapters`, body: op.chapter };
    case "chapter.update":
      return { method: "PATCH", url: `/api/chapters/${op.chapter.id}`, body: op.patch };
    case "chapter.delete":
      return { method: "DELETE", url: `/api/chapters/${op.chapter.id}` };
    case "chapter.confirm":
      return { method: "POST", url: `/api/chapters/${op.chapter.id}/confirm` };
    case "chapter.reject":
      return { method: "POST", url: `/api/chapters/${op.chapter.id}/reject` };
    case "chapters.confirmAll":
      return { method: "POST", url: `${v}/chapters/confirm-all` };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The archive call (Shared, on a Video Editor's machine)
// ---------------------------------------------------------------------------------------------------------------

export type RowKind = "archive" | "proposed" | "local";

/** Which effective ids are archive, Proposed or Local rows (`GET /api/kinds`); a missing id is a dangling archive uuid. */
export interface Kinds {
  songs: Record<string, RowKind>;
  versions: Record<string, RowKind>;
  artists: Record<string, RowKind>;
}
export const NO_KINDS: Kinds = { songs: {}, versions: {}, artists: {} };

/** The ids `archiveCall` needs the kinds of. */
export function kindsNeeded(video: LinkVideo, op: LinkOp): { songs: string[]; versions: string[]; artists: string[] } {
  const songs: string[] = [];
  const versions: string[] = [];
  const artists: string[] = [];
  const sv = (p: { songId?: string | null; versionId?: string | null }) => {
    if (p.songId) songs.push(p.songId);
    if (p.versionId) versions.push(p.versionId);
  };
  switch (op.kind) {
    case "video.update":
      if ("songId" in op.patch || "versionId" in op.patch) sv({ songId: "songId" in op.patch ? op.patch.songId : video.songId, versionId: op.patch.versionId });
      break;
    case "video.suggest":
      sv(op.patch);
      break;
    case "artists.set":
      artists.push(...op.artistIds);
      break;
    case "artists.remove":
      artists.push(...(video.artists ?? []).map((a) => a.id));
      break;
    case "chapter.add":
      sv(op.chapter);
      break;
    case "chapter.update":
      if ("songId" in op.patch || "versionId" in op.patch) sv({ songId: "songId" in op.patch ? op.patch.songId : op.chapter.songId, versionId: op.patch.versionId });
      break;
  }
  const uniq = (a: string[]) => [...new Set(a)];
  return { songs: uniq(songs), versions: uniq(versions), artists: uniq(artists) };
}

/** `archiveCall`'s answer when the op changes nothing: no call, the write is a no-op. */
export const NOTHING_TO_CHANGE = "nothing to change";

export const LOCAL_ROW_LINE = "A Local Song, Version or Artist cannot go on a Shared Video: pick an archive or Proposed one.";

export interface ArchiveCallSpec {
  fn: WriteFunction;
  args: { p_op: string; p_target: string | null; p_payload: Record<string, unknown>; p_expected_updated_at: string | null; p_edits: EditInput[] };
  /** The id the write mints (a new Chapter), so the caller can find the row after the apply. */
  minted?: string;
}

export interface CallOptions {
  /** The target's stamp to send instead of the one on the Video / Chapter (apply mine after a conflict). */
  stamp?: string | null;
  /** A client-minted uuid for `chapter.add`. */
  newId?: string;
  /** Undo (§4.7): the history rows this write inverts. Each Edit points at the row of its field, else the first. */
  reverses?: { id: string; fieldName?: string | null }[];
}

class LocalRow extends Error {}

function songPair(kinds: Kinds, songId: string | null | undefined, versionId: string | null | undefined) {
  const sk = songId ? kinds.songs[songId] ?? "archive" : null;
  const vk = versionId ? kinds.versions[versionId] ?? "archive" : null;
  if (sk === "local" || vk === "local") throw new LocalRow();
  return {
    song_id: sk === "archive" ? songId! : null,
    proposed_song_id: sk === "proposed" ? songId! : null,
    version_id: vk === "archive" ? versionId! : null,
    proposed_version_id: vk === "proposed" ? versionId! : null,
  };
}

function artistRef(kinds: Kinds, id: string) {
  const k = kinds.artists[id] ?? "archive";
  if (k === "local") throw new LocalRow();
  return k === "proposed" ? { proposed_artist_id: id } : { artist_id: id };
}

/** The table route's Latin title of a title, with its source (§4.3: the browser computes it). */
export function latinOf(title: string): { title_latin: string | null; title_latin_source: "table" | null } {
  const l = latinByTable(title);
  return { title_latin: l, title_latin_source: l ? "table" : null };
}

const cleanTitle = (t: string) => t.trim().replace(/\s+/g, " ");

/**
 * One op on a Shared Video as the archive function, payload, stamp and Edits (§4.1). Returns `{refused}` for what
 * the archive must not be sent (a Local row on a Shared Video, nothing changed).
 */
export function archiveCall(video: LinkVideo, op: LinkOp, kinds: Kinds = NO_KINDS, opts: CallOptions = {}): ArchiveCallSpec | { refused: string } {
  try {
    const spec = build(video, op, kinds, opts);
    const rev = opts.reverses ?? [];
    if (!("refused" in spec) && rev.length)
      for (const e of spec.args.p_edits) e.reverses = (rev.find((r) => r.fieldName != null && r.fieldName === e.field_name) ?? rev[0]!).id;
    return spec;
  } catch (e) {
    if (e instanceof LocalRow) return { refused: LOCAL_ROW_LINE };
    throw e;
  }
}

function build(video: LinkVideo, op: LinkOp, kinds: Kinds, opts: CallOptions): ArchiveCallSpec | { refused: string } {
  const vStamp = opts.stamp !== undefined ? opts.stamp : video.updatedAt;
  const call = (fn: WriteFunction, p_op: string, p_target: string | null, p_payload: Record<string, unknown>, p_expected_updated_at: string | null, p_edits: EditInput[]): ArchiveCallSpec => ({
    fn, args: { p_op, p_target, p_payload, p_expected_updated_at, p_edits },
  });
  const nothing = { refused: NOTHING_TO_CHANGE };
  switch (op.kind) {
    case "video.update": {
      const p = op.patch;
      const payload: Record<string, unknown> = {};
      const edits: EditInput[] = [];
      const edit = (event_type: EditInput["event_type"], field_name: string, old_value: unknown, new_value: unknown, description: string) =>
        edits.push({ event_type, field_name, old_value: old_value ?? null, new_value: new_value ?? null, description });
      let title = video.title ?? "";
      if (p.title !== undefined) {
        const t = cleanTitle(p.title);
        if (!t) return { refused: "title must be a non-empty string" };
        if (t !== video.title) {
          payload.title = t;
          edit("video.title_changed", "title", video.title, t, `Title: ${video.title ?? ""} → ${t}`);
          title = t;
        }
      }
      // The Latin title (§4.3): typed = manual; cleared or a new title on a generated one = the table's form.
      let latin: { title_latin: string | null; title_latin_source: string | null } | null = null;
      if (p.titleLatin !== undefined) {
        const t = (p.titleLatin ?? "").trim();
        latin = t ? { title_latin: t, title_latin_source: "manual" } : latinOf(title);
      } else if (payload.title !== undefined && video.titleLatinSource !== "manual") latin = latinOf(title);
      if (latin && (latin.title_latin !== (video.titleLatin ?? null) || latin.title_latin_source !== (video.titleLatinSource ?? null))) {
        Object.assign(payload, latin);
        edit("video.title_latin_changed", "title_latin", video.titleLatin, latin.title_latin, `Latin title: ${video.titleLatin ?? "—"} → ${latin.title_latin ?? "—"}`);
      }
      if (p.type !== undefined) {
        payload.type = p.type;
        payload.type_suggested = false;
        payload.suggestion_source = "manual";
        edit("video.type_changed", "type", video.type, p.type, video.typeSuggested && p.type === video.type ? `Type ${p.type} confirmed` : `Type: ${video.type ?? "—"} → ${p.type}`);
      }
      if (p.songId !== undefined || p.versionId !== undefined) {
        const song = p.songId !== undefined ? p.songId ?? null : video.songId ?? null;
        // a different Song starts on its default Version
        const version = p.versionId !== undefined ? p.versionId ?? null : song !== (video.songId ?? null) ? null : video.versionId ?? null;
        Object.assign(payload, songPair(kinds, song, version), { song_suggested: false, suggestion_source: "manual" });
        if (song !== (video.songId ?? null) || p.versionId === undefined)
          edit("video.song_changed", "song_id", video.songId, song, song === (video.songId ?? null) ? "Song confirmed" : song ? "Song set" : "Song cleared");
        if (version !== (video.versionId ?? null)) edit("video.version_changed", "version_id", video.versionId, version, version ? "Version set" : "Version cleared");
      }
      if (!edits.length) return nothing;
      return call("write_videos", "update", video.id, payload, vStamp, edits);
    }
    case "video.suggest": {
      const payload: Record<string, unknown> = { suggestion_source: op.patch.source };
      if (op.patch.type) Object.assign(payload, { type: op.patch.type, type_suggested: true });
      if (op.patch.songId) Object.assign(payload, songPair(kinds, op.patch.songId, null), { song_suggested: true });
      const what = [op.patch.type && `Type ${op.patch.type}`, op.patch.songId && "a Song"].filter(Boolean).join(" and ");
      return call("write_videos", "update", video.id, payload, vStamp, [
        { event_type: "video.suggested", field_name: op.patch.songId ? "song_id" : "type", old_value: null, new_value: op.patch.songId ?? op.patch.type ?? null, description: `Suggested ${what} (${op.patch.source})` },
      ]);
    }
    case "video.delete": {
      const reason = op.reason.trim();
      if (!reason) return { refused: "a reason is required to delete a Shared Video" };
      return call("write_videos", "delete", video.id, { reason }, vStamp, [{ event_type: "video.deleted", field_name: "delete_reason", new_value: reason, description: `Deleted: ${reason}` }]);
    }
    case "video.restore":
      return call("write_videos", "restore", video.id, {}, vStamp, [{ event_type: "video.restored", description: "Restored" }]);
    case "artists.set": {
      const prev = new Map((video.artists ?? []).map((a) => [a.id, a]));
      const ids = [...new Set(op.artistIds)];
      const artists = ids.map((id) => ({ ...artistRef(kinds, id), suggested: prev.get(id)?.suggested ?? false }));
      // ids with names, so an undo can put them back (§3.6: values sufficient to invert)
      const named = (list: string[]) => list.map((id) => ({ id, name: prev.get(id)?.name ?? id }));
      return call("write_video_artists", "replace", video.id, { artists }, vStamp, [
        { event_type: "artists.replaced", field_name: "artists", old_value: named([...prev.keys()]), new_value: named(ids), description: "Artists changed" },
      ]);
    }
    case "artists.remove": {
      const a = (video.artists ?? []).find((x) => x.id === op.artistId);
      if (!a) return { refused: "that Artist is not on this Video" };
      // A Suggested link is rejected (the matcher never offers it again, for everyone); a confirmed one is removed.
      if (a.suggested && a.linkId)
        return call("write_video_artists", "reject", a.linkId, {}, null, [{ event_type: "artist_link.rejected", field_name: "artist_id", old_value: a.id, description: `Rejected ${a.name}` }]);
      const rest = (video.artists ?? []).filter((x) => x.id !== op.artistId);
      return call("write_video_artists", "replace", video.id, { artists: rest.map((x) => ({ ...artistRef(kinds, x.id), suggested: x.suggested })) }, vStamp, [
        { event_type: "artists.replaced", field_name: "artists", old_value: (video.artists ?? []).map((x) => ({ id: x.id, name: x.name })), new_value: rest.map((x) => ({ id: x.id, name: x.name })), description: `Removed ${a.name}` },
      ]);
    }
    case "artists.confirm":
      return call("write_video_artists", "confirm_all", video.id, {}, null, [{ event_type: "artists.confirmed", description: "Suggested Artists confirmed" }]);
    case "chapter.add": {
      const c = op.chapter;
      const id = opts.newId ?? null;
      const title = cleanTitle(c.title ?? "");
      const payload: Record<string, unknown> = {
        ...(id ? { id } : {}), start_s: c.startS, title, title_latin: latinOf(title).title_latin,
        ...songPair(kinds, c.songId ?? null, c.versionId ?? null), suggested: false, source: "manual",
      };
      const spec = call("write_video_chapters", "add", video.id, payload, null, [{ event_type: "chapter.added", field_name: "start_s", new_value: c.startS, description: `Chapter added at ${c.startS}s` }]);
      return id ? { ...spec, minted: id } : spec;
    }
    case "chapter.update": {
      const ch = op.chapter;
      const p = op.patch;
      const payload: Record<string, unknown> = {};
      const edits: EditInput[] = [];
      if (p.title !== undefined && cleanTitle(p.title) !== ch.title) {
        const t = cleanTitle(p.title);
        Object.assign(payload, { title: t, title_latin: latinOf(t).title_latin }); // "" not null: the Local copy keeps title NOT NULL
        edits.push({ event_type: "chapter.changed", field_name: "title", old_value: ch.title, new_value: t, description: `Chapter title: ${ch.title} → ${t}` });
      }
      if (p.startS !== undefined && p.startS !== ch.startS) {
        payload.start_s = p.startS;
        edits.push({ event_type: "chapter.changed", field_name: "start_s", old_value: ch.startS, new_value: p.startS, description: `Chapter moved: ${ch.startS}s → ${p.startS}s` });
      }
      // Editing the title or the start of a Suggested Chapter confirms it; attaching a Song does not.
      if (ch.suggested && (payload.title !== undefined || payload.start_s !== undefined)) payload.suggested = false;
      if (p.songId !== undefined || p.versionId !== undefined) {
        const song = p.songId !== undefined ? p.songId ?? null : ch.songId ?? null;
        const version = p.versionId !== undefined ? p.versionId ?? null : song !== (ch.songId ?? null) ? null : ch.versionId ?? null;
        Object.assign(payload, songPair(kinds, song, version));
        edits.push({ event_type: "chapter.changed", field_name: "song_id", old_value: ch.songId ?? null, new_value: song, description: song ? "Chapter Song set" : "Chapter Song cleared" });
      }
      if (!edits.length) return nothing;
      return call("write_video_chapters", "update", ch.id, payload, opts.stamp !== undefined ? opts.stamp : ch.updatedAt, edits);
    }
    case "chapter.delete":
      return call("write_video_chapters", "delete", op.chapter.id, {}, opts.stamp !== undefined ? opts.stamp : op.chapter.updatedAt, [
        // the whole Chapter, so an undo can add it back (§3.6: values sufficient to invert)
        { event_type: "chapter.deleted", field_name: "chapter", old_value: { start_s: op.chapter.startS, title: op.chapter.title, song_id: op.chapter.songId ?? null, version_id: op.chapter.versionId ?? null }, description: `Chapter deleted: ${op.chapter.title}` },
      ]);
    case "chapter.confirm":
      return call("write_video_chapters", "confirm", op.chapter.id, {}, opts.stamp !== undefined ? opts.stamp : op.chapter.updatedAt, [
        { event_type: "chapter.confirmed", description: `Chapter confirmed: ${op.chapter.title}` },
      ]);
    case "chapter.reject":
      return call("write_video_chapters", "reject", op.chapter.id, {}, opts.stamp !== undefined ? opts.stamp : op.chapter.updatedAt, [
        { event_type: "chapter.rejected", field_name: "start_s", old_value: op.chapter.startS, description: `Suggested Chapter rejected: ${op.chapter.title}` },
      ]);
    case "chapters.confirmAll":
      return call("write_video_chapters", "confirm_all", video.id, {}, null, [{ event_type: "chapter.confirmed", description: "Every Suggested Chapter confirmed" }]);
    case "chapter.unreject":
      return call("write_video_chapters", "unreject", op.rejectionId, {}, null, [{ event_type: "chapter.unrejected", description: "Chapter rejection undone" }]);
    case "artists.unreject":
      return call("write_video_artists", "unreject", op.rejectionId, {}, null, [{ event_type: "artist_link.unrejected", description: "Artist rejection undone" }]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Undo (§4.7): the inversion table. An undo is an ordinary new write with the inverse op, stamped like any write,
// its Edits pointing (`reverses`) at the rows they invert. Shelved edits' copy back (§7.4) is an ordinary write too.
// ---------------------------------------------------------------------------------------------------------------

export const NOT_UNDOABLE_LINE = "Scans, suggestions, elevations and the migration are not undone (§4.7).";
export const CONFIRM_NOT_UNDOABLE_LINE = "A confirmation is not undone: the archive has no un-confirm.";
export const ALREADY_UNDONE_LINE = "Already undone.";
export const GONE_LINE = "That row is no longer here (deleted since); nothing to undo.";
export const NOT_RECORDED_LINE = "Not enough was recorded with this edit to undo it.";
export const UNREJECTED_GONE_LINE = "The rejection is no longer held (taken back since); nothing to undo.";
export const NOT_HERE_LINE = "This kind of edit is not undone from here.";

/** What an undo needs of an Edit (a `HistoryEntry` from `GET /api/videos/:id/history`). */
export type UndoEntry = Pick<HistoryEntry, "id" | "targetId" | "eventType" | "fieldName" | "oldValue" | "newValue" | "reversedBy" | "rejectionId">;

/** The Video and its Chapters as the Local copy holds them now (the ops quote current values and stamps). */
export interface UndoContext {
  video: LinkVideo;
  chapters: LinkChapter[];
}

export type UndoPlan = { op: LinkOp; reverses: { id: string; fieldName: string | null }[] } | { refused: string };

const isConfirmation = (e: UndoEntry) =>
  e.eventType === "chapter.confirmed" || e.eventType === "artists.confirmed" ||
  ((e.eventType === "video.type_changed" || e.eventType === "video.song_changed") && JSON.stringify(e.oldValue ?? null) === JSON.stringify(e.newValue ?? null));

/** Why a write cannot be undone at all, whatever the Local copy holds now; null when it can be tried. */
export function undoBlock(entries: UndoEntry[]): string | null {
  if (!entries.length) return NOT_HERE_LINE;
  if (entries.some((e) => e.reversedBy)) return ALREADY_UNDONE_LINE;
  if (entries.some((e) => e.eventType === "video.scanned" || e.eventType.endsWith(".migrated") || e.eventType.endsWith(".suggested") || e.eventType.endsWith("_elevated") || e.eventType.endsWith(".elevated")))
    return NOT_UNDOABLE_LINE;
  if (entries.every(isConfirmation)) return CONFIRM_NOT_UNDOABLE_LINE;
  const handled = new Set([
    "video.title_changed", "video.title_latin_changed", "video.type_changed", "video.song_changed", "video.version_changed", "video.deleted", "video.restored",
    "chapter.added", "chapter.changed", "chapter.deleted", "chapter.rejected", "chapter.confirmed", "artists.replaced", "artist_link.rejected", "artists.confirmed",
  ]);
  if (entries.some((e) => !handled.has(e.eventType))) return NOT_HERE_LINE;
  const e = entries.find((x) => !isConfirmation(x))!;
  if (e.eventType === "chapter.rejected" || e.eventType === "artist_link.rejected") return e.rejectionId ? null : UNREJECTED_GONE_LINE;
  if (e.eventType === "chapter.deleted" && !(e.oldValue && typeof e.oldValue === "object" && "start_s" in e.oldValue)) return NOT_RECORDED_LINE;
  if (e.eventType === "artists.replaced" && !(Array.isArray(e.oldValue) && e.oldValue.every((a) => a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string")))
    return NOT_RECORDED_LINE;
  return null;
}

const str = (v: unknown) => (v == null ? null : String(v));

/**
 * The inverse of one write (the Edits one call filed, `groupWrites`), as the op `writeLink` sends with `reverses`.
 * Confirmations in a mixed write are left as they are (no un-confirm); the rest is put back to its old values.
 */
export function inverseOf(entries: UndoEntry[], ctx: UndoContext): UndoPlan {
  const blocked = undoBlock(entries);
  if (blocked) return { refused: blocked };
  const live = entries.filter((e) => !isConfirmation(e));
  const reverses = live.map((e) => ({ id: e.id, fieldName: e.fieldName }));
  const first = live[0]!;
  const chapter = () => ctx.chapters.find((c) => c.id === first.targetId);
  switch (first.eventType) {
    case "video.deleted":
      return { op: { kind: "video.restore" }, reverses };
    case "video.restored":
      return { op: { kind: "video.delete", reason: "Restore undone" }, reverses };
    case "chapter.added": {
      const c = chapter();
      return c ? { op: { kind: "chapter.delete", chapter: c }, reverses } : { refused: GONE_LINE };
    }
    case "chapter.deleted": {
      const o = first.oldValue as { start_s: number; title?: string | null; song_id?: string | null; version_id?: string | null };
      return { op: { kind: "chapter.add", chapter: { startS: Number(o.start_s), title: o.title ?? "", songId: o.song_id ?? null, versionId: o.version_id ?? null } }, reverses };
    }
    case "chapter.changed": {
      const c = chapter();
      if (!c) return { refused: GONE_LINE };
      const patch: ChapterPatch = {};
      for (const e of live) {
        if (e.fieldName === "title") patch.title = str(e.oldValue) ?? "";
        else if (e.fieldName === "start_s") patch.startS = Number(e.oldValue);
        else if (e.fieldName === "song_id") patch.songId = str(e.oldValue);
      }
      return { op: { kind: "chapter.update", chapter: c, patch }, reverses };
    }
    case "chapter.rejected":
      return { op: { kind: "chapter.unreject", rejectionId: first.rejectionId! }, reverses };
    case "artist_link.rejected":
      return { op: { kind: "artists.unreject", rejectionId: first.rejectionId! }, reverses };
    case "artists.replaced":
      return { op: { kind: "artists.set", artistIds: (first.oldValue as { id: string }[]).map((a) => a.id) }, reverses };
    default: {
      // the video.* field changes of one update, as one update back
      const patch: VideoPatch = {};
      const titleChanged = live.some((e) => e.eventType === "video.title_changed");
      const used: typeof reverses = [];
      for (const e of live) {
        if (e.eventType === "video.title_changed") patch.title = str(e.oldValue) ?? "";
        // a Latin title that followed the title is regenerated from the old title; one typed alone is put back
        else if (e.eventType === "video.title_latin_changed") {
          if (!titleChanged) patch.titleLatin = str(e.oldValue);
        } else if (e.eventType === "video.type_changed") patch.type = e.oldValue as VideoPatch["type"];
        else if (e.eventType === "video.song_changed") patch.songId = str(e.oldValue);
        else if (e.eventType === "video.version_changed") patch.versionId = str(e.oldValue);
        used.push({ id: e.id, fieldName: e.fieldName });
      }
      if (patch.title !== undefined && !patch.title) return { refused: NOT_RECORDED_LINE };
      if (patch.songId !== undefined && patch.versionId === undefined && patch.songId === (ctx.video.songId ?? null)) delete patch.songId;
      return { op: { kind: "video.update", patch }, reverses: used };
    }
  }
}

/** A Shelved edit's copy back (§7.4): the kept values as an ordinary write on the Shared Video. */
export function copyBackOp(item: { kind: string; payload: Record<string, unknown> }): LinkOp | null {
  const p = item.payload;
  switch (item.kind) {
    case "title":
      return typeof p.title === "string" && p.title.trim() ? { kind: "video.update", patch: { title: p.title } } : null;
    case "type":
      return typeof p.type === "string" ? { kind: "video.update", patch: { type: p.type as VideoPatch["type"] } } : null;
    case "song":
      return { kind: "video.update", patch: { songId: str(p.songId), versionId: str(p.versionId) } };
    case "artists":
      return Array.isArray(p.artistIds) ? { kind: "artists.set", artistIds: p.artistIds.map(String) } : null;
    case "chapter":
      return typeof p.startS === "number" ? { kind: "chapter.add", chapter: { startS: p.startS, title: typeof p.title === "string" ? p.title : "", songId: str(p.songId), versionId: str(p.versionId) } } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Errors (§4.2): a line for every wire word
// ---------------------------------------------------------------------------------------------------------------

export const OFFLINE_WRITE_LINE = "The archive can't be reached, so the edit was not saved. Try again when you're online.";
export const SIGNED_OUT_WRITE_LINE = "Your session has ended, so the edit was not saved. Sign in again to edit Shared Videos.";

export function writeErrorLine(e: ArchiveError, flags: { unreachable?: boolean; unauthorized?: boolean } = {}): string {
  if (flags.unreachable) return OFFLINE_WRITE_LINE;
  if (flags.unauthorized) return SIGNED_OUT_WRITE_LINE;
  switch (e.word) {
    case "forbidden":
      return "This account can't edit Shared Videos (Video Editor access is needed).";
    case "not-found":
      return "That row is no longer in the Shared data (deleted elsewhere). Sync to refresh.";
    case "conflict":
      return "Someone changed this after you loaded it.";
    case "duplicate-candidate":
      return e.detail.length ? `Already exists: ${e.detail.map((c) => `${c.name} (${c.kind})`).join(", ")}.` : "A row with that name already exists.";
    case "in-use":
      return e.detail ? `Still in use by ${e.detail.count} row${e.detail.count === 1 ? "" : "s"}.` : "Still in use.";
    case "exists":
      return "A Chapter already starts at that time.";
    case "malformed":
      return `The archive refused the edit as malformed (a bug in this app): ${e.message}`;
    default:
      return e.message || "The archive refused the edit.";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The conflict notice (§4.2): keep theirs (default) or apply mine
// ---------------------------------------------------------------------------------------------------------------

export interface ConflictEntry {
  video: LinkVideo;
  op: LinkOp;
  detail: ConflictDetail | null;
}

export type ConflictState =
  | { phase: "idle" }
  | { phase: "reloading" | "shown" | "applying"; entry: ConflictEntry; error: string | null };

export type ConflictAction =
  | { type: "raised"; entry: ConflictEntry }
  | { type: "reloaded"; video?: LinkVideo }
  | { type: "keep-theirs" }
  | { type: "apply-mine" }
  | { type: "applied" }
  | { type: "failed"; error: string }
  | { type: "conflict-again"; detail: ConflictDetail | null };

export const IDLE_CONFLICT: ConflictState = { phase: "idle" };

export function conflictReducer(s: ConflictState, a: ConflictAction): ConflictState {
  switch (a.type) {
    case "raised":
      // a conflict while one is already open replaces it (the newest edit is the one the person just made)
      return { phase: "reloading", entry: a.entry, error: null };
    case "reloaded":
      return s.phase === "reloading" ? { phase: "shown", entry: a.video ? { ...s.entry, video: a.video } : s.entry, error: null } : s;
    case "keep-theirs":
      return s.phase === "shown" ? IDLE_CONFLICT : s;
    case "apply-mine":
      return s.phase === "shown" ? { ...s, phase: "applying", error: null } : s;
    case "applied":
      return s.phase === "applying" ? IDLE_CONFLICT : s;
    case "failed":
      return s.phase === "applying" ? { ...s, phase: "shown", error: a.error } : s;
    case "conflict-again":
      return s.phase === "applying" ? { phase: "reloading", entry: { ...s.entry, detail: a.detail }, error: null } : s;
  }
}

/** The stamp "apply mine" sends: the row's current one from the conflict's DETAIL. */
export const applyMineStamp = (e: ConflictEntry): string | null | undefined => e.detail?.updated_at;

/** "Who changed it and when, old → new" for the notice. `me` is this account's user id. */
export function conflictLines(detail: ConflictDetail | null, me: string | null, now = Date.now()): { who: string; when: string | null; change: string | null } {
  const last = detail?.last_edit ?? null;
  if (!last) return { who: "Someone", when: null, change: null };
  const who = last.editor_id && me && last.editor_id === me ? "You (in another tab or on another machine)" : "Another Video Editor";
  const mins = Math.round((now - Date.parse(last.created_at)) / 60000);
  const when = !Number.isFinite(mins) ? null : mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago` : new Date(last.created_at).toLocaleDateString();
  // history values are JSON; a string may arrive still encoded ("\"A\"")
  const show = (v: unknown): string => {
    if (typeof v === "string" && v.startsWith('"')) {
      try {
        return show(JSON.parse(v));
      } catch {}
    }
    return v == null ? "—" : typeof v === "string" ? v : JSON.stringify(v);
  };
  const change = last.field_name ? `${last.field_name}: ${show(last.old_value)} → ${show(last.new_value)}` : last.event_type;
  return { who, when, change };
}
