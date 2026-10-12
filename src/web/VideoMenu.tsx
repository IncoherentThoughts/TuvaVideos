// Right-click menu on a Video in any list (Library grid, search results, Favorites rows): shows the view count
// (migration 0009) and resets it. Mounted once in the app shell; it listens for `contextmenu` on any element that
// carries `data-fav-kind="video"` and `data-id`, the markers the keyboard walker already uses.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, replaceVideo, useStore } from "./data";

interface Open {
  id: number;
  x: number;
  y: number;
}

export function VideoMenu() {
  const { videos } = useStore();
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-fav-kind="video"][data-id]');
      if (!el) return;
      e.preventDefault();
      setErr(null);
      setOpen({ id: Number(el.dataset.id), x: e.clientX, y: e.clientY });
    };
    const close = () => setOpen(null);
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("contextmenu", onCtx);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("contextmenu", onCtx);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, []);

  // keep the menu inside the viewport
  useEffect(() => {
    const el = box.current;
    if (!el || !open) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(open.x, window.innerWidth - r.width - 8);
    const y = Math.min(open.y, window.innerHeight - r.height - 8);
    if (x !== open.x || y !== open.y) setOpen({ ...open, x: Math.max(8, x), y: Math.max(8, y) });
  }, [open]);

  if (!open) return null;
  const v = videos?.find((x) => x.id === open.id);
  if (!v) return null;

  const reset = async () => {
    setBusy(true);
    try {
      replaceVideo(await api.resetViews(v.id));
      setOpen(null);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
    setBusy(false);
  };

  return (
    <div ref={box} class="menu vmenu" role="menu" aria-label={`Actions for ${v.title}`} style={{ left: open.x, top: open.y }} onContextMenu={(e) => e.preventDefault()}>
      <div class="vm-title" title={v.title}>{v.title}</div>
      <div class="vm-meta">{v.viewCount} view{v.viewCount === 1 ? "" : "s"}</div>
      <button role="menuitem" disabled={busy || v.viewCount === 0} onClick={() => void reset()}>
        Reset view count
      </button>
      {err && <div class="vm-err">{err}</div>}
    </div>
  );
}
