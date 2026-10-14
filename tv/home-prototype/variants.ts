// PROTOTYPE — throwaway (issue #50). Three structurally different TV home screens, switched with ?variant=A|B|C:
//   A "Tabs and grid"   — the browser app transposed: top tabs, a filter/sort chip row, a full-bleed 6-column poster grid.
//   B "Rails"           — a streaming-service home: horizontal rails (Continue watching, Library, Favorites, Recently added,
//                         Concerts, Artists, Songs with lyrics), each ending in a "See all" tile that opens a full grid.
//   C "List and preview" — a left nav rail, a dense list in the middle and a big preview pane on the right (Plex / Apple TV).
// All three share the Player, Search and the Library state (filters and sort) carried over from the browser app's URL.
import type { ArtistDto, FavoriteItem, SongListDto, VideoDto } from "../../src/shared/types";
import { TYPES } from "../../src/shared/filters";
import { SORTS, defaultDir, defaultLibraryState, hasArtistNamed, sortVideos, viewVideos, type SortKey } from "../../src/shared/libraryView";
import {
  AV_COLOR, BASE, type Ctx, type From, type Screen, artistColor, artistTileHtml, cardHtml, esc, fmtTime, focus, focusables, getFocused,
  type KeyEv, lib, moveFocus, poster, songTileHtml, syncUrl, tagsHtml, toast,
} from "./shared";

export interface Home extends Screen {
  variant: string;
  title: string;
  openArtist(name: string): void;
}

export const HINTS_BROWSE = "↑↓←→ move · Enter open · Back up a level · r Random · / Search · v (red) variant · i (info) state";
const SORT_LABEL: Record<SortKey, string> = { views: "most watched", added: "date added", title: "title", duration: "duration", played: "last played" };
const isArrow = (k: KeyEv): k is KeyEv & { key: "up" | "down" | "left" | "right" } => k.key === "up" || k.key === "down" || k.key === "left" || k.key === "right";

export const idsIn = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>("[data-video]")].map((e) => Number(e.dataset.video));

/** What Enter does on any focusable: play a Video (from `from`), open an Artist, play a Song's first Video, Search, Random. */
export function activate(ctx: Ctx, el: HTMLElement, from: () => From): boolean {
  const d = el.dataset;
  if (d.video) ctx.play(Number(d.video), from(), { t: d.t ? Number(d.t) : null });
  else if (d.artist) ctx.openArtist(d.artist);
  else if (d.song) ctx.browse("song", d.song); // a Song opens the grid of its Videos
  else if (d.act === "search") ctx.search();
  else if (d.act === "random") ctx.random();
  else return false;
  return true;
}

function favCard(f: FavoriteItem): string {
  if (f.kind === "video") return cardHtml(f.video);
  return cardHtml(f.video, `data-t="${f.chapter.startS}"`, { sub: `<span class="chap">▸ ${fmtTime(f.chapter.startS)} · ${esc(f.chapter.title)}</span>` });
}
export function describeLib(): string {
  const bits = [];
  if (lib.artist) bits.push(`Artist ${lib.artist}`);
  if (lib.types.length) bits.push(lib.types.join(", "));
  if (lib.fav) bits.push("favorites");
  if (lib.availableOnly) bits.push("available");
  bits.push(`${SORT_LABEL[lib.sort]} ${lib.dir === defaultDir(lib.sort) ? "" : lib.dir === "asc" ? "↑" : "↓"}`.trim());
  return bits.join(" · ");
}

