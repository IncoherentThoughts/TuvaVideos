// Edit history in the UI (docs/sharing-spec.md §4.7, §4.8, §7.4; ticket #147): the History tab of Now playing's State
// panel, the library-wide Edits view (`/edits`, from the chip menu), the undo toast, and the Shelved drawer with its
// copy back and Clear. Undo buttons for Video Editors only; everything reads the Local copy through the companion.
import { useEffect, useRef, useState } from "preact/hooks";
import { DiffRowView, ShelvedExplainer } from "./ShelvedDiff";
import { EVENT_FILTERS, editorLabel, groupWrites, hasUnseenShelved, showValue, type EditsPage, type HistoryEntry, type ShelvedItem, type WriteGroup } from "../shared/editHistory";
import { writePills, type ActionPill } from "../shared/historyPill";
import { api, currentVideos, onStoreChange, reloadAll, replaceVideo } from "./data";
import { Link, playHref } from "./router";
import { useSession } from "./session";
import { dismissToast, RELOADED_EVENT, undoFromToast, undoWrite, useUndoToast, writeLink } from "./writeLink";
import { copyBackOp, undoBlock } from "./writeOps";

const when = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function change(e: HistoryEntry): string | null {
  if (!e.fieldName || (e.oldValue == null && e.newValue == null) || e.description.includes("→")) return null;
  if (e.fieldName === "song_id" || e.fieldName === "version_id" || e.fieldName === "artist_id") return null; // ids say nothing
  const before = showValue(e.oldValue), after = showValue(e.newValue);
  if (before === "—") return after; // set from nothing: just the new value, not "— → x"
  if (after === "—") return `cleared (was ${before})`;
  return `${before} → ${after}`;
}

/** A write's coloured action pills (#159): edit, create, soft delete, undo, Repoint, share, Elevate, expose, … */
export function ActionPills({ pills }: { pills: ActionPill[] }) {
  return (
    <span class="apills">
      {pills.map((p) => (
        <span key={p.label} class={`apill ${p.kind}`}>
          {p.label}
        </span>
      ))}
    </span>
  );
}

/** The writes, newest first, with Undo for a Video Editor. `onChanged` after an undo (re-read the list). */
export function WriteList({ groups, showVideo, onChanged }: { groups: WriteGroup[]; showVideo?: boolean; onChanged: () => void }) {
  const s = useSession();
  const me = s.record?.userId ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ key: string; line: string } | null>(null);
  const reversed = new Set(groups.flatMap((g) => g.entries.flatMap((e) => (e.reverses ? [e.reverses] : []))));
  const undo = async (g: WriteGroup) => {
    setBusy(g.key);
    setErr(null);
    try {
      await undoWrite(g.entries);
      onChanged();
    } catch (e) {
      setErr({ key: g.key, line: (e as Error).message });
    }
    setBusy(null);
  };
  if (!groups.length) return <p class="nil hist-empty">No edits yet.</p>;
  return (
    <ol class="hist">
      {groups.map((g) => {
        const block = undoBlock(g.entries);
        const undone = g.entries.some((e) => e.reversedBy || reversed.has(e.id));
        return (
          <li key={g.key} class={undone ? "undone" : ""}>
            <div class="hist-head">
              <ActionPills pills={writePills(g.entries)} />
              <span class="hist-when">{when(g.createdAt)}</span>
              <span class="hist-who">{editorLabel(g.editorId, me)}</span>
              {showVideo && g.videoId && (
                <Link class="hist-video" href={playHref(g.videoId)}>
                  {g.videoTitle ?? "(gone)"}
                </Link>
              )}
              {undone && <span class="hist-tag">undone</span>}
              {s.canEdit && !undone && !block && (
                <button class="btn small hist-undo" disabled={busy != null} onClick={() => void undo(g)}>
                  {busy === g.key ? "Undoing…" : "Undo"}
                </button>
              )}
            </div>
            <ul>
              {g.entries.map((e) => (
                <li key={e.id} title={e.eventType}>
                  {e.description}
                  {change(e) && <span class="dim"> · {change(e)}</span>}
                </li>
              ))}
            </ul>
            {err?.key === g.key && <p class="err">{err.line}</p>}
          </li>
        );
      })}
    </ol>
  );
}

