// The client seam (docs/sharing-spec.md §4.9; ticket #145): `writeLink(video, op)` is the one way the browser writes
// link data. A Shared Video on a Video Editor's machine goes to the archive (`callWrite`, typed by archiveWire.ts), the
// returned bundle to `POST /api/cache/apply`, then the session's `afterWrite()`; an Unshared or Standalone Video takes
// the companion's existing routes unchanged. A conflict (§4.2) also opens the conflict notice (ConflictNotice.tsx),
// whose store lives here. The pure mapping is writeOps.ts.
import { useEffect, useState } from "preact/hooks";
import { callWrite } from "../shared/archive";
import type { ArchiveError, WireWord } from "../shared/archiveWire";
import type { SessionResponse } from "../shared/session";
import type { ChapterDto, VideoDto } from "../shared/types";
import { afterWrite, archiveRpc, requestSync } from "./session";
import type { RowInfo } from "../server/sharedWrites";
import { api, forgetSong, loadArtists, loadVideos, removeVideo, replaceVideo } from "./data";
import {
  applyMineStamp, archiveCall, artistRepointPlan, conflictReducer, IDLE_CONFLICT, kindsNeeded, LOCAL_TARGET_LINE, localRepointRequest, localRequest, NOTHING_TO_CHANGE, repointPlan, routeFor, rowCall,
  rowKindsNeeded, rowRefusal, rowRoles, SIGNED_OUT_WRITE_LINE, writeErrorLine,
  type ConflictAction, type ConflictEntry, type ConflictState, type Kinds, type LinkOp, type LinkVideo, type NamedRow, type RowOp, type RowTable, type SuggestPatch, type WriteMode,
} from "./writeOps";

export type { LinkOp, LinkVideo, RowOp, RowTable } from "./writeOps";

/** What a write resolves to, per op: the fresh Video, the fresh Chapter, or nothing to read back. */
export type LinkResult<O extends LinkOp> = O["kind"] extends "chapter.add" | "chapter.update" | "chapter.confirm"
  ? ChapterDto
  : O["kind"] extends "chapter.delete" | "chapter.reject" | "chapters.confirmAll"
    ? null
    : O["kind"] extends "video.delete"
      ? { deleted: true }
      : VideoDto;

/** A write the archive or the companion refused; `message` is the human line. */
export class WriteLinkError extends Error {
  constructor(
    message: string,
    readonly word: WireWord | "unknown" | "refused" | "local",
    readonly archive: ArchiveError | null = null,
  ) {
    super(message);
  }
}

export interface WriteLinkOptions {
  /** Send this stamp instead of the row's (apply mine). */
  stamp?: string | null;
  /** Do not open the conflict notice on a conflict (the notice's own apply mine). */
  quietConflict?: boolean;
}

async function sessionRecord(): Promise<SessionResponse["record"] | null> {
  try {
    const r = await fetch("/api/session");
    if (!r.ok) return null;
    return ((await r.json()) as SessionResponse).record ?? null;
  } catch {
    return null;
  }
}

async function machineMode(): Promise<WriteMode> {
  const record = await sessionRecord();
  return !record ? "standalone" : (record.grantLevel ?? "no-grant");
}

async function fetchKinds(need: { songs: string[]; versions: string[]; artists: string[] }): Promise<Kinds> {
  if (!need.songs.length && !need.versions.length && !need.artists.length) return { songs: {}, versions: {}, artists: {} };
  const q = new URLSearchParams({ songs: need.songs.join(","), versions: need.versions.join(","), artists: need.artists.join(",") });
  const r = await fetch(`/api/kinds?${q}`);
  if (!r.ok) throw new WriteLinkError(`could not read the Songs and Artists (${r.status})`, "local");
  return (await r.json()) as Kinds;
}

async function sendLocal<T>(req: { method: string; url: string; body?: unknown }): Promise<T> {
  const r = await fetch(req.url, { method: req.method, headers: { "content-type": "application/json" }, body: req.body === undefined ? undefined : JSON.stringify(req.body) });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    let line = text;
    try {
      line = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {}
    throw new WriteLinkError(line || `${req.url}: ${r.status}`, "local");
  }
  return (await r.json()) as T;
}

const freshChapter = async (videoId: string, id: string): Promise<ChapterDto> => {
  const c = (await api.chapters(videoId)).find((x) => x.id === id);
  if (!c) throw new WriteLinkError("the Chapter was written but is not in the Local copy yet; Sync to see it", "unknown");
  return c;
};