// ---- the chip row: Enter cycles a chip's value; the state is the browser app's LibraryState ----
interface Chip { key: string; label: () => string; cycle: () => void }
const libChips = (): Chip[] => [
  { key: "type", label: () => `Type: ${lib.types[0] ?? "all"}`, cycle: () => { const order: (string | null)[] = [null, ...TYPES]; const n = order[(order.indexOf(lib.types[0] ?? null) + 1) % order.length]; lib.types = n ? [n as (typeof TYPES)[number]] : []; } },
  { key: "sort", label: () => `Sort: ${SORT_LABEL[lib.sort]}`, cycle: () => { lib.sort = SORTS[(SORTS.indexOf(lib.sort) + 1) % SORTS.length]!; lib.dir = defaultDir(lib.sort); } },
  { key: "dir", label: () => (lib.dir === "asc" ? "↑ ascending" : "↓ descending"), cycle: () => { lib.dir = lib.dir === "asc" ? "desc" : "asc"; } },
  { key: "fav", label: () => (lib.fav ? "★ Favorites only" : "☆ Favorites: all"), cycle: () => { lib.fav = !lib.fav; } },
];
const chipsHtml = (chips: Chip[]) =>
  `<div class="chips" data-group="chips" data-linear="h">${chips.map((c) => `<button class="chip${c.key === "type" && lib.types.length || c.key === "fav" && lib.fav ? " on" : ""}" data-f data-chip="${c.key}">${c.label()}</button>`).join("")}${lib.artist ? `<button class="chip on" data-f data-chip="artist">Artist: ${esc(lib.artist)} ×</button>` : ""}</div>`;
function cycleChip(chips: Chip[], key: string) {
  if (key === "artist") lib.artist = null;
  else chips.find((c) => c.key === key)?.cycle();
  syncUrl();
}

// ---- a full grid as its own screen (Back pops it): "See all", an Artist's Videos, every Song, the side pane's tabs ----
export function gridScreen(ctx: Ctx, title: string, body: () => string, fromLabel: string, opts: { chips?: boolean } = {}): Screen {
  const el = document.createElement("div");
  el.className = "screen gs";
  const chips = opts.chips ? libChips() : null;
  const render = () => {
    el.innerHTML = `<header class="gs-top"><img class="brand" src="${BASE}/olchey.svg" alt=""><h1>${esc(title)}</h1><span class="sp"></span><span class="count"></span></header>${chips ? chipsHtml(chips) : ""}<main class="grid" data-group="g" data-cols="6">${body()}</main>`;
    el.querySelector(".count")!.textContent = `${el.querySelectorAll(".card").length} items${chips ? ` · ${describeLib()}` : ""}`;
  };
  render();
  const grid = () => el.querySelector<HTMLElement>(".grid")!;
  let last: HTMLElement | null = null;
  return {
    name: `grid: ${title}`, el, hints: HINTS_BROWSE,
    onKey(k) {
      if (isArrow(k)) { moveFocus(el, k.key); last = getFocused(); return true; }
      if (k.key !== "enter") return false;
      const f = getFocused();
      if (!f) return false;
      if (f.dataset.chip && chips) { cycleChip(chips, f.dataset.chip); render(); focus(el.querySelector<HTMLElement>(`[data-chip="${f.dataset.chip}"]`) ?? focusables(el)[0]!); return true; }
      return activate(ctx, f, () => ({ label: fromLabel, ids: idsIn(grid()) }));
    },
    onBack: () => false,
    onShow() { focus(last ?? focusables(grid())[0] ?? null); },
    state: () => ({ title, focused: last?.dataset }),
  };
}

// =====================================================================================================================
// Variant A — Tabs and grid
// =====================================================================================================================
type Tab = "library" | "favorites" | "artists" | "songs";
const TABS: Tab[] = ["library", "favorites", "artists", "songs"];
const TAB_LABEL: Record<Tab, string> = { library: "Library", favorites: "Favorites", artists: "Artists", songs: "Songs" };

