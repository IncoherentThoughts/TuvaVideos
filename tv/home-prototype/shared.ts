// PROTOTYPE — throwaway (issue #50). Plumbing shared by the three home variants, the Player and Search:
// the API base, the remote-key vocabulary, spatial focus, toasts, card markup and the Library state carried over
// from the browser app's URL (?type=&sort=&dir=&fav=&available=&artist=).
import type { ArtistDto, ChapterDto, FavoriteItem, SearchResponse, SongDto, SongListDto, VideoDto } from "../../src/shared/types";
import { libraryQuery, parseLibrarySearch } from "../../src/shared/libraryView";

/** Packaged on the TV the page is file://, so it talks to serve.ts on the Mac; in the browser it is same-origin. */
export const BASE = location.protocol === "file:" ? "http://192.168.4.83:4412" : "";

async function get<T>(p: string): Promise<T> {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(`${r.status} ${p}`);
  return r.json() as Promise<T>;
}
export const api = {
  videos: () => get<VideoDto[]>("/api/videos"),
  artists: () => get<ArtistDto[]>("/api/artists"),
  songs: () => get<SongListDto[]>("/api/songs"),
  favorites: () => get<FavoriteItem[]>("/api/favorites"),
  song: (id: string) => get<SongDto>(`/api/songs/${id}`),
  chapters: (id: number) => get<ChapterDto[]>(`/api/videos/${id}/chapters`),
  search: (q: string) => get<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&limit=10`),
};

export interface Data {
  videos: VideoDto[];
  artists: ArtistDto[];
  songs: SongListDto[];
  favorites: FavoriteItem[];
  byId: Map<number, VideoDto>;
}

/** Filter and sort state carried over from the browser app's Library URL; written back on change. */
export const lib = parseLibrarySearch(location.search);
export function syncUrl() {
  const p = new URLSearchParams(libraryQuery(lib));
  const cur = new URLSearchParams(location.search);
  for (const k of ["variant", "bar"]) if (cur.get(k)) p.set(k, cur.get(k)!);
  const s = p.toString().replace(/%2C/g, ",");
  history.replaceState(null, "", location.pathname + (s ? `?${s}` : ""));
}

// ---- the Playing-from list: what < > step through ----
export interface From {
  label: string;
  ids: number[];
}
export function stepFrom(from: From, id: number, dir: 1 | -1, playable: (id: number) => boolean): number | null {
  const n = from.ids.length;
  if (n < 2) return null;
  const i = Math.max(0, from.ids.indexOf(id));
  for (let k = 1; k < n; k++) {
    const j = (((i + dir * k) % n) + n) % n;
    if (playable(from.ids[j]!)) return from.ids[j]!;
  }
  return null;
}

// ---- keys: the remote's buttons as one vocabulary; browser keys map onto them ----
export type Key =
  | "up" | "down" | "left" | "right" | "enter" | "back"
  | "red" | "green" | "yellow" | "blue"
  | "play" | "pause" | "playpause" | "stop" | "rew" | "ff" | "prev" | "next" | "chup" | "chdown" | "info"
  | "random" | "search" | "variant" | "state" | "lyrics" | "script" | "strip" | "char";
export interface KeyEv {
  key: Key;
  char?: string;
  raw: KeyboardEvent;
}
const TIZEN: Record<number, Key> = {
  10009: "back", 403: "red", 404: "green", 405: "yellow", 406: "blue", 415: "play", 19: "pause", 10252: "playpause",
  413: "stop", 412: "rew", 417: "ff", 10232: "prev", 10233: "next", 427: "chup", 428: "chdown", 457: "info",
};
const BROWSER: Record<string, Key> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "enter", Backspace: "back", Escape: "back",
  PageUp: "chup", PageDown: "chdown", MediaPlayPause: "playpause", MediaTrackNext: "next", MediaTrackPrevious: "prev", " ": "playpause",
  r: "random", "/": "search", v: "variant", i: "state", y: "lyrics", s: "script", c: "strip", "<": "prev", ">": "next", ",": "prev", ".": "next",
  "1": "red", "2": "green", "3": "yellow", "4": "blue",
};
export function toKey(e: KeyboardEvent, typing = false): KeyEv | null {
  if (TIZEN[e.keyCode]) return { key: TIZEN[e.keyCode]!, raw: e };
  if (typing && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) return { key: "char", char: e.key, raw: e };
  const k = BROWSER[e.key];
  return k ? { key: k, raw: e } : null;
}
export function registerTizenKeys() {
  const t = (window as any).tizen;
  if (!t?.tvinputdevice) return;
  for (const n of ["ColorF0Red", "ColorF1Green", "ColorF2Yellow", "ColorF3Blue", "MediaPlay", "MediaPause", "MediaPlayPause", "MediaStop", "MediaRewind", "MediaFastForward", "MediaTrackPrevious", "MediaTrackNext", "ChannelUp", "ChannelDown", "Info"]) {
    try { t.tvinputdevice.registerKey(n); } catch {}
  }
}
export function exitApp() {
  const t = (window as any).tizen;
  if (t?.application) t.application.getCurrentApplication().exit();
  else toast("Back at the top: the TV app would exit here");
}

// ---- spatial focus: one focused [data-f] element; arrows pick the next one by geometry ----
// Fast paths: inside [data-group][data-cols=N] (a grid) and [data-linear="h"|"v"] (a rail or a list) the next element is
// found by index; at an edge, or with no fast path, the nearest element in that direction wins.
let focused: HTMLElement | null = null;
export const getFocused = () => focused;
export function focus(el: HTMLElement | null, scroll = true) {
  if (focused === el) return;
  focused?.classList.remove("f");
  focused = el;
  if (!el) return;
  el.classList.add("f");
  if (scroll) reveal(el);
  el.dispatchEvent(new CustomEvent("tvfocus", { bubbles: true }));
}
export function stageScale(): number {
  const m = getComputedStyle(document.getElementById("tv")!).transform.match(/matrix\(([^,]+)/);
  return m ? Number(m[1]) : 1;
}
/** Scroll every scrolling ancestor so the element sits centred on that ancestor's scroll axis. */
export function reveal(el: HTMLElement) {
  const s = stageScale();
  let p = el.parentElement;
  while (p && p.id !== "tv") {
    const cs = getComputedStyle(p);
    const sy = /(auto|scroll|hidden)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1;
    const sx = /(auto|scroll|hidden)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1;
    if (sy || sx) {
      const pr = p.getBoundingClientRect(), er = el.getBoundingClientRect();
      if (sy) p.scrollTop += (er.top + er.height / 2 - (pr.top + pr.height / 2)) / s;
      if (sx) p.scrollLeft += (er.left + er.width / 2 - (pr.left + pr.width / 2)) / s;
    }
    p = p.parentElement;
  }
}
export function focusables(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>("[data-f]")].filter((e) => e.offsetParent !== null);
}
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > 0;

export function moveFocus(scope: ParentNode, dir: "up" | "down" | "left" | "right"): HTMLElement | null {
  const cur = focused && scope.contains(focused) ? focused : null;
  if (!cur) {
    const f = focusables(scope)[0] ?? null;
    focus(f);
    return f;
  }
  const group = cur.closest<HTMLElement>("[data-group]");
  if (group) {
    const items = focusables(group);
    const i = items.indexOf(cur);
    const cols = Number(group.dataset.cols || 0);
    const lin = group.dataset.linear;
    let j = -1;
    if (cols) {
      if (dir === "left" && i % cols > 0) j = i - 1;
      else if (dir === "right" && i % cols < cols - 1) j = i + 1;
      else if (dir === "up") j = i - cols;
      else if (dir === "down") {
        const lastRowStart = items.length - (items.length % cols || cols);
        j = i >= lastRowStart ? -1 : Math.min(i + cols, items.length - 1);
      }
    } else if (lin === "h") {
      if (dir === "left") j = i - 1;
      else if (dir === "right") j = i + 1;
    } else if (lin === "v") {
      if (dir === "up") j = i - 1;
      else if (dir === "down") j = i + 1;
    }
    if (j >= 0 && j < items.length) {
      focus(items[j]!);
      return items[j]!;
    }
    // the end of a rail: stay (a rail never leaves sideways); every other edge falls through to the spatial search
    if (lin === "h" && (dir === "left" || dir === "right")) return null;
  }
  // spatial: nearest element outside the current group in that direction
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const el of focusables(scope)) {
    if (el === cur || (group && group.contains(el))) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
    let primary: number, secondary: number;
    if (dir === "left" || dir === "right") {
      primary = dir === "right" ? dx : -dx;
      secondary = Math.abs(dy) + (overlap(a.top, a.bottom, b.top, b.bottom) ? 0 : 1e4);
    } else {
      primary = dir === "down" ? dy : -dy;
      secondary = Math.abs(dx) + (overlap(a.left, a.right, b.left, b.right) ? 0 : 1e4);
    }
    if (primary <= 1) continue;
    if (!inView(el)) secondary += 5e3;
    const score = primary + secondary * 2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (best) focus(best);
  return best;
}
function inView(el: HTMLElement): boolean {
  let p = el.parentElement;
  while (p && p.id !== "tv") {
    const cs = getComputedStyle(p);
    if (/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX)) {
      const pr = p.getBoundingClientRect(), er = el.getBoundingClientRect();
      if (er.right < pr.left || er.left > pr.right || er.bottom < pr.top || er.top > pr.bottom) return false;
    }
    p = p.parentElement;
  }
  return true;
}

// ---- small UI helpers ----
export function toast(msg: string, ms = 2400) {
  const t = document.getElementById("toast")! as HTMLElement & { _t?: ReturnType<typeof setTimeout> };
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("on"), ms);
}
export const fmtTime = (s: number | null | undefined) => {
  if (s == null || !isFinite(s)) return "–:––";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + ":" + String(x).padStart(2, "0");
};
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const TYPE_COLOR: Record<string, string> = { song: "var(--t1)", concert: "var(--t3)", interview: "var(--t5)", other: "var(--t8)" };
export function artistColor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(--t${(h % 8) + 1})`;
}
export const poster = (v: VideoDto | undefined | null) => (v?.thumbnail ? `${BASE}${v.thumbnail.poster}` : "");
export const AV_COLOR = (v: VideoDto) => (v.availability === "local" ? "var(--t4)" : v.availability === "external" ? "var(--t6)" : "var(--fg3)");

