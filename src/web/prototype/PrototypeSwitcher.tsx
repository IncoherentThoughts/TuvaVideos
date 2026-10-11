// PROTOTYPE — throwaway. The floating bottom bar that cycles `?variant=` on the current route (← → keys too).
import { useEffect } from "preact/hooks";
import { navigate } from "../router";

export function readVariant(keys: string[]): string {
  const v = new URLSearchParams(location.search).get("variant");
  return v && keys.includes(v) ? v : keys[0]!;
}

export function setVariant(v: string) {
  const q = new URLSearchParams(location.search);
  q.set("variant", v);
  navigate(`${location.pathname}?${q}`, { replace: true });
}

export function PrototypeSwitcher({ variants, current }: { variants: { key: string; name: string }[]; current: string }) {
  const i = Math.max(0, variants.findIndex((v) => v.key === current));
  const go = (d: 1 | -1) => setVariant(variants[(i + d + variants.length) % variants.length]!.key);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest("[data-player]"))) return;
      if (e.key === "ArrowLeft") (e.preventDefault(), go(-1));
      if (e.key === "ArrowRight") (e.preventDefault(), go(1));
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  });
  return (
    <div class="proto-bar" role="toolbar" aria-label="Prototype variants">
      <button onClick={() => go(-1)} aria-label="Previous variant">‹</button>
      <span>PROTOTYPE · <b>{current}</b> — {variants[i]!.name}</span>
      <button onClick={() => go(1)} aria-label="Next variant">›</button>
    </div>
  );
}
