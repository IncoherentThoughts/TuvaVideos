// The folder button on Now playing: the Video's file moved, so point its Copy at the new path. Every edit, tag,
// Chapter and Favorite stays on the Video. "Browse…" opens the Finder's file dialog (a page cannot read full paths).
import { useEffect, useRef, useState } from "preact/hooks";
import type { VideoDto } from "../shared/types";
import { api, apiError, loadVideos, replaceVideo } from "./data";

const dirOf = (p: string) => p.slice(0, Math.max(1, p.lastIndexOf("/")));

export function RelocateButton({ video: v, onChange }: { video: VideoDto; onChange: (v: VideoDto) => void }) {
  const [open, setOpen] = useState(false);
  const missing = v.copies.find((c) => c.missing);
  const [copyId, setCopyId] = useState<number | null>(null);
  const copy = v.copies.find((c) => c.id === copyId) ?? missing ?? v.copies.find((c) => c.id === v.preferredCopyId) ?? v.copies[0] ?? null;
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => setOpen(false), [v.id]);
  useEffect(() => {
    if (open) (setPath(copy?.path ?? ""), setErr(null));
  }, [open, copy?.id]);
  // Keep the popup on screen: slide it left when it would run past the right edge.
  useEffect(() => {
    if (!open || !pop.current) return void setShift(0);
    const r = pop.current.getBoundingClientRect();
    setShift(Math.min(0, innerWidth - 12 - (r.right - shift)));
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !busy && setOpen(false);
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, [open, busy]);

  const save = async (merge = false) => {
    if (!path.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const fresh = await api.relocate(v.id, { path: path.trim(), copyId: copy?.id ?? null, merge });
      replaceVideo(fresh);
      onChange(fresh);
      if (merge) void loadVideos(); // the stray Video is gone
      setOpen(false);
    } catch (e) {
      let title: string | null = null;
      try {
        title = (JSON.parse(String((e as Error).message).replace(/^\/api\/\S+: \d+ /, "")) as { conflict?: { title: string } }).conflict?.title ?? null;
      } catch {}
      if (!merge && title != null) {
        if (confirm(`That file is already the separate Video “${title}”.\n\nMerge it into this Video? “${title}” and its own tags and Chapters will be removed; this Video keeps everything it has.`)) return void (await save(true));
      }
      setErr(apiError(e));
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    setBusy(true);
    try {
      const r = await api.chooseFile(dirOf(path || copy?.path || ""));
      if (r.path) setPath(r.path);
    } catch (e) {
      setErr(apiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span class="field relocate" ref={box}>
      <button class={`ibtn folder${missing ? " warn" : ""}${open ? " on" : ""}`} aria-expanded={open} aria-label="Change the file's location" title={missing ? "This Video's file is missing: point it at where the file is now" : "File location: point this Video at its file's new place"} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
        </svg>
      </button>
      {open && (
        <div class="relocate-pop" ref={pop} style={{ left: `${shift}px` }} role="dialog" aria-label="File location" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
          <div class="hd">File location{copy?.missing && <span class="miss"> · missing</span>}</div>
          {v.copies.length > 1 && (
            <select class="chip" aria-label="Copy" value={copy?.id} onChange={(e) => setCopyId(Number((e.target as HTMLSelectElement).value))}>
              {v.copies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.rootKind} · {c.path.split("/").pop()}{c.missing ? " (missing)" : ""}
                </option>
              ))}
            </select>
          )}
          <input
            class="pk-in"
            autoFocus
            spellcheck={false}
            value={path}
            aria-label="Full path of the file"
            placeholder="/Volumes/…/video.mp4"
            onInput={(e) => setPath((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void save())}
          />
          {err && <div class="edit-err" role="alert">{err}</div>}
          <div class="row">
            <button class="btn small" disabled={busy} onClick={() => void browse()}>
              Browse…
            </button>
            <span class="dim">Tags, Chapters and Favorites stay.</span>
            <button class="btn small primary" disabled={busy || !path.trim() || path.trim() === copy?.path} onClick={() => void save()}>
              {busy ? "…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
