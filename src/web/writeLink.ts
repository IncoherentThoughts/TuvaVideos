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
import { api, removeVideo, replaceVideo } from "./data";
import {
  applyMineStamp, archiveCall, conflictReducer, IDLE_CONFLICT, kindsNeeded, localRequest, NOTHING_TO_CHANGE, routeFor, SIGNED_OUT_WRITE_LINE, writeErrorLine,
  type ConflictAction, type ConflictEntry, type ConflictState, type Kinds, type LinkOp, type LinkVideo, type SuggestPatch, type WriteMode,
} from "./writeOps";

export type { LinkOp, LinkVideo } from "./writeOps";

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

async function machineMode(): Promise<WriteMode> {
  try {
    const r = await fetch("/api/session");
    if (!r.ok) return "standalone";
    const s = (await r.json()) as SessionResponse;
    return !s.record ? "standalone" : (s.record.grantLevel ?? "no-grant");
  } catch {
    return "standalone";
  }
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

export function useConflict(): ConflictState {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    conflictSubs.add(f);
    return () => void conflictSubs.delete(f);
  }, []);
  return conflict;
}