export function variantA(ctx: Ctx): Home {
  const { data } = ctx;
  const el = document.createElement("div");
  el.className = "screen va";
  let tab: Tab = "library";
  const lastFocus: Partial<Record<Tab, HTMLElement | null>> = {};
  const chips = libChips();

  const body = (): string => {
    if (tab === "library") return viewVideos(data.videos, lib).map((v) => cardHtml(v)).join("");
    if (tab === "favorites") return data.favorites.map(favCard).join("");
    if (tab === "artists") return data.artists.map((a) => artistTileHtml(a, data)).join("");
    return data.songs.map((s) => songTileHtml(s, data)).join("");
  };
  const countLine = (): string => {
    if (tab === "library") return `${viewVideos(data.videos, lib).length} Videos · ${describeLib()}`;
    if (tab === "favorites") return `${data.favorites.length} Favorites · newest first`;
    if (tab === "artists") return `${data.artists.length} Artists · by name`;
    return `${data.songs.length} Songs · by name`;
  };
  const render = () => {
    el.innerHTML = `<header class="va-top" data-group="top" data-linear="h">
  <img class="brand" src="${BASE}/olchey.svg" alt="">
  ${TABS.map((t) => `<button class="tabb${t === tab ? " on" : ""}" data-f data-tab="${t}">${TAB_LABEL[t]}</button>`).join("")}
  <span class="sp"></span>
  <button class="tabb ico" data-f data-act="search">⌕ Search</button>
  <button class="tabb ico" data-f data-act="random">⤭ Random</button>
</header>
${tab === "library" ? chipsHtml(chips) : ""}
<div class="count">${countLine()}</div>
<main class="grid" data-group="g" data-cols="6">${body()}</main>`;
  };
  render();
  const grid = () => el.querySelector<HTMLElement>(".grid")!;
  const tabButton = (t: Tab) => el.querySelector<HTMLElement>(`[data-tab="${t}"]`);
  const from = (): From => ({ label: tab === "library" ? "Library" : TAB_LABEL[tab], ids: idsIn(grid()) });

  return {
    variant: "A", title: "Tabs and grid", name: "home A", el, hints: HINTS_BROWSE,
    onKey(k) {
      if (isArrow(k)) { moveFocus(el, k.key); lastFocus[tab] = getFocused(); return true; }
      if (k.key !== "enter") return false;
      const f = getFocused();
      if (!f) return false;
      if (f.dataset.tab) { tab = f.dataset.tab as Tab; render(); focus(tabButton(tab)); return true; }
      if (f.dataset.chip) { cycleChip(chips, f.dataset.chip); render(); focus(el.querySelector<HTMLElement>(`[data-chip="${f.dataset.chip}"]`) ?? focusables(el)[0]!); return true; }
      return activate(ctx, f, from);
    },
    onBack() {
      const f = getFocused();
      if (f && !f.closest(".va-top")) {
        if (lib.artist && tab === "library") { lib.artist = null; syncUrl(); tab = "artists"; render(); focus(lastFocus.artists ?? tabButton("artists")); return true; }
        focus(tabButton(tab));
        return true;
      }
      return false;
    },
    onShow() { focus(lastFocus[tab] ?? tabButton(tab)); },
    openArtist(name) { lib.artist = name; syncUrl(); tab = "library"; render(); focus(focusables(grid())[0] ?? tabButton(tab)); },
    state: () => ({ tab, lib: { ...lib }, focused: getFocused()?.dataset }),
  };
}