/** Re-runs `load` when a write or an undo touched this Video (the conflict notice and undo fire RELOADED_EVENT). */
function useReloadOn(videoId: string | null, load: () => void) {
  useEffect(() => {
    const f = (e: Event) => (!videoId || (e as CustomEvent).detail?.videoId === videoId) && load();
    window.addEventListener(RELOADED_EVENT, f);
    return () => window.removeEventListener(RELOADED_EVENT, f);
  }, [videoId]);
}

/** The History tab of Now playing's State panel (§4.8), with the Video's Shelved marker (§7.4). */
export function VideoHistory({ videoId, shared }: { videoId: string; shared: boolean }) {
  const [list, setList] = useState<HistoryEntry[] | null>(null);
  const [shelved, setShelved] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    fetch(`/api/videos/${videoId}/history`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`history: ${r.status}`))))
      .then((h: HistoryEntry[]) => (setList(h), setErr(null)))
      .catch((e: Error) => setErr(e.message));
    void fetchShelved(videoId).then((x) => setShelved(x.length)).catch(() => null);
  };
  useEffect(load, [videoId]);
  useReloadOn(videoId, load);
  useEffect(() => onShelvedChange(load), [videoId]);
  const unseen = hasUnseenShelved(useUnseenShelved(), videoId);
  return (
    <div class="vhist">
      {shelved > 0 && (
        <button class={`shelf-mark${unseen ? " unseen" : ""}`} onClick={() => openShelved(videoId)} title={`Values this machine had before sign-in replaced them with the Shared ones${unseen ? " (not looked at yet)" : ""}`}>
          {unseen && <span class="shelf-dot" aria-hidden="true" />}
          {shelved} Shelved edit{shelved === 1 ? "" : "s"}{unseen ? " · new" : ""}
        </button>
      )}
      {err && <p class="bad">{err}</p>}
      {!shared && list?.length === 0 ? <p class="nil hist-empty">An Unshared Video keeps no edit history.</p> : list && <WriteList groups={groupWrites(list)} onChanged={load} />}
    </div>
  );
}