export function tagsHtml(v: VideoDto, max = 2): string {
  const t = [`<span class="tag" style="--c:${TYPE_COLOR[v.type]}">${v.type}</span>`];
  for (const a of v.artists.slice(0, max)) t.push(`<span class="tag" style="--c:${artistColor(a.name)}">${esc(a.name)}</span>`);
  if (v.song?.name) t.push(`<span class="tag${v.songSuggested ? " sug" : ""}" style="--c:var(--accent)">♪ ${esc(v.song.name)}</span>`);
  return t.join("");
}
/** A poster card: Thumbnail with duration, resume progress and favorite star; title; tags. */
export function cardHtml(v: VideoDto, attrs = "", opts: { sub?: string } = {}): string {
  const pct = v.resumeS && v.durationS ? Math.round((100 * v.resumeS) / v.durationS) : 0;
  return `<div class="card" data-f data-video="${v.id}" ${attrs}>
  <div class="po" style="--av:${AV_COLOR(v)}"><img loading="lazy" src="${poster(v)}" alt=""><span class="dur">${fmtTime(v.durationS)}</span>${pct ? `<span class="prog" style="width:${pct}%"></span>` : ""}${v.favoritedAt ? '<span class="fav">★</span>' : ""}</div>
  <div class="ttl">${esc(v.title)}</div>
  ${opts.sub ? `<div class="sub">${opts.sub}</div>` : `<div class="tags">${tagsHtml(v)}</div>`}
</div>`;
}
export function artistTileHtml(a: ArtistDto, data: Data, attrs = ""): string {
  const v = a.posterVideoId ? data.byId.get(a.posterVideoId) : undefined;
  return `<div class="card art" data-f data-artist="${esc(a.name)}" ${attrs}>
  <div class="po round"><img loading="lazy" src="${poster(v)}" alt=""></div>
  <div class="ttl">${esc(a.name)}${a.local ? ' <span class="loc">local</span>' : ""}</div>
  <div class="sub">${a.videoCount} Video${a.videoCount === 1 ? "" : "s"}</div>
</div>`;
}
export function songTileHtml(s: SongListDto, data: Data, attrs = ""): string {
  const v = s.posterVideoId ? data.byId.get(s.posterVideoId) : undefined;
  return `<div class="card song" data-f data-song="${s.id}" ${attrs}>
  <div class="po"><img loading="lazy" src="${poster(v)}" alt="">${s.versionCount ? '<span class="lyr">lyrics</span>' : ""}</div>
  <div class="ttl">${esc(s.name)}${s.local ? ' <span class="loc">local</span>' : ""}</div>
  <div class="sub">${s.englishName ? `<span class="en">${esc(s.englishName)}</span> · ` : ""}${s.videoCount} Video${s.videoCount === 1 ? "" : "s"}${s.chapterCount ? ` · ${s.chapterCount} Chapter${s.chapterCount === 1 ? "" : "s"}` : ""}</div>
</div>`;
}

// ---- screens ----
export interface Screen {
  name: string;
  el: HTMLElement;
  hints: string;
  /** True when the key was consumed. */
  onKey(k: KeyEv): boolean;
  /** Back pressed and not consumed by onKey: true when handled here, false to let the app pop the screen. */
  onBack(): boolean;
  onShow?(): void;
  /** Popped: stop playback, drop timers. */
  dispose?(): void;
  state(): Record<string, unknown>;
}
export interface Ctx {
  data: Data;
  push(s: Screen): void;
  pop(): void;
  play(videoId: number, from: From, opts?: { t?: number | null; lyricsSong?: string | null }): void;
  playSong(songId: string): void;
  search(): void;
  random(): void;
  /** The home variant's own way of showing one Artist's Videos. */
  openArtist(name: string): void;
}
