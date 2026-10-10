// Global keyboard: `/` focuses the search box from anywhere; arrows walk focus between grid cards / list rows
// (`[data-item]`), Enter opens (the items are anchors), `f` toggles the Favorite of the focused item.
import { toggleFavorite } from "./data";

export const SEARCH_ID = "q";
let returnFocus: HTMLElement | null = null;

export function focusSearch() {
  const el = document.getElementById(SEARCH_ID) as HTMLInputElement | null;
  if (!el) return;
  const a = document.activeElement as HTMLElement | null;
  if (a && a !== el && a !== document.body) returnFocus = a;
  el.focus();
  el.select();
}

/** Esc: give focus back to where `/` came from, else just leave the box. */
export function releaseSearch() {
  const el = document.getElementById(SEARCH_ID) as HTMLInputElement | null;
  const player = document.querySelector<HTMLElement>("[data-player]"); // on the Now playing screen Esc always lands on the Player
  const back = player ?? (returnFocus && document.contains(returnFocus) ? returnFocus : null);
  returnFocus = null;
  if (back) back.focus({ preventScroll: true });
  else el?.blur();
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

function items(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-item]")];
}

/** The item in the next/previous visual row whose centre is nearest horizontally. */
function vertical(all: HTMLElement[], cur: HTMLElement, dir: 1 | -1): HTMLElement | null {
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const rows = new Map<number, HTMLElement[]>();
  for (const el of all) {
    const b = el.getBoundingClientRect();
    if (dir === 1 ? b.top > r.top + 4 : b.top < r.top - 4) {
      const k = Math.round(b.top);
      (rows.get(k) ?? rows.set(k, []).get(k)!).push(el);
    }
  }
  if (!rows.size) return null;
  const keys = [...rows.keys()].sort((a, b) => (dir === 1 ? a - b : b - a));
  const cands = rows.get(keys[0]!)!;
  let best = cands[0]!;
  let bd = Infinity;
  for (const el of cands) {
    const b = el.getBoundingClientRect();
    const d = Math.abs(b.left + b.width / 2 - cx);
    if (d < bd) {
      bd = d;
      best = el;
    }
  }
  return best;
}

export function installKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/" && !isTyping(e.target)) {
      e.preventDefault();
      focusSearch();
      return;
    }
    if (isTyping(e.target)) return;
    const all = items();
    if (!all.length) return;
    const cur = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-item]") ?? null;
    const move = (to: HTMLElement | null | undefined) => {
      if (to) {
        e.preventDefault();
        to.focus();
        to.scrollIntoView({ block: "nearest" });
      }
    };
    const arrows = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"];
    if (arrows.includes(e.key)) {
      if (!cur) return move(all[0]);
      const i = all.indexOf(cur);
      if (e.key === "ArrowRight") move(all[i + 1]);
      else if (e.key === "ArrowLeft") move(all[i - 1]);
      else move(vertical(all, cur, e.key === "ArrowDown" ? 1 : -1));
      // a list (single column) falls out of `vertical` as next/previous
    } else if ((e.key === "f" || e.key === "F") && cur && cur.dataset.favKind) {
      e.preventDefault();
      const kind = cur.dataset.favKind as "video" | "chapter";
      const id = Number(cur.dataset.id);
      const idx = all.indexOf(cur);
      void toggleFavorite(kind, id).then(() => {
        // The item may leave the list (Favorites, or the grid with the Favorites chip on): keep focus nearby.
        setTimeout(() => {
          if (document.activeElement && document.activeElement !== document.body) return;
          const now = items();
          now[Math.min(idx, now.length - 1)]?.focus();
        }, 60);
      });
    }
  });
}
