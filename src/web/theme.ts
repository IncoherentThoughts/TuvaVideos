// Themes (docs/themes.md): which palette the app wears. `wall` is the stylesheet's own look (docs/design-direction.md)
// and needs no file; any other id is `src/web/themes/<id>/theme.css`, served at /themes/<id>/theme.css, linked while it
// is active, with `data-theme="<id>"` on <html> for its selectors. index.html applies the stored choice before first
// paint with the same rules; this module owns changing it. `?theme=<id>` in the URL picks one too (and remembers it).
import { useEffect, useState } from "preact/hooks";

export const THEME_KEY = "tuva.theme";
export const DEFAULT_THEME = "wall";
const LINK_ID = "theme-css";
const EVT = "tuva:theme";

/** The hand-kept registry; a generator will write it once a second theme exists. */
export const THEMES: readonly { id: string; label: string }[] = [
  { id: DEFAULT_THEME, label: "Wall" },
  { id: "lawson-night", label: "Lawson Night" },
];

const known = (id: string | null | undefined): id is string => !!id && THEMES.some((t) => t.id === id);

export function currentTheme(): string {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return known(t) ? t : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(id: string) {
  if (!known(id)) id = DEFAULT_THEME;
  const html = document.documentElement;
  const link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (id === DEFAULT_THEME) {
    delete html.dataset.theme;
    link?.remove();
  } else {
    html.dataset.theme = id;
    const href = `/themes/${id}/theme.css`;
    if (link) link.href = href;
    else {
      const l = document.createElement("link");
      l.id = LINK_ID;
      l.rel = "stylesheet";
      l.href = href;
      document.head.appendChild(l);
    }
  }
  try {
    if (id === DEFAULT_THEME) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, id);
  } catch {}
  window.dispatchEvent(new Event(EVT));
}

/** `?theme=<id>` on any URL applies that theme and drops the parameter. */
export function applyThemeFromUrl() {
  const q = new URLSearchParams(location.search);
  const t = q.get("theme");
  if (t == null) return;
  if (known(t)) applyTheme(t);
  q.delete("theme");
  const s = q.toString();
  history.replaceState(null, "", location.pathname + (s ? `?${s}` : ""));
}

export function useTheme(): [string, (id: string) => void] {
  const [t, setT] = useState(currentTheme);
  useEffect(() => {
    const on = () => setT(currentTheme());
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  return [t, applyTheme];
}
