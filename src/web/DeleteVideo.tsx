// The confirmation for deleting a Video from the library (the Now playing page's Delete button and the grid's
// right-click menu). A modal <dialog>: Esc or Cancel backs out. The checkbox also moves every Copy's file to the
// Trash; unchecked, the files stay on disk and the scanner skips them from now on (server/deleteVideo.ts).
import { useEffect, useRef, useState } from "preact/hooks";
import type { VideoDto } from "../shared/types";
import { api, apiError, removeVideo } from "./data";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function DeleteVideoDialog({ video, onClose, onDeleted }: { video: VideoDto; onClose: () => void; onDeleted?: () => void }) {
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
    <dialog ref={box} class="delconfirm" aria-label={`Delete ${video.title}`} onClose={onClose} onClick={(e) => {
      // a click on the backdrop (outside the box; the box's own padding is the dialog too) backs out
      const r = box.current!.getBoundingClientRect();
      const out = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (e.target === box.current && out && !busy) box.current!.close();
    }}>
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