// =====================================================================================================================
// Variant B — Rails (the chosen one). Back (or Left at the start of a rail) opens a side pane with Library, Favorites,
// Artists and Songs, each a full grid; Back inside the pane exits the app.
// =====================================================================================================================
export function variantB(ctx: Ctx): Home {
  const { data } = ctx;
  const el = document.createElement("div");
  el.className = "screen vb";
  const byViews = (vs: VideoDto[]) => sortVideos(vs, { ...defaultLibraryState() });
  const continueWatching = data.videos.filter((v) => v.resumeS && v.resumeS > 0).sort((a, b) => (b.lastPlayedAt ?? "").localeCompare(a.lastPlayedAt ?? ""));
  const libraryAll = () => viewVideos(data.videos, lib);
  const recent = sortVideos(data.videos, { ...defaultLibraryState(), sort: "added" });
  const concerts = byViews(data.videos.filter((v) => v.type === "concert"));
  const artists = [...data.artists].sort((a, b) => b.videoCount - a.videoCount);
  const songsWithLyrics = data.songs.filter((s) => s.versionCount > 0).sort((a, b) => b.videoCount - a.videoCount);

  // the side pane's four grids (also "See all" targets)
  const grids = {
    library: () => gridScreen(ctx, "Library", () => libraryAll().map((v) => cardHtml(v)).join(""), "Library", { chips: true }),
    favorites: () => gridScreen(ctx, "Favorites", () => data.favorites.map(favCard).join(""), "Favorites"),
    artists: () => gridScreen(ctx, "Artists", () => data.artists.map((a) => artistTileHtml(a, data)).join(""), "Artists"),
    songs: () => gridScreen(ctx, "Songs", () => data.songs.map((s) => songTileHtml(s, data)).join(""), "Songs"),
  };

  interface Rail { key: string; title: string; small?: string; tiles: () => string; more?: () => Screen; ids: () => number[] }
  const moreTile = (key: string, n: number) => `<div class="card more" data-f data-more="${key}"><div class="po"><span>See all<br><b>${n}</b></span></div></div>`;
  const videoRail = (key: string, title: string, all: () => VideoDto[], more: () => Screen, n = 20, small?: string): Rail => ({
    key, title, small,
    tiles: () => { const vs = all(); return vs.slice(0, n).map((v) => cardHtml(v)).join("") + (vs.length > n ? moreTile(key, vs.length) : ""); },
    more, ids: () => all().map((v) => v.id),
  });
  const rails: Rail[] = [
    { key: "favorites", title: "Favorites", tiles: () => data.favorites.slice(0, 20).map(favCard).join("") + (data.favorites.length > 20 ? moreTile("favorites", data.favorites.length) : ""), more: grids.favorites, ids: () => data.favorites.map((f) => f.video.id) },
    videoRail("library", "Library", libraryAll, grids.library, 20, describeLib()),
    { key: "artists", title: "Artists", tiles: () => artists.slice(0, 24).map((a) => artistTileHtml(a, data)).join("") + moreTile("artists", artists.length), more: grids.artists, ids: () => [] },
    { key: "continue", title: "Continue watching", tiles: () => continueWatching.slice(0, 20).map((v) => cardHtml(v)).join(""), ids: () => continueWatching.map((v) => v.id) },
    videoRail("recent", "Recently added", () => recent, () => gridScreen(ctx, "Recently added", () => recent.map((v) => cardHtml(v)).join(""), "Recently added")),
    videoRail("concerts", "Concerts", () => concerts, () => gridScreen(ctx, "Concerts", () => concerts.map((v) => cardHtml(v)).join(""), "Concerts")),
    { key: "songs", title: "Songs with lyrics", tiles: () => songsWithLyrics.slice(0, 24).map((s) => songTileHtml(s, data)).join("") + moreTile("songs", songsWithLyrics.length), more: () => gridScreen(ctx, "Songs with lyrics", () => songsWithLyrics.map((s) => songTileHtml(s, data)).join(""), "Songs"), ids: () => [] },
  ].filter((r) => r.key !== "continue" || continueWatching.length);

  const PANE: { key: keyof typeof grids; label: string }[] = [{ key: "library", label: "Library" }, { key: "favorites", label: "Favorites" }, { key: "artists", label: "Artists" }, { key: "songs", label: "Songs" }];
  const render = () => {
    el.innerHTML = `<header class="vb-top" data-group="top" data-linear="h">
  <img class="brand" src="${BASE}/olchey.svg" alt=""><span class="word">TuvaVideos</span>
  <span class="sp"></span>
  <button class="tabb ico" data-f data-act="search">⌕ Search</button>
  <button class="tabb ico" data-f data-act="random">⤭ Random</button>
</header>
<main class="rails">${rails.map((r) => `<section class="rail" data-rail="${r.key}"><h2>${esc(r.title)}${r.small ? ` <small>${esc(r.small)}</small>` : ""}</h2><div class="tiles" data-group="rail" data-linear="h">${r.tiles()}</div></section>`).join("")}</main>
<nav class="vb-pane" data-group="pane" data-linear="v" hidden>
  <img class="brand" src="${BASE}/olchey.svg" alt="">
  ${PANE.map((p) => `<button class="navb" data-f data-pane="${p.key}">${p.label}</button>`).join("")}
  <button class="navb" data-f data-act="search">Search</button>
  <button class="navb" data-f data-act="random">Random</button>
</nav>`;
  };
  render();
  const pane = () => el.querySelector<HTMLElement>(".vb-pane")!;
  let last: HTMLElement | null = null;
  let paneOpen = false;
  const openPane = () => { paneOpen = true; pane().hidden = false; el.classList.add("pane-open"); focus(pane().querySelector<HTMLElement>("[data-f]"), false); };
  const closePane = () => { paneOpen = false; pane().hidden = true; el.classList.remove("pane-open"); focus(last ?? focusables(el.querySelector(".rails")!)[0] ?? null); };
  const railOf = (f: HTMLElement) => rails.find((r) => r.key === f.closest<HTMLElement>(".rail")?.dataset.rail);
  const firstInRail = (f: HTMLElement) => f.closest(".tiles")?.querySelector("[data-f]") === f;
  return {
    variant: "B", title: "Rails", name: "home B", el, hints: HINTS_BROWSE + " · Back / ← at a rail's start: side pane",
    onKey(k) {
      if (paneOpen) {
        if (k.key === "up" || k.key === "down") { moveFocus(pane(), k.key); return true; }
        if (k.key === "right") { closePane(); return true; }
        if (k.key === "enter") {
          const f = getFocused();
          if (f?.dataset.pane) { closePane(); ctx.push(grids[f.dataset.pane as keyof typeof grids]()); return true; }
          if (f) { closePane(); return activate(ctx, f, () => ({ label: "Library", ids: [] })); }
        }
        return false; // Back falls through: the app exits
      }
      if (isArrow(k)) {
        const f = getFocused();
        if (k.key === "left" && f && (firstInRail(f) || f.closest(".vb-top"))) { last = f; openPane(); return true; }
        moveFocus(el, k.key); last = getFocused(); return true;
      }
      if (k.key !== "enter") return false;
      const f = getFocused();
      if (!f) return false;
      if (f.dataset.more) { const r = rails.find((x) => x.key === f.dataset.more); if (r?.more) ctx.push(r.more()); return true; }
      return activate(ctx, f, () => { const r = railOf(f); return { label: r?.title ?? "Library", ids: r && r.ids().length ? r.ids() : idsIn(f.closest(".tiles")!) }; });
    },
    onBack() {
      if (paneOpen) return false;
      last = getFocused();
      openPane();
      return true;
    },
    onShow() { if (paneOpen) closePane(); else focus(last ?? focusables(el.querySelector(".rails")!)[0] ?? null); },
    openArtist(name) {
      const vs = byViews(data.videos.filter((v) => hasArtistNamed(v, name)));
      ctx.push(gridScreen(ctx, name, () => vs.map((v) => cardHtml(v)).join(""), name));
    },
    state: () => ({ pane: paneOpen, rail: last?.closest<HTMLElement>(".rail")?.dataset.rail, focused: getFocused()?.dataset, lib: { ...lib } }),
  };
}

