// The confirmation for deleting a Video from the library (the Now playing page's Delete button and the grid's
// right-click menu). A modal <dialog>: Esc or Cancel backs out. The checkbox also moves every Copy's file to the
// Trash; unchecked, the files stay on disk and the scanner skips them from now on (server/deleteVideo.ts).
// A Shared Video (sharing-spec §4.5) is instead soft-deleted for everyone with a reason (a Video Editor, through
// writeLink), or only this machine's Copies go to the Trash (`DELETE /api/videos/:id/copies`): the Video stays.
import { useEffect, useRef, useState } from "preact/hooks";
import type { VideoDto } from "../shared/types";
import { api, apiError, removeVideo, replaceVideo } from "./data";
import { useSession } from "./session";
import { writeLink } from "./writeLink";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

export function DeleteVideoDialog(props: { video: VideoDto; onClose: () => void; onDeleted?: () => void }) {
  return props.video.shared ? <SharedDeleteDialog {...props} /> : <LocalDeleteDialog {...props} />;
}

/** The backdrop click that backs out, shared by both dialogs. */
const backdrop = (box: { current: HTMLDialogElement | null }, busy: boolean) => (e: MouseEvent) => {
  const r = box.current!.getBoundingClientRect();
  const out = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (e.target === box.current && out && !busy) box.current!.close();
};