/** `/edits`: the library-wide Edits view (§4.8), filterable by editor and type. */
export function EditsView() {
  const s = useSession();
  const me = s.record?.userId ?? null;
  const [editor, setEditor] = useState("");
  const [type, setType] = useState("");
  const [page, setPage] = useState<EditsPage | null>(null);
  const [more, setMore] = useState<HistoryEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const query = (before?: string | null) => {
    const q = new URLSearchParams();
    if (editor) q.set("editor", editor);
    if (type) q.set("type", type);
    if (before) q.set("before", before);
    return fetch(`/api/edits?${q}`).then((r) => (r.ok ? (r.json() as Promise<EditsPage>) : Promise.reject(new Error(`edits: ${r.status}`))));
  };
  const load = () =>
    void query()
      .then((p) => (setPage(p), setMore([]), setErr(null)))
      .catch((e: Error) => setErr(e.message));
  useEffect(load, [editor, type]);
  useReloadOn(null, load);
  const entries = [...(page?.entries ?? []), ...more];
  const next = more.length ? null : page?.next ?? null;
  return (
    <section class="edits-view">
      <h2>Edits</h2>
      <div class="edits-filters">
        <label>
          Editor{" "}
          <select value={editor} onChange={(e) => setEditor((e.target as HTMLSelectElement).value)}>
            <option value="">Everyone</option>
            {(page?.editors ?? []).map((id) => (
              <option key={id} value={id}>
                {editorLabel(id, me)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type{" "}
          <select value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
            {EVENT_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {err && <p class="err">{err}</p>}
      {page && <WriteList groups={groupWrites(entries)} showVideo onChanged={load} />}
      {next && (
        <button class="btn small" onClick={() => void query(next).then((p) => setMore(p.entries))}>
          Older edits
        </button>
      )}
    </section>
  );
}

/** "Saved · Undo" after a Shared write (§4.7): the last write only, gone after a few seconds. */
export function UndoToastView() {
  const t = useUndoToast();
  useEffect(() => {
    if (!t || t.busy) return;
    const h = setTimeout(dismissToast, t.undo ? 8000 : 4000);
    return () => clearTimeout(h);
  }, [t?.n, t?.busy]);
  if (!t) return null;
  return (
    <div class={`toast undo-toast${t.error ? " bad" : ""}`} role="status">
      <span>{t.line}</span>
      {t.undo && (
        <button class="btn small" disabled={t.busy} onClick={() => void undoFromToast()}>
          {t.busy ? "Undoing…" : "Undo"}
        </button>
      )}
      <button class="ib" aria-label="Dismiss" onClick={dismissToast}>
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The Shelved drawer (§7.4)
// ---------------------------------------------------------------------------------------------------------------

export const fetchShelved = (videoId?: string): Promise<ShelvedItem[]> =>
  fetch(`/api/shelved${videoId ? `?video=${videoId}` : ""}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`shelved: ${r.status}`))));

let drawer: { videoId: string | null } | null = null;
const drawerSubs = new Set<() => void>();
const shelvedSubs = new Set<() => void>();
const bumpDrawer = () => drawerSubs.forEach((f) => f());
/** Opens the drawer for one Video (its marker) or every Video (the chip menu). */
export const openShelved = (videoId: string | null = null) => ((drawer = { videoId }), bumpDrawer());
/** Subscribe to "the Shelved edits changed" (copy back, Clear). Returns the unsubscribe. */
export const onShelvedChange = (f: () => void) => (shelvedSubs.add(f), () => void shelvedSubs.delete(f));
const shelvedChanged = () => shelvedSubs.forEach((f) => f());

// "Seen" (#159): the Videos with Shelved edits the user has not opened the drawer on. One Set for the whole page,
// read from `GET /api/shelved/unseen` when the first reader mounts, after every library reload (a Sync can shelve),
// after a Clear or copy back, and after the drawer stamps its rows seen.
let unseen: ReadonlySet<string> = new Set();
const unseenSubs = new Set<() => void>();
let unseenLoading: Promise<void> | null = null;
let unseenAgain = false;
let watchingStore = false;
let lastVideos: unknown = undefined;
export function refreshUnseen(): Promise<void> {
  if (unseenLoading) return ((unseenAgain = true), unseenLoading);
  unseenLoading = fetch("/api/shelved/unseen")
    .then((r) => (r.ok ? (r.json() as Promise<string[]>) : Promise.reject(new Error(`unseen: ${r.status}`))))
    .then((ids) => ((unseen = new Set(ids)), unseenSubs.forEach((f) => f())))
    .catch(() => undefined)
    .finally(() => {
      unseenLoading = null;
      if (unseenAgain) (unseenAgain = false), void refreshUnseen();
    });
  return unseenLoading;
}
/**
 * The Videos with unseen Shelved edits, kept current. A grid card's dot is
 * `hasUnseenShelved(useUnseenShelved(), v.id) && <span class="shelf-dot" />`.
 */
export function useUnseenShelved(): ReadonlySet<string> {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    unseenSubs.add(f);
    if (!watchingStore) {
      watchingStore = true;
      onShelvedChange(() => void refreshUnseen());
      onStoreChange(() => {
        const v = currentVideos();
        if (v !== lastVideos) (lastVideos = v), void refreshUnseen();
      });
      lastVideos = currentVideos();
      void refreshUnseen();
    }
    return () => void unseenSubs.delete(f);
  }, []);
  return unseen;
}
/** The drawer opened on one Video (or every Video): its Shelved edits are seen now. */
async function markSeen(videoId: string | null) {
  const r = await fetch(videoId ? `/api/videos/${videoId}/shelved/seen` : "/api/shelved/seen", { method: "POST" });
  if (r.ok) await refreshUnseen();
}

/** Clears one Video's Shelved edits, or all of them. Returns how many went. */
export async function clearShelvedEdits(videoId?: string | null): Promise<number> {
  const r = await fetch(videoId ? `/api/videos/${videoId}/shelved` : "/api/shelved", { method: "DELETE" });
  const j = (await r.json()) as { cleared?: number; error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  shelvedChanged();
  return j.cleared ?? 0;
}

export function ShelvedDrawer() {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    drawerSubs.add(f);
    return () => void drawerSubs.delete(f);
  }, []);
  if (!drawer) return null;
  return <ShelvedDialog key={drawer.videoId ?? "*"} videoId={drawer.videoId} onClose={() => ((drawer = null), bumpDrawer())} />;
}

function ShelvedDialog({ videoId, onClose }: { videoId: string | null; onClose: () => void }) {
  const box = useRef<HTMLDialogElement>(null);
  const s = useSession();
  const [items, setItems] = useState<ShelvedItem[] | null>(null);
  const [busy, setBusy] = useState<number | string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The ones unseen when the drawer opened keep a "new" mark while it stays open (#159).
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const load = () => fetchShelved(videoId ?? undefined).then((l) => (setItems(l), l)).catch((e: Error) => (setErr(e.message), null));
  useEffect(() => {
    box.current?.showModal();
    void load().then((l) => {
      if (!l) return;
      setFresh(new Set(l.filter((i) => !i.seen).map((i) => i.id)));
      if (l.some((i) => !i.seen)) void markSeen(videoId);
    });
  }, []);
  const byVideo = new Map<string, ShelvedItem[]>();
  for (const it of items ?? []) byVideo.set(it.videoId, [...(byVideo.get(it.videoId) ?? []), it]);

  const copyBack = async (it: ShelvedItem) => {
    const op = copyBackOp(it);
    if (!op) return setErr("This Shelved edit has nothing to copy back.");
    setBusy(it.id);
    setErr(null);
    try {
      const video = await api.video(it.videoId);
      await writeLink(video, op);
      // copied back: the value is the Shared one now, so the shelf drops it
      await fetch(`/api/shelved/${it.id}`, { method: "DELETE" });
      replaceVideo(await api.video(it.videoId));
      shelvedChanged();
      window.dispatchEvent(new CustomEvent(RELOADED_EVENT, { detail: { videoId: it.videoId } }));
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(null);
  };
  const clear = async (vid: string | null) => {
    if (!vid && !confirm("Clear every Shelved edit on this machine? They are not in the Shared data and cannot be brought back.")) return;
    setBusy(vid ?? "*");
    setErr(null);
    try {
      await clearShelvedEdits(vid);
      await reloadAll();
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(null);
  };

  return (
    <dialog ref={box} class="delconfirm shelf" aria-label="Shelved edits" onClose={onClose} onClick={(e) => e.target === box.current && busy == null && box.current?.close()}>
      <h3>Shelved edits</h3>
      <ShelvedExplainer />
      <p class="dim">Read-only{s.canEdit ? "; copy back writes one as an ordinary edit" : ""}.</p>
      {items && !items.length && <p class="nil">No Shelved edits.</p>}
      {[...byVideo].map(([vid, list]) => (
        <section key={vid} class="shelf-video">
          <div class="shelf-head">
            <span class="ttl" onClick={() => box.current?.close()}>
              <Link href={playHref(vid)}>{list[0]!.videoTitle}</Link>
            </span>
            <button class="btn small" disabled={busy != null} onClick={() => void clear(vid)}>
              Clear
            </button>
          </div>
          <ul class="sd-rows">
            {list.map((it) => (
              <DiffRowView key={it.id} row={it.diff ?? { attr: it.kind, label: it.summary, before: it.summary, after: "" }}>
                {fresh.has(it.id) && <span class="apill new">new</span>}
                <span class="dim sd-when">shelved {when(it.shelvedAt)}</span>
                {s.canEdit && it.shared && (
                  <button class="btn small" disabled={busy != null} onClick={() => void copyBack(it)}>
                    {busy === it.id ? "Copying…" : "Copy back"}
                  </button>
                )}
              </DiffRowView>
            ))}
          </ul>
        </section>
      ))}
      {err && <p class="err">{err}</p>}
      <div class="row-end">
        {!videoId && !!items?.length && (
          <button class="btn" disabled={busy != null} onClick={() => void clear(null)}>
            Clear all
          </button>
        )}
        <button class="btn" onClick={() => box.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