// =====================================================================================================================
// Variant C — List and preview
// =====================================================================================================================
type Section = { kind: "library" } | { kind: "favorites" } | { kind: "artists" } | { kind: "songs" } | { kind: "artist"; name: string };

export function variantC(ctx: Ctx): Home {
  const { data } = ctx;
  const el = document.createElement("div");
  el.className = "screen vc";
  let section: Section = { kind: "library" };
  const chips = libChips();
  const lastRow = new Map<string, HTMLElement | null>();
  const secKey = (s: Section) => (s.kind === "artist" ? `artist:${s.name}` : s.kind);

  const videoRow = (v: VideoDto, attrs = "", title = v.title, sub?: string) => `<div class="row" data-f data-video="${v.id}" ${attrs}>
  <div class="th" style="--av:${AV_COLOR(v)}"><img loading="lazy" src="${poster(v)}" alt=""></div>
  <div class="rt"><div class="t">${esc(title)}${v.favoritedAt ? ' <span class="star">★</span>' : ""}</div><div class="s">${sub ?? tagsHtml(v, 3)}</div></div>
  <span class="d">${fmtTime(v.durationS)}</span></div>`;
  const rows = (): string => {
    switch (section.kind) {
      case "library": return viewVideos(data.videos, lib).map((v) => videoRow(v)).join("");
      case "artist": { const name = section.name; return sortVideos(data.videos.filter((v) => hasArtistNamed(v, name)), defaultLibraryState()).map((v) => videoRow(v)).join(""); }
      case "favorites": return data.favorites.map((f) => f.kind === "video" ? videoRow(f.video) : videoRow(f.video, `data-t="${f.chapter.startS}"`, f.chapter.title, `<span class="chap">Chapter at ${fmtTime(f.chapter.startS)} · ${esc(f.video.title)}</span>`)).join("");
      case "artists": return data.artists.map((a) => `<div class="row" data-f data-artist="${esc(a.name)}" data-aid="${a.id}"><div class="th round"><img loading="lazy" src="${poster(a.posterVideoId ? data.byId.get(a.posterVideoId) : null)}" alt=""></div><div class="rt"><div class="t" style="color:${artistColor(a.name)}">${esc(a.name)}${a.local ? ' <span class="loc">local</span>' : ""}</div><div class="s">${a.videoCount} Video${a.videoCount === 1 ? "" : "s"}</div></div></div>`).join("");
      case "songs": return data.songs.map((s) => `<div class="row" data-f data-song="${s.id}"><div class="th"><img loading="lazy" src="${poster(s.posterVideoId ? data.byId.get(s.posterVideoId) : null)}" alt=""></div><div class="rt"><div class="t">${esc(s.name)}${s.versionCount ? ' <span class="lyr">lyrics</span>' : ""}</div><div class="s">${s.englishName ? `${esc(s.englishName)} · ` : ""}${s.videoCount} Videos${s.chapterCount ? ` · ${s.chapterCount} Chapters` : ""}</div></div></div>`).join("");
    }
  };
  const crumb = () => section.kind === "artist" ? `Artists <span class="dim">›</span> ${esc(section.name)}` : TAB_LABEL[section.kind];
  const NAV: { key: string; label: string; act?: string }[] = [
    { key: "library", label: "Library" }, { key: "favorites", label: "Favorites" }, { key: "artists", label: "Artists" }, { key: "songs", label: "Songs" },
    { key: "search", label: "Search", act: "search" }, { key: "random", label: "Random", act: "random" },
  ];
  const navKey = () => (section.kind === "artist" ? "artists" : section.kind);
  const render = () => {
    el.innerHTML = `<nav class="vc-nav" data-group="nav" data-linear="v">
  <img class="brand" src="${BASE}/olchey.svg" alt="">
  ${NAV.map((n) => `<button class="navb${n.key === navKey() ? " on" : ""}" data-f ${n.act ? `data-act="${n.act}"` : `data-sec="${n.key}"`}>${n.label}</button>`).join("")}
</nav>
<section class="vc-main">
  <div class="vc-head"><h1>${crumb()}</h1>${section.kind === "library" ? chipsHtml(chips) : ""}</div>
  <div class="list" data-group="list" data-linear="v">${rows()}</div>
</section>
<aside class="vc-detail"><div class="empty">Move onto a row to preview it</div></aside>`;
    el.querySelector(".vc-head")!.insertAdjacentHTML("beforeend", `<div class="count">${el.querySelectorAll(".row").length} rows${section.kind === "library" ? ` · ${describeLib()}` : ""}</div>`);
  };
  const showDetail = (f: HTMLElement) => {
    const d = el.querySelector<HTMLElement>(".vc-detail")!;
    const ds = f.dataset;
    if (ds.video) {
      const v = data.byId.get(Number(ds.video))!;
      const ch = ds.t ? Number(ds.t) : null;
      d.innerHTML = `<div class="big" style="--av:${AV_COLOR(v)}"><img src="${poster(v)}" alt=""><span class="dur">${fmtTime(v.durationS)}</span></div>
<h2>${esc(v.title)}</h2>${v.titleLatin ? `<div class="latin">${esc(v.titleLatin)}</div>` : ""}
<div class="tags">${tagsHtml(v, 4)}</div>
<dl>${v.song?.name ? `<dt>Song</dt><dd>${esc(v.song.name)}${v.song.englishName ? ` <span class="dim">${esc(v.song.englishName)}</span>` : ""} · <span class="ok">lyrics</span></dd>` : "<dt>Song</dt><dd class=dim>none · no lyrics</dd>"}
${v.chapterCount ? `<dt>Chapters</dt><dd>${v.chapterCount}</dd>` : ""}
<dt>Copy</dt><dd>${v.width && v.height ? `${v.width}×${v.height}` : "?"} · ${v.copies[0]?.container ?? "?"} ${v.copies[0]?.videoCodec ?? ""}/${v.copies[0]?.audioCodec ?? ""} · ${v.availability ?? "unavailable"}</dd>
${v.resumeS ? `<dt>Resume</dt><dd>${fmtTime(v.resumeS)} of ${fmtTime(v.durationS)}</dd>` : ""}
${ch != null ? `<dt>Opens at</dt><dd>${fmtTime(ch)}</dd>` : ""}
<dt>Watched</dt><dd>${v.viewCount} time${v.viewCount === 1 ? "" : "s"}${v.lastPlayedAt ? ` · last ${v.lastPlayedAt.slice(0, 10)}` : ""}</dd></dl>
<div class="cta">Enter plays${v.song ? " with lyrics beside the video" : ""}</div>`;
    } else if (ds.artist) {
      const vs = sortVideos(data.videos.filter((v) => hasArtistNamed(v, ds.artist!)), defaultLibraryState());
      d.innerHTML = `<div class="big round"><img src="${poster(vs[0])}" alt=""></div><h2 style="color:${artistColor(ds.artist)}">${esc(ds.artist)}</h2>
<dl><dt>Videos</dt><dd>${vs.length}</dd><dt>Most watched</dt><dd>${vs.slice(0, 3).map((v) => esc(v.title)).join("<br>") || "–"}</dd></dl><div class="cta">Enter lists their Videos</div>`;
    } else if (ds.song) {
      const s = data.songs.find((x) => x.id === ds.song)!;
      d.innerHTML = `<div class="big"><img src="${poster(s.posterVideoId ? data.byId.get(s.posterVideoId) : null)}" alt=""></div><h2>${esc(s.name)}</h2>${s.englishName ? `<div class="latin">${esc(s.englishName)}</div>` : ""}
<dl><dt>Lyrics</dt><dd>${s.versionCount ? `${s.versionCount} Version${s.versionCount === 1 ? "" : "s"}` : '<span class="dim">none in the archive</span>'}</dd><dt>Videos</dt><dd>${s.videoCount}</dd><dt>Chapters</dt><dd>${s.chapterCount}</dd></dl>
<div class="cta">Enter plays its newest Video with the lyrics open</div>`;
    } else d.innerHTML = `<div class="empty">${f.textContent}</div>`;
  };
  el.addEventListener("tvfocus", (e) => { const f = e.target as HTMLElement; if (f.classList.contains("row")) { showDetail(f); lastRow.set(secKey(section), f); } });
  render();
  const navButton = () => el.querySelector<HTMLElement>(`[data-sec="${navKey()}"]`);
  const go = (s: Section, focusRow = true) => { section = s; render(); const r = lastRow.get(secKey(s)); focus(focusRow ? r ?? focusables(el.querySelector(".list")!)[0] ?? navButton() : navButton()); };
  const from = (): From => ({ label: section.kind === "artist" ? section.name : TAB_LABEL[section.kind], ids: idsIn(el.querySelector(".list")!) });

  return {
    variant: "C", title: "List and preview", name: "home C", el, hints: HINTS_BROWSE,
    onKey(k) {
      // Left from the list or the chips lands on the current section's nav button, not the geometrically nearest one
      if (k.key === "left" && getFocused() && !getFocused()!.closest(".vc-nav")) { focus(navButton()); return true; }
      if (isArrow(k)) { moveFocus(el, k.key); return true; }
      if (k.key !== "enter") return false;
      const f = getFocused();
      if (!f) return false;
      if (f.dataset.sec) { go({ kind: f.dataset.sec as "library" | "favorites" | "artists" | "songs" }); return true; }
      if (f.dataset.chip) { cycleChip(chips, f.dataset.chip); render(); focus(el.querySelector<HTMLElement>(`[data-chip="${f.dataset.chip}"]`) ?? focusables(el)[0]!); return true; }
      if (f.dataset.artist) { go({ kind: "artist", name: f.dataset.artist }); return true; }
      return activate(ctx, f, from);
    },
    onBack() {
      const f = getFocused();
      if (section.kind === "artist") { go({ kind: "artists" }); return true; }
      if (f && !f.closest(".vc-nav")) { focus(navButton()); return true; }
      return false;
    },
    onShow() { const r = lastRow.get(secKey(section)); focus(r ?? navButton()); if (r) showDetail(r); },
    openArtist(name) { go({ kind: "artist", name }); },
    state: () => ({ section, lib: { ...lib }, focused: getFocused()?.dataset }),
  };
}

export const VARIANTS: Record<string, (ctx: Ctx) => Home> = { A: variantA, B: variantB, C: variantC };
export const VARIANT_KEYS = Object.keys(VARIANTS);
export type { ArtistDto, SongListDto };
export { toast };
