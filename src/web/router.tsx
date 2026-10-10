// Hand-rolled history routing (spec 9): `/`, `/play/:videoId[?t=]`, `/favorites`, `/artists`. Filters and sort live in
// the query string. No router library.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";

export interface Loc {
  path: string;
  search: string;
}

const EVT = "tuva:navigate";
const read = (): Loc => ({ path: location.pathname, search: location.search });

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(EVT));
  if (!opts.replace) window.scrollTo(0, 0);
}

export function useLocation(): Loc {
  const [loc, setLoc] = useState<Loc>(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener("popstate", on);
    window.addEventListener(EVT, on);
    return () => {
      window.removeEventListener("popstate", on);
      window.removeEventListener(EVT, on);
    };
  }, []);
  return loc;
}

export type Route =
  | { name: "library" }
  | { name: "play"; videoId: number; t: number | null; lyrics: string | null; lyricsVersion: string | null }
  | { name: "lyrics"; songId: string }
  | { name: "favorites" }
  | { name: "artists" }
  | { name: "notfound" };

export function matchRoute(loc: Loc): Route {
  const p = loc.path.replace(/\/+$/, "") || "/";
  if (p === "/") return { name: "library" };
  if (p === "/favorites") return { name: "favorites" };
  if (p === "/artists") return { name: "artists" };
  const m = p.match(/^\/play\/(\d+)$/);
  if (m) {
    const q = new URLSearchParams(loc.search);
    const t = q.get("t");
    const n = t == null ? NaN : Number(t);
    return { name: "play", videoId: Number(m[1]), t: Number.isFinite(n) && n >= 0 ? n : null, lyrics: q.get("lyrics") || null, lyricsVersion: q.get("lv") || null };
  }
  const l = p.match(/^\/lyrics\/([0-9a-fA-F-]+)$/);
  if (l) return { name: "lyrics", songId: l[1]! };
  return { name: "notfound" };
}

export const playHref = (videoId: number, t?: number | null, lyrics?: { songId: string; versionId?: string | null } | null) => {
  const q: string[] = [];
  if (t != null && t > 0) q.push(`t=${+t.toFixed(2)}`);
  if (lyrics) q.push(`lyrics=${lyrics.songId}`, ...(lyrics.versionId ? [`lv=${lyrics.versionId}`] : []));
  return `/play/${videoId}${q.length ? `?${q.join("&")}` : ""}`;
};

/** An anchor that navigates in-page on a plain left click and stays a real link otherwise. */
export function Link(props: { href: string; class?: string; children?: ComponentChildren; [k: string]: unknown }) {
  const { href, children, ...rest } = props;
  return (
    <a
      {...(rest as object)}
      href={href}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