/** Reads back what a write changed, from the Local copy (after the apply, or the companion's own route). */
async function readBack(video: LinkVideo, op: LinkOp, minted?: string): Promise<unknown> {
  switch (op.kind) {
    case "chapter.add":
      return minted ? freshChapter(video.id, minted) : null;
    case "chapter.update":
    case "chapter.confirm":
      return freshChapter(video.id, op.chapter.id);
    case "chapter.delete":
    case "chapter.reject":
    case "chapters.confirmAll":
      return null;
    case "video.delete":
      removeVideo(video.id);
      return { deleted: true };
    default: {
      const v = await api.video(video.id);
      replaceVideo(v);
      return v;
    }
  }
}

/** The one write of link data (§4.9). Throws `WriteLinkError` with the human line. */
export async function writeLink<O extends LinkOp>(video: LinkVideo, op: O, opts: WriteLinkOptions = {}): Promise<LinkResult<O>> {
  const route = routeFor(video, op, await machineMode());
  if (route.to === "refused") throw new WriteLinkError(route.line, "refused");
  if (route.to === "local") {
    const req = localRequest(video, op)!;
    const res = await sendLocal<unknown>(req);
    if (op.kind === "chapter.add" || op.kind === "chapter.update" || op.kind === "chapter.confirm") return res as LinkResult<O>;
    if (op.kind.startsWith("chapter")) return null as LinkResult<O>;
    replaceVideo(res as VideoDto);
    return res as LinkResult<O>;
  }

  const rpc = archiveRpc();
  if (!rpc) throw new WriteLinkError(SIGNED_OUT_WRITE_LINE, "refused");
  const kinds = await fetchKinds(kindsNeeded(video, op));
  const spec = archiveCall(video, op, kinds, { stamp: opts.stamp, newId: op.kind === "chapter.add" ? crypto.randomUUID() : undefined });
  if ("refused" in spec) {
    if (spec.refused === NOTHING_TO_CHANGE) return (await readBack(video, op)) as LinkResult<O>;
    throw new WriteLinkError(spec.refused, "refused");
  }
  const out = await callWrite(rpc, spec.fn, spec.args as never);
  if (!out.ok) {
    const line = writeErrorLine(out.error, out);
    if (out.error.word === "conflict" && !opts.quietConflict) void raiseConflict({ video, op, detail: out.error.detail });
    throw new WriteLinkError(line, out.error.word, out.error);
  }
  const applied = await fetch("/api/cache/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(out.value) });
  if (!applied.ok) throw new WriteLinkError(`saved to the archive, but this machine could not take the rows (${applied.status}); Sync to see it`, "unknown");
  void afterWrite();
  return (await readBack(video, op, spec.minted)) as LinkResult<O>;
}

// ---------------------------------------------------------------------------------------------------------------
// The conflict notice's store (§4.2)
// ---------------------------------------------------------------------------------------------------------------

/** Fired after the notice reloaded a Video, so open pages (the Chapter strip) re-read it. */
export const RELOADED_EVENT = "tuva:link-reloaded";

let conflict: ConflictState = IDLE_CONFLICT;
const conflictSubs = new Set<() => void>();
function dispatchConflict(a: ConflictAction) {
  const next = conflictReducer(conflict, a);
  if (next === conflict) return;
  conflict = next;
  for (const f of conflictSubs) f();
}

/** The conflict: pull, re-read the Video, then show the notice with who changed it. */
async function raiseConflict(entry: ConflictEntry) {
  dispatchConflict({ type: "raised", entry });
  await reload(entry.video.id);
}

async function reload(videoId: string) {
  await requestSync().catch(() => null);
  let fresh: VideoDto | undefined;
  try {
    fresh = await api.video(videoId);
    replaceVideo(fresh);
  } catch {}
  dispatchConflict({ type: "reloaded", video: fresh });
  window.dispatchEvent(new CustomEvent(RELOADED_EVENT, { detail: { videoId } }));
}

/** Keep theirs (the default): the reloaded row stays; nothing is written. */
export const keepTheirs = () => dispatchConflict({ type: "keep-theirs" });

/** Apply mine: the same op again as a fresh write against the row's current stamp. */
export async function applyMine() {
  if (conflict.phase !== "shown") return;
  const { entry } = conflict;
  dispatchConflict({ type: "apply-mine" });
  try {
    let op = entry.op;
    // a Chapter op carries the Chapter: send the reloaded one (its stamp and the values the Edits quote)
    if ("chapter" in op && "id" in op.chapter) {
      const id = op.chapter.id;
      const c = (await api.chapters(entry.video.id).catch(() => [] as ChapterDto[])).find((x) => x.id === id);
      if (c) op = { ...op, chapter: c } as LinkOp;
    }
    const stampFromDetail = entry.detail?.id === ("chapter" in op && "id" in op.chapter ? op.chapter.id : entry.video.id) ? applyMineStamp(entry) : undefined;
    await writeLink(entry.video, op, { quietConflict: true, stamp: stampFromDetail });
    dispatchConflict({ type: "applied" });
    window.dispatchEvent(new CustomEvent(RELOADED_EVENT, { detail: { videoId: entry.video.id } }));
  } catch (e) {
    if (e instanceof WriteLinkError && e.word === "conflict") {
      dispatchConflict({ type: "conflict-again", detail: e.archive?.word === "conflict" ? e.archive.detail : null });
      await reload(entry.video.id);
    } else dispatchConflict({ type: "failed", error: (e as Error).message });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The matchers on Shared Videos (§4.3)
// ---------------------------------------------------------------------------------------------------------------

/**
 * After a scan on a Video Editor's machine: the companion's matchers ran against the Shared Videos without writing
 * (`GET /api/suggestions/shared`, empty elsewhere); each match is written here through `write_videos` as a
 * `video.suggested` Edit. A conflict or refusal skips that Video (the next scan offers it again if still unset).
 */
export async function drainSharedSuggestions(): Promise<number> {
  let list: { videoId: string; updatedAt: string; title: string; patch: SuggestPatch }[];
  try {
    const r = await fetch("/api/suggestions/shared");
    if (!r.ok) return 0;
    list = await r.json();
  } catch {
    return 0;
  }
  let n = 0;
  for (const s of list) {
    try {
      await writeLink({ id: s.videoId, shared: true, updatedAt: s.updatedAt, title: s.title }, { kind: "video.suggest", patch: s.patch }, { quietConflict: true });
      n++;
    } catch {}
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Row writes: Proposed rows, Elevate, Expose, Repoint (§3.4, §3.5, §4.4, §4.6; ticket #146)
// ---------------------------------------------------------------------------------------------------------------

/** `GET /api/rows/:table/:id`: the row's kind, stamp, exposure and every Video, Chapter and Artist link using it. */
export async function readRow(table: RowTable, id: string): Promise<RowInfo | null> {
  const r = await fetch(`/api/rows/${table}/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new WriteLinkError(`could not read the ${table} (${r.status})`, "local");
  return (await r.json()) as RowInfo;
}

/** Drops what a row write changed from the page caches: Song pages, the Artist list, and the Videos an Elevation or Repoint moved. */
async function refreshAfterRow(op: RowOp, bundle: { tables?: Record<string, unknown[] | undefined> } | null) {
  const songIds = new Set<string>();
  if (op.kind !== "artists.repoint" && (op.kind === "exposure" ? op.target === "song" : op.table !== "artist")) {
    if ("id" in op) songIds.add(op.id);
    if (op.kind === "proposed.create" && op.fields.song_id) songIds.add(op.fields.song_id);
    if (op.kind === "elevate" && op.parent) songIds.add(op.parent.id);
  }
  for (const id of songIds) forgetSong(id);
  const t = bundle?.tables ?? {};
  if (op.kind === "artists.repoint" || ("table" in op && op.table === "artist") || (op.kind === "exposure" && op.target === "artist")) void loadArtists();
  if ((t.videos?.length ?? 0) > 0 || op.kind === "elevate" || op.kind === "artists.repoint") void loadVideos();
}

/**
 * One row write (§4.1): through the archive and `/api/cache/apply`, like `writeLink`. `proposed.create` resolves to the
 * minted id. A Local Artist's repoint (Unshared Videos only) is the companion's merge route. Throws `WriteLinkError`;
 * `duplicate-candidate` and `in-use` carry the archive's DETAIL for the prompts (ProposedRows.tsx).
 */
export async function writeRow(op: RowOp, opts: { stamp?: string | null } = {}): Promise<{ id: string | null }> {
  if (op.kind === "artists.repoint") {
    const kinds = await fetchKinds(rowKindsNeeded(op));
    if (kinds.artists[op.from.id] === "local") {
      if (kinds.artists[op.to.id] === "local") throw new WriteLinkError(LOCAL_TARGET_LINE, "refused");
      await sendLocal(localRepointRequest(op));
      await Promise.all([loadArtists(), loadVideos()]);
      return { id: op.to.id };
    }
  }
  const refusal = rowRefusal(op, rowRoles(await sessionRecord()));
  if (refusal) throw new WriteLinkError(refusal, "refused");
  const rpc = archiveRpc();
  if (!rpc) throw new WriteLinkError(SIGNED_OUT_WRITE_LINE, "refused");
  const kinds = await fetchKinds(rowKindsNeeded(op));
  const spec = rowCall(op, kinds, { stamp: opts.stamp, newId: op.kind === "proposed.create" ? crypto.randomUUID() : undefined });
  if ("refused" in spec) {
    if (spec.refused === NOTHING_TO_CHANGE) return { id: "id" in op ? op.id : null };
    throw new WriteLinkError(spec.refused, "refused");
  }
  const out = await callWrite(rpc, spec.fn, spec.args as never);
  if (!out.ok) throw new WriteLinkError(writeErrorLine(out.error, out), out.error.word, out.error);
  const applied = await fetch("/api/cache/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(out.value) });
  if (!applied.ok) throw new WriteLinkError(`saved to the archive, but this machine could not take the rows (${applied.status}); Sync to see it`, "unknown");
  void afterWrite();
  await refreshAfterRow(op, out.value as never);
  return { id: spec.minted ?? ("id" in op ? op.id : op.kind === "artists.repoint" ? op.to.id : null) };
}

export interface RepointOutcome {
  moved: number;
  failed: { title: string; line: string }[];
  /** The Proposed source was deleted afterwards (nothing pointed at it any more). */
  deleted: boolean;
}

/**
 * Repoint (§4.6): every Video, Chapter and Artist link on `from` moves to `to`. An Artist is one archive `repoint`
 * for the Shared Videos plus `artists.set` on each Unshared one (a Local Artist: the companion's merge); a Song or
 * Version is a `writeLink` per pointer. A Proposed source left unreferenced is deleted (`deleteAfter`, always for an
 * Artist), through `write_proposed_*`, logged.
 */
export async function repointRow(table: RowTable, from: NamedRow, to: NamedRow & { songId?: string | null }, o: { deleteAfter?: boolean } = {}): Promise<RepointOutcome> {
  const info = await readRow(table, from.id);
  if (!info) throw new WriteLinkError(`that ${table} is no longer in the library`, "not-found");
  const failed: RepointOutcome["failed"] = [];
  let moved = 0;
  if (table === "artist") {
    if (info.kind === "local") {
      await writeRow({ kind: "artists.repoint", from, to });
      return { moved: info.uses.artistLinks.length, failed, deleted: true };
    }
    const plan = artistRepointPlan(info, to.id);
    if (plan.archive) {
      await writeRow({ kind: "artists.repoint", from, to });
      moved += info.uses.artistLinks.filter((l) => l.shared).length;
    }
    for (const s of plan.local) {
      try {
        await writeLink(s.video, s.op, { quietConflict: true });
        moved++;
      } catch (e) {
        failed.push({ title: s.video.title ?? s.video.id, line: (e as Error).message });
      }
    }
    void loadArtists();
  } else {
    const target = await readRow(table, to.id);
    const plan = repointPlan(info, { id: to.id, kind: target?.kind ?? null, songId: to.songId ?? target?.parent?.id ?? null });
    if ("refused" in plan) throw new WriteLinkError(plan.refused, "refused");
    for (const s of plan) {
      try {
        await writeLink(s.video, s.op, { quietConflict: true });
        moved++;
      } catch (e) {
        failed.push({ title: s.video.title ?? s.video.id, line: (e as Error).message });
      }
    }
    forgetSong(from.id);
    forgetSong(to.id);
    if (to.songId) forgetSong(to.songId);
  }
  let deleted = false;
  if (info.kind === "proposed" && (o.deleteAfter || table === "artist") && !failed.length) {
    const left = await readRow(table, from.id);
    if (left && left.uses.videos.length + left.uses.chapters.length + left.uses.artistLinks.length === 0) {
      await writeRow({ kind: "proposed.delete", table, id: from.id, name: from.name, stamp: left.updatedAt });
      deleted = true;
    }
  }
  void loadVideos();
  return { moved, failed, deleted };
}

export function useConflict(): ConflictState {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    conflictSubs.add(f);
    return () => void conflictSubs.delete(f);
  }, []);
  return conflict;
}