function SharedDeleteDialog({ video, onClose, onDeleted }: { video: VideoDto; onClose: () => void; onDeleted?: () => void }) {
  const box = useRef<HTMLDialogElement>(null);
  const s = useSession();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [left, setLeft] = useState<{ path: string; reason: string }[] | null>(null);
  useEffect(() => {
    box.current?.showModal();
  }, []);
  const onDisk = video.copies.filter((c) => !c.missing);
  const total = onDisk.reduce((n, c) => n + c.size, 0);

  const softDelete = async () => {
    setBusy(true);
    setErr(null);
    try {
      await writeLink(video, { kind: "video.delete", reason });
      onDeleted?.();
      box.current?.close();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  const removeCopies = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/videos/${video.id}/copies`, { method: "DELETE" });
      const j = (await r.json()) as { trashed: string[]; kept: { path: string; reason: string }[]; notice?: string; error?: string };
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      replaceVideo(await api.video(video.id));
      if (j.notice) setErr(j.notice);
      else if (j.kept.length) setLeft(j.kept);
      else box.current?.close();
    } catch (e) {
      setErr(apiError(e));
    }
    setBusy(false);
  };

  return (
    <dialog ref={box} class="delconfirm" aria-label={`Delete ${video.title}`} onClose={onClose} onClick={backdrop(box, busy)}>
      {left ? (
        <>
          <h3>Some files stayed on disk</h3>
          <ul class="paths mono">
            {left.map((k) => (
              <li key={k.path} title={k.path}>
                {fileName(k.path)} <span class="dim">({k.reason})</span>
              </li>
            ))}
          </ul>
          <div class="actions">
            <button class="btn" autoFocus onClick={() => box.current?.close()}>
              OK
            </button>
          </div>
        </>
      ) : (
        <>
          <h3>Delete this Shared Video?</h3>
          <p class="ttl" title={video.title}>{video.title}</p>
          {s.canEdit && (
            <>
              <h4>For everyone</h4>
              <p class="dim">It leaves every Member's library; its Chapters and Artists are kept, and a Video Editor can restore it. No file on any machine is touched.</p>
              <textarea class="reason" placeholder="Why? (required, shown to the other Video Editors)" value={reason} disabled={busy} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />
              <div class="actions">
                <button class="btn danger" disabled={busy || !reason.trim()} onClick={() => void softDelete()}>
                  {busy ? "Deleting…" : "Delete for everyone"}
                </button>
              </div>
            </>
          )}
          <h4>Only from this machine</h4>
          {onDisk.length ? (
            <>
              <p class="dim">
                Moves {onDisk.length === 1 ? "this file" : `these ${onDisk.length} files`} ({fmtSize(total)}) to the Trash. The Video stays in the library, Not on this machine; a later scan that finds a file of it brings it back.
              </p>
              <ul class="paths mono">
                {onDisk.map((c) => (
                  <li key={c.id} title={c.path}>
                    {fileName(c.path)} <span class="dim">({fmtSize(c.size)}{c.available ? "" : ", drive not mounted: stays on disk"})</span>
                  </li>
                ))}
              </ul>
              <div class="actions">
                <button class="btn danger" disabled={busy} onClick={() => void removeCopies()}>
                  Move {onDisk.length === 1 ? "the file" : `${onDisk.length} files`} to the Trash
                </button>
              </div>
            </>
          ) : (
            <p class="dim">This machine holds no file of it.</p>
          )}
          {err && <p class="err">{err}</p>}
          <div class="actions">
            <button class="btn" autoFocus disabled={busy} onClick={() => box.current?.close()}>
              Cancel
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

function LocalDeleteDialog({ video, onClose, onDeleted }: { video: VideoDto; onClose: () => void; onDeleted?: () => void }) {
  const box = useRef<HTMLDialogElement>(null);
  const [media, setMedia] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kept, setKept] = useState<{ path: string; reason: string }[] | null>(null);

  useEffect(() => {
    box.current?.showModal();
  }, []);

  const onDisk = video.copies.filter((c) => !c.missing);
  const unreachable = onDisk.filter((c) => !c.available);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.deleteVideo(video.id, media);
      removeVideo(video.id);
      onDeleted?.();
      // trashing partly failed: say which files are still on disk before closing
      if (media && r.kept.length) setKept(r.kept);
      else onClose();
    } catch (e) {
      setErr(apiError(e));
    }
    setBusy(false);
  };

  return (
    // a click on the backdrop (outside the box; the box's own padding is the dialog too) backs out
    <dialog ref={box} class="delconfirm" aria-label={`Delete ${video.title}`} onClose={onClose} onClick={backdrop(box, busy)}>
      {kept ? (
        <>
          <h3>Deleted, but some files stayed on disk</h3>
          <ul class="paths mono">
            {kept.map((k) => (
              <li key={k.path} title={k.path}>
                {fileName(k.path)} <span class="dim">({k.reason})</span>
              </li>
            ))}
          </ul>
          <p class="dim">Scans will skip them.</p>
          <div class="actions">
            <button class="btn" autoFocus onClick={() => box.current?.close()}>
              OK
            </button>
          </div>
        </>
      ) : (
        <>
          <h3>Delete this Video from the library?</h3>
          <p class="ttl" title={video.title}>{video.title}</p>
          <p class="dim">Its Chapters, Artists, Favorite, view count and Thumbnails go too. This cannot be undone.</p>
          <label class="check">
            <input type="checkbox" checked={media} onChange={(e) => setMedia((e.target as HTMLInputElement).checked)} disabled={busy || !onDisk.length} />
            <span>
              Also move its media to the Trash
              <span class="dim"> ({onDisk.length} file{onDisk.length === 1 ? "" : "s"})</span>
            </span>
          </label>
          {media && (
            <ul class="paths mono">
              {onDisk.map((c) => (
                <li key={c.id} title={c.path}>
                  {fileName(c.path)}
                  {!c.available && <span class="dim"> (drive not mounted: stays on disk)</span>}
                </li>
              ))}
            </ul>
          )}
          {!media && onDisk.length > 0 && <p class="dim">The files stay on disk; scans will skip them from now on.</p>}
          {media && unreachable.length > 0 && <p class="dim">Files on an unmounted drive stay there; scans will skip them.</p>}
          {err && <p class="err">{err}</p>}
          <div class="actions">
            <button class="btn" autoFocus disabled={busy} onClick={() => box.current?.close()}>
              Cancel
            </button>
            <button class="btn danger" disabled={busy} onClick={() => void run()}>
              {busy ? "Deleting…" : media ? "Delete and trash files" : "Delete entry"}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
