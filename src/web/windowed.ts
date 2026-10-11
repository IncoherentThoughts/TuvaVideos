// Windowed rendering for the big grids: only the first `limit` items are in the DOM, and a sentinel under the grid
// grows the window as the user scrolls towards it. Every navigation back to the Library used to rebuild all ~1800
// cards (~25k DOM nodes) at once, which is what froze the page for seconds (more so with extensions such as Dark
// Reader that walk every node). The window size lives in the history entry's state: Back lands on a grid tall
// enough for the browser to restore the scroll position, while a fresh visit starts small.
import { useEffect, useRef, useState } from "preact/hooks";

export const WINDOW_STEP = 96; // about four screens of cards on a wide window
const stateKey = "window";

const remembered = (): number => {
  const n = (history.state as { [stateKey]?: unknown } | null)?.[stateKey];
  return typeof n === "number" && n > 0 ? n : WINDOW_STEP;
};

/** `key` identifies the list (the filter query): a new key starts the window over. */
export function useWindowed(key: string, total: number, step = WINDOW_STEP): { limit: number; sentinel: { current: HTMLDivElement | null } } {
  const [limit, setLimit] = useState(remembered);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const seenKey = useRef(key);

  useEffect(() => {
    if (seenKey.current === key) return;
    seenKey.current = key;
    setLimit(step);
  }, [key, step]);

  // Keep the history entry's state in step with the window, so Back comes back to the same size.
  useEffect(() => {
    try {
      history.replaceState({ ...(history.state as object | null), [stateKey]: limit }, "");
    } catch {}
  }, [limit]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || limit >= total) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((n) => Math.min(total, n + step));
      },
      { rootMargin: "1200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [limit, total, step]);

  return { limit: Math.min(limit, total), sentinel };
}
