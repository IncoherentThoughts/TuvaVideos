// PROTOTYPE — throwaway (issue #51, on the #50 home prototype). Three variants of the TV Player, switchable via
// ?player=A|B|C and the yellow bar while a Video plays. They disagree about structure, not colour:
//   A "Reader beside"  the video shrinks to make room for a lyrics column (static Reader, numbered, paged); the Chapter
//                      strip is a filmstrip over the bottom; OSD fades; ±10 s seeks.
//   B "Overlay"        the video never shrinks: lyrics float on a scrim over its right third, the Chapters are a vertical
//                      list over its left edge, a Netflix-style bar with the current Chapter and "Next:"; accelerating
//                      seeks (10 → 30 → 60 → 120 s when the key is pressed again within a second).
//   C "Stage"          the video sits in a 1240×697 window; the lyrics column follows an *estimated* current line (the
//                      position inside the Chapter mapped onto the lines; no timings exist) with the translation under
//                      each line; the Chapter cards and the info row are always visible in a band below; Left/Right
//                      move a ghost playhead with a strip frame and commit after a pause (or Enter); Rew/FF jump Chapters.
// Shared in all three: Up = the tag row (Enter opens a grid of that Type / Artist / Song), Down = Chapters, yellow =
// lyrics on/off, blue = Script, Ch▲▼ = page, < > = Playing from, Back closes an overlay first and leaves second.
// Resume is read, never written: the prototype changes nothing in the library.
import type { ChapterDto, SongDto, VideoDto } from "../../src/shared/types";
import type { ScriptKey } from "../../src/shared/lyrics/types";
import { bestCopy } from "../../src/shared/copies";
import { numberedLines } from "../../src/shared/lyrics/normalize";
import { SCRIPTS, effectiveScript, presentScripts } from "../../src/shared/lyrics/scripts";
import { chapterAt, lyricsTarget } from "../../src/shared/lyrics/target";
import { openingVersionIndex } from "../../src/shared/lyrics/trackVersion";
import { startPosition } from "../../src/shared/resume";
import { BASE, type Ctx, type From, type Screen, TYPE_COLOR, api, artistColor, esc, fmtTime, focus, focusables, getFocused, moveFocus, stepFrom, toast } from "./shared";

export type PlayerVariant = "A" | "B" | "C";
export const PLAYER_VARIANTS: Record<PlayerVariant, string> = { A: "Reader beside", B: "Overlay", C: "Stage" };
export const PLAYER_KEYS = Object.keys(PLAYER_VARIANTS) as PlayerVariant[];

let scriptPref: ScriptKey = "cyrillic";

const HINTS: Record<PlayerVariant, string> = {
  A: "A · ←→ ±10 s · Rew/FF ±60 s · Enter pause · ↑ tags · ↓ Chapters (filmstrip) · Ch▲▼ page · y lyrics · s Script · < > prev/next · Back",
  B: "B · ←→ seek, again within 1 s: 10→30→60→120 s · Enter pause · ↑ tags · ↓ Chapter list · Ch▲▼ page · y lyrics · s Script · < > · Back",
  C: "C · ←→ move the ghost ±5 s, Enter or a pause commits · Rew/FF prev/next Chapter · ↑ tags · ↓ Chapter cards · s Script · < > · Back",
};

type Zone = "video" | "tags" | "strip";

export function makePlayer(ctx: Ctx, videoId: number, from: From, opts: { t?: number | null; lyricsSong?: string | null; variant?: PlayerVariant } = {}): Screen {
  const V: PlayerVariant = opts.variant ?? "A";
  const video: VideoDto = ctx.data.byId.get(videoId)!;
  const copy = bestCopy(video.copies);
  const pos = from.ids.indexOf(videoId);
  const tagsHtml = () => {
    const t = [`<span class="tag" data-f data-kind="type" data-value="${video.type}" style="--c:${TYPE_COLOR[video.type]}">${video.type}</span>`];
    for (const a of video.artists) t.push(`<span class="tag" data-f data-kind="artist" data-value="${esc(a.name)}" style="--c:${artistColor(a.name)}">${esc(a.name)}</span>`);
    if (video.song?.name) t.push(`<span class="tag${video.songSuggested ? " sug" : ""}" data-f data-kind="song" data-value="${video.song.id}" data-name="${esc(video.song.name)}" style="--c:var(--accent)">♪ ${esc(video.song.name)}</span>`);
    return t.join("");
  };
  const fromText = `Playing from ${esc(from.label)}${pos >= 0 ? ` · ${pos + 1} of ${from.ids.length}` : ""}`;
  const copyText = copy ? `${copy.container} ${copy.videoCodec}/${copy.audioCodec} ${copy.height ?? "?"}p · ${copy.rootKind}` : "no Copy";

  const el = document.createElement("div");
  el.className = `screen pl pl-${V}`;
  el.innerHTML = {
    A: `<div class="pl-stage">
  <video playsinline></video>
  <div class="pl-osd">
    <div class="t1">${esc(video.title)}</div>
    <div class="tags" data-group="tags" data-linear="h">${tagsHtml()}</div>
    <div class="tm"><span class="cur mono">0:00</span><div class="bar"><div class="ticks"></div><div class="fill"></div></div><span class="tot mono">${fmtTime(video.durationS)}</span></div>
    <div class="from">${fromText} · ${copyText}</div>
  </div>
  <div class="pl-strip" hidden><h3>Chapters</h3><div class="cards"></div></div>
  <div class="pl-msg" hidden></div>
</div>
<aside class="pl-lyrics">
  <div class="hd"><h2></h2><div class="en"></div><div class="pills"></div><div class="scripts"></div></div>
  <div class="lines"></div>
  <div class="pager mono"></div>
</aside>`,
    B: `<div class="pl-stage">
  <video playsinline></video>
  <div class="pl-top"><div class="t1">${esc(video.title)}</div><div class="tags" data-group="tags" data-linear="h">${tagsHtml()}</div><div class="from">${fromText} · ${copyText}</div></div>
  <div class="pl-bar">
    <div class="row"><span class="chap"></span><span class="sp"></span><span class="nextup"></span></div>
    <div class="tm"><span class="cur mono">0:00</span><div class="bar"><div class="ticks"></div><div class="fill"></div></div><span class="tot mono">${fmtTime(video.durationS)}</span></div>
  </div>
  <div class="pl-badge mono" hidden></div>
  <div class="pl-list" hidden><h3>Chapters</h3><div class="rows"></div></div>
  <aside class="pl-lyrics"><div class="hd"><h2></h2><div class="scripts"></div></div><div class="lines"></div><div class="pager mono"></div></aside>
  <div class="pl-msg" hidden></div>
</div>`,
    C: `<div class="pl-stage">
  <video playsinline></video>
  <div class="pl-ghost" hidden><div class="fr"></div><div class="gt mono"></div></div>
  <div class="pl-msg" hidden></div>
</div>
<aside class="pl-lyrics">
  <div class="hd"><h2></h2><div class="en"></div><div class="scripts"></div><div class="est">≈ followed by position in the Chapter</div></div>
  <div class="lines"></div>
</aside>
<div class="pl-band">
  <div class="info">
    <div class="t1">${esc(video.title)}</div>
    <div class="tags" data-group="tags" data-linear="h">${tagsHtml()}</div>
    <div class="tm"><span class="cur mono">0:00</span><div class="bar"><div class="ticks"></div><div class="fill"></div><div class="ghostmark" hidden></div></div><span class="tot mono">${fmtTime(video.durationS)}</span></div>
    <div class="from">${fromText} · ${copyText}</div>
  </div>
  <div class="pl-strip"><h3>Chapters <span class="n"></span></h3><div class="cards"></div></div>
</div>`,
  }[V];
  const $ = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const v = $<HTMLVideoElement>("video");
  const tagsEl = $(".tags"), fill = $(".fill"), cur = $(".cur"), panel = $(".pl-lyrics"), lines = $(".lines"), msg = $(".pl-msg");
  const pager = el.querySelector<HTMLElement>(".pager");
  const osd = V === "A" ? $(".pl-osd") : V === "B" ? $(".pl-bar") : null;
  const top = el.querySelector<HTMLElement>(".pl-top");

  let chapters: ChapterDto[] = [];
  let song: SongDto | null = null;
  let songId: string | null = null;
  let versionIdx = 0;
  let script: ScriptKey = scriptPref;
  let texts: Partial<Record<ScriptKey, string>> = {};
  let lyricsOn = true;
  let hasLyrics = false;
  let stripIdx = 0;
  let zone: Zone = "video";
  let page = 0, pages = 1;
  let osdTimer: ReturnType<typeof setTimeout> | undefined;
  let resumed = false;

  const showMsg = (s: string | null) => { msg.hidden = !s; msg.textContent = s ?? ""; };
  const showOsd = (ms = 3000) => {
    if (!osd) return;
    osd.classList.add("on");
    top?.classList.add("on");
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => { if (!v.paused && zone === "video") { osd.classList.remove("on"); top?.classList.remove("on"); } }, ms);
  };
  const layout = () => {
    el.classList.toggle("lyrics", lyricsOn && hasLyrics);
    el.classList.toggle("strip", zone === "strip");
  };
  const setZone = (z: Zone) => {
    zone = z;
    osd?.classList.toggle("pin", z !== "video");
    top?.classList.toggle("pin", z === "tags");
    if (z === "tags") focus(focusables(tagsEl)[0] ?? null, false);
    else focus(null);
    layout();
    showOsd();
  };

  // ---- playback ----
  if (copy) {
    v.src = `${BASE}/copy/${copy.id}`;
    v.addEventListener("loadedmetadata", () => {
      const t0 = startPosition({ t: opts.t ?? null, resumeS: video.resumeS, durationS: video.durationS });
      if (t0 > 0) { v.currentTime = t0; if (opts.t == null) resumed = true; }
      void v.play().catch(() => showMsg("Press Enter to play"));
      if (resumed) toast(`Resuming at ${fmtTime(t0)}`);
    });
    v.addEventListener("error", () => showMsg(`This Copy did not play (${copy.container} ${copy.videoCodec}/${copy.audioCodec})`));
    v.addEventListener("ended", () => { toast(`Finished · > plays the next in ${from.label}`); showOsd(10000); });
    v.addEventListener("pause", () => { osd?.classList.add("on"); top?.classList.add("on"); });
    v.addEventListener("play", () => showOsd());
  } else showMsg("No Available Copy");

  v.addEventListener("timeupdate", () => {
    const t = v.currentTime, d = v.duration || video.durationS || 0;
    cur.textContent = fmtTime(t);
    fill.style.width = d ? `${(100 * t) / d}%` : "0";
    followChapter(t);
    if (V === "B") nextUp(t, d);
    if (V === "C") followLine(t);
  });

  // ---- Chapters ----
  const stripFrame = (startS: number, w = 260): string => {
    const s = video.thumbnail?.strip;
    if (!s || !s.intervalS || !s.frameWidth || !s.frameHeight) return "";
    const i = Math.max(0, Math.min(s.frames - 1, Math.floor(startS / s.intervalS)));
    const x = (i % s.columns) * s.frameWidth, y = Math.floor(i / s.columns) * s.frameHeight;
    const scale = w / s.frameWidth;
    return `background-image:url(${BASE}${s.url});background-size:${s.columns * s.frameWidth * scale}px auto;background-position:-${x * scale}px -${y * scale}px`;
  };
  const chapterEnd = (c: ChapterDto) => { const i = chapters.indexOf(c); return chapters[i + 1]?.startS ?? (v.duration || video.durationS || c.startS + 1); };
  void api.chapters(videoId).then((cs) => {
    chapters = cs.sort((a, b) => a.startS - b.startS);
    const d = video.durationS || 1;
    $(".ticks").innerHTML = chapters.map((c) => `<i style="left:${(100 * c.startS) / d}%"></i>`).join("");
    const card = (c: ChapterDto, i: number, w: number) => `<div class="cc" data-i="${i}"><div class="fr" style="${stripFrame(c.startS, w)}"></div><div class="cm"><span class="mono">${fmtTime(c.startS)}</span>${c.songId ? " ♪" : ""}${c.suggested ? ' <span class="sug">suggested</span>' : ""}</div><div class="ct">${esc(c.title || "untitled")}</div></div>`;
    if (V === "A") $(".cards").innerHTML = chapters.map((c, i) => card(c, i, 260)).join("");
    if (V === "C") {
      $(".cards").innerHTML = chapters.length ? chapters.map((c, i) => card(c, i, 200)).join("") : `<div class="none">no Chapters in this Video</div>`;
      $(".pl-strip .n").textContent = chapters.length ? `· ${chapters.length}` : "";
    }
    if (V === "B") $(".rows").innerHTML = chapters.map((c, i) => `<div class="cr" data-i="${i}"><span class="mono">${fmtTime(c.startS)}</span><span class="ct">${esc(c.title || "untitled")}${c.songId ? " ♪" : ""}</span>${c.suggested ? '<span class="sug">suggested</span>' : ""}</div>`).join("");
    lastChapterId = "none";
    followChapter(v.currentTime);
  }).catch(() => {});
  let lastChapterId: number | null | "none" = "none";
  const followChapter = (t: number) => {
    const ch = chapterAt(chapters, t);
    if ((ch?.id ?? null) !== lastChapterId) {
      lastChapterId = ch?.id ?? null;
      el.querySelectorAll(".cc, .cr").forEach((c, i) => c.classList.toggle("cur", chapters[i] === ch));
      if (V === "B") $(".chap").textContent = ch ? `${ch.title || "untitled"} · ${fmtTime(ch.startS)}–${fmtTime(chapterEnd(ch))}` : chapters.length ? "before the first Chapter" : "";
      if (V === "C" && zone !== "strip" && ch) { stripIdx = chapters.indexOf(ch); markStrip(true); }
      const target = opts.lyricsSong ? { songId: opts.lyricsSong, versionId: null } : lyricsTarget(ch, video);
      if ((target?.songId ?? null) !== songId) void loadSong(target);
    }
  };
  const nextUp = (t: number, d: number) => {
    const nx = $(".nextup");
    if (d && d - t < 20) {
      const id = stepFrom(from, videoId, 1, (x) => ctx.data.byId.get(x)?.available ?? false);
      nx.textContent = id != null ? `Next: ${ctx.data.byId.get(id)?.title ?? ""}` : "last in " + from.label;
    } else nx.textContent = "";
  };

  // ---- lyrics ----
  async function loadSong(target: { songId: string; versionId: string | null } | null) {
    songId = target?.songId ?? null;
    song = null;
    hasLyrics = false;
    layout();
    if (!songId) return;
    $(".hd h2").textContent = "…";
    lines.innerHTML = "";
    try {
      const s = await api.song(songId);
      if (s.id !== songId) return;
      song = s;
      versionIdx = openingVersionIndex(s.versions, target!.versionId);
      page = 0;
      renderLyrics();
    } catch { $(".hd h2").textContent = "lyrics did not load"; }
  }
  function renderLyrics() {
    if (!song) return;
    const ver = song.versions[versionIdx];
    $(".hd h2").innerHTML = `${esc(song.name)}${song.local ? ' <span class="loc">local</span>' : ""}${V === "B" && song.englishName ? ` <span class="en">${esc(song.englishName)}</span>` : ""}`;
    el.querySelector(".hd .en")?.replaceChildren(song.englishName ?? "");
    el.querySelector(".pills")?.replaceChildren();
    if (V === "A" && song.versions.length > 1) $(".pills").innerHTML = song.versions.map((x, i) => `<span class="pill${i === versionIdx ? " on" : ""}">${esc(x.label)}</span>`).join("");
    texts = ver ? { cyrillic: ver.scripts.cyrillic.html, transliteration: ver.scripts.transliteration.html, translation: ver.scripts.translation.html } : {};
    const present = presentScripts(texts);
    hasLyrics = present.length > 0;
    layout();
    if (!hasLyrics) return;
    script = effectiveScript(scriptPref, present);
    $(".scripts").innerHTML = SCRIPTS.map((s) => `<span class="${s.key === script ? "on" : present.includes(s.key) ? "" : "off"}">${s.label}</span>`).join("");
    lines.lang = SCRIPTS.find((s) => s.key === script)!.lang;
    const ls = numberedLines(texts[script] ?? "");
    if (V === "C") {
      // the translation under each line, when the shown Script is not the translation itself
      const tr = script !== "translation" && present.includes("translation") ? numberedLines(texts.translation ?? "") : [];
      const byN = new Map(tr.filter((l) => !l.blank).map((l) => [l.n, l.html]));
      lines.innerHTML = ls.length ? ls.map((l) => (l.blank ? `<div class="sp"></div>` : `<p class="ln" data-n="${l.n}"><span class="tx">${l.html}</span>${byN.get(l.n) ? `<span class="tr" lang="en">${byN.get(l.n)}</span>` : ""}</p>`)).join("") : `<p class="none">this Version has no ${script} text</p>`;
      followLine(v.currentTime, true);
      return;
    }
    lines.innerHTML = ls.length ? ls.map((l) => (l.blank ? `<div class="sp"></div>` : `<p class="ln">${V === "A" ? `<span class="n mono">${l.n}</span>` : ""}<span class="tx">${l.html}</span></p>`)).join("") : `<p class="none">this Version has no ${script} text</p>`;
    if (V === "B") fitPanelB();
    pageTo(page);
  }
  // B: the panel grows to its longest line (measured unwrapped) so lines wrap only past the widest the video can spare
  const B_MIN = 900, B_MAX = 1320, B_PAD = 230 + 56;
  function fitPanelB() {
    lines.style.whiteSpace = "nowrap";
    let w = 0;
    for (const tx of lines.querySelectorAll<HTMLElement>(".tx")) w = Math.max(w, tx.scrollWidth);
    lines.style.whiteSpace = "";
    panel.style.width = `${Math.max(B_MIN, Math.min(B_MAX, w + B_PAD + 8))}px`;
  }
  function pageTo(n: number) {
    panel.classList.remove("fits");
    const h = lines.clientHeight || 1;
    pages = Math.max(1, Math.ceil(lines.scrollHeight / h));
    page = Math.max(0, Math.min(pages - 1, n));
    lines.scrollTop = page * h;
    if (pager) pager.textContent = pages > 1 ? `page ${page + 1} of ${pages} · Ch ▲ ▼` : "";
    panel.classList.toggle("fits", pages === 1);
  }
  // C: the estimated current line. The Chapter's (or the Video's) span maps linearly onto the non-blank lines.
  let lastEst = -1;
  function followLine(t: number, force = false) {
    if (!hasLyrics || !lines.children.length) return;
    const ch = chapterAt(chapters, t);
    const s0 = ch ? ch.startS : 0, s1 = ch ? chapterEnd(ch) : v.duration || video.durationS || 1;
    const ps = [...lines.querySelectorAll<HTMLElement>(".ln")];
    if (!ps.length) return;
    const frac = Math.max(0, Math.min(0.999, (t - s0) / Math.max(1, s1 - s0)));
    const i = Math.floor(frac * ps.length);
    if (i === lastEst && !force) return;
    lastEst = i;
    ps.forEach((p, k) => { p.classList.toggle("est", k === i || k === i + 1); p.classList.toggle("past", k < i); });
    const p = ps[i]!;
    lines.scrollTop = Math.max(0, p.offsetTop - lines.offsetTop - lines.clientHeight * 0.38);
  }
  function cycleScript() {
    if (!song?.versions[versionIdx]) return toast("no lyrics to switch");
    const present = presentScripts(texts);
    if (present.length < 2) return toast(`only ${script} for this Version`);
    scriptPref = present[(present.indexOf(script) + 1) % present.length]!;
    page = 0;
    renderLyrics();
  }

  // ---- the strip / list / cards ----
  const markStrip = (scroll = true) => {
    const items = el.querySelectorAll<HTMLElement>(".cc, .cr");
    items.forEach((c, i) => c.classList.toggle("f", i === stripIdx && zone === "strip"));
    const c = items[stripIdx];
    if (!c || !scroll) return;
    const box = c.parentElement!;
    if (V === "B") box.scrollTop = Math.max(0, c.offsetTop - box.offsetTop - box.clientHeight / 2 + c.offsetHeight / 2);
    else box.scrollLeft = Math.max(0, c.offsetLeft - box.clientWidth / 2 + c.offsetWidth / 2);
  };
  const openStrip = () => {
    if (!chapters.length) return toast("no Chapters in this Video");
    const ch = chapterAt(chapters, v.currentTime);
    stripIdx = ch ? chapters.indexOf(ch) : 0;
    const box = el.querySelector<HTMLElement>(".pl-strip, .pl-list");
    if (V !== "C" && box) box.hidden = false;
    setZone("strip");
    markStrip();
  };
  const closeStrip = () => {
    if (V !== "C") { const box = el.querySelector<HTMLElement>(".pl-strip, .pl-list"); if (box) box.hidden = true; }
    setZone("video");
    markStrip(false);
  };
  const jumpChapter = (i: number) => {
    const c = chapters[i];
    if (!c) return;
    v.currentTime = c.startS;
    followChapter(c.startS);
    void v.play();
  };

  // ---- seeking: three answers ----
  const clampSeek = (t: number) => Math.max(0, Math.min((v.duration || 1e9) - 0.5, t));
  let lastStep = 0, ramp = 0;
  const RAMP = [10, 30, 60, 120];
  let badgeTimer: ReturnType<typeof setTimeout> | undefined;
  const seekA = (dt: number) => { v.currentTime = clampSeek(v.currentTime + dt); showOsd(); };
  const seekB = (dir: 1 | -1) => {
    const now = performance.now();
    ramp = now - lastStep < 1000 ? Math.min(RAMP.length - 1, ramp + 1) : 0;
    lastStep = now;
    v.currentTime = clampSeek(v.currentTime + RAMP[ramp]! * dir);
    const b = $(".pl-badge");
    b.hidden = false;
    b.textContent = `${dir > 0 ? "+" : "−"}${RAMP[ramp]} s`;
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => { b.hidden = true; }, 900);
    showOsd();
  };
  let ghost: number | null = null;
  let ghostTimer: ReturnType<typeof setTimeout> | undefined;
  const seekC = (dir: 1 | -1) => {
    ghost = clampSeek((ghost ?? v.currentTime) + 5 * dir);
    const g = $(".pl-ghost");
    g.hidden = false;
    $(".pl-ghost .fr").setAttribute("style", stripFrame(ghost, 320));
    $(".pl-ghost .gt").textContent = `${dir > 0 ? "▸ " : "◂ "}${fmtTime(ghost)}`;
    const m = $(".ghostmark");
    m.hidden = false;
    m.style.left = `${(100 * ghost) / (v.duration || video.durationS || 1)}%`;
    clearTimeout(ghostTimer);
    ghostTimer = setTimeout(commitGhost, 700);
  };
  const commitGhost = () => {
    clearTimeout(ghostTimer);
    if (ghost == null) return;
    v.currentTime = ghost;
    ghost = null;
    $(".pl-ghost").hidden = true;
    $(".ghostmark").hidden = true;
  };
  const stepChapter = (dir: 1 | -1) => {
    if (!chapters.length) return toast("no Chapters in this Video");
    const ch = chapterAt(chapters, v.currentTime);
    let i = ch ? chapters.indexOf(ch) : -1;
    // back inside a Chapter (more than 3 s in) returns to its start, as a track key does
    if (!(dir < 0 && ch && v.currentTime - ch.startS > 3)) i += dir;
    if (i < 0) { v.currentTime = 0; return; }
    if (i >= chapters.length) return toast("last Chapter");
    jumpChapter(i);
  };

  const stepVideo = (dir: 1 | -1) => {
    const id = stepFrom(from, videoId, dir, (x) => ctx.data.byId.get(x)?.available ?? false);
    if (id == null) return toast("nothing else in " + from.label);
    ctx.pop();
    ctx.play(id, from);
  };
  const openTag = () => {
    const f = getFocused();
    if (!f?.dataset.kind) return;
    ctx.browse(f.dataset.kind as "type" | "artist" | "song", f.dataset.value!, f.dataset.name);
  };
  const togglePlay = () => { if (v.paused) void v.play(); else v.pause(); };

  return {
    name: "player", el, hints: HINTS[V],
    onKey(k) {
      showOsd();
      if (zone === "tags") {
        switch (k.key) {
          case "left": case "right": moveFocus(tagsEl, k.key); return true;
          case "enter": openTag(); return true;
          case "down": case "back": case "up": setZone("video"); return true;
          case "playpause": case "play": case "pause": break;
          default: return false;
        }
      }
      if (zone === "strip") {
        const last = chapters.length - 1;
        const horizontal = V !== "B";
        switch (k.key) {
          case "left": if (horizontal) { stripIdx = Math.max(0, stripIdx - 1); markStrip(); } else closeStrip(); return true;
          case "right": if (horizontal) { stripIdx = Math.min(last, stripIdx + 1); markStrip(); } return true;
          case "up": if (!horizontal) { stripIdx = Math.max(0, stripIdx - 1); markStrip(); } else closeStrip(); return true;
          case "down": if (!horizontal) { stripIdx = Math.min(last, stripIdx + 1); markStrip(); } return true;
          case "enter": jumpChapter(stripIdx); closeStrip(); return true;
          case "back": case "green": case "strip": closeStrip(); return true;
          case "playpause": case "play": case "pause": break;
          default: return false;
        }
      }
      switch (k.key) {
        case "left": case "right": {
          const dir = k.key === "right" ? 1 : -1;
          if (V === "A") seekA(10 * dir); else if (V === "B") seekB(dir); else seekC(dir);
          return true;
        }
        case "rew": case "ff": {
          const dir = k.key === "ff" ? 1 : -1;
          if (V === "C") stepChapter(dir); else seekA(60 * dir);
          return true;
        }
        case "up": setZone("tags"); return true;
        case "down": case "green": case "strip": openStrip(); return true;
        case "chup": if (V !== "C") pageTo(page - 1); else stepChapter(-1); return true;
        case "chdown": if (V !== "C") pageTo(page + 1); else stepChapter(1); return true;
        case "enter": if (V === "C" && ghost != null) { commitGhost(); return true; } togglePlay(); return true;
        case "playpause": togglePlay(); return true;
        case "play": void v.play(); return true;
        case "pause": v.pause(); return true;
        case "stop": ctx.pop(); return true;
        case "prev": stepVideo(-1); return true;
        case "next": stepVideo(1); return true;
        case "yellow": case "lyrics":
          if (!hasLyrics) return toast(songId ? "no lyrics in the archive for this Song" : "no lyrics: this Video has no Song"), true;
          lyricsOn = !lyricsOn; layout(); if (lyricsOn && V !== "C") pageTo(page); return true;
        case "blue": case "script": cycleScript(); return true;
        default: return false;
      }
    },
    onBack: () => false,
    onShow() { layout(); if (zone === "tags") setZone("tags"); },
    dispose() { v.pause(); v.removeAttribute("src"); v.load(); clearTimeout(osdTimer); clearTimeout(ghostTimer); clearTimeout(badgeTimer); },
    state: () => ({
      player: `${V} ${PLAYER_VARIANTS[V]}`, videoId, title: video.title, copyId: copy?.id ?? null, t: Math.round(v.currentTime * 10) / 10, paused: v.paused, resumedFrom: resumed ? video.resumeS : null, zone,
      from: { label: from.label, position: pos + 1, of: from.ids.length },
      chapters: chapters.length, chapterNow: chapterAt(chapters, v.currentTime)?.title ?? null,
      lyrics: { songId, song: song?.name ?? null, version: song?.versions[versionIdx]?.label ?? null, script, page: page + 1, pages, shown: el.classList.contains("lyrics"), wanted: lyricsOn, estimatedLine: V === "C" ? lastEst + 1 : undefined },
      strip: { open: zone === "strip", index: stripIdx },
      seek: V === "B" ? { ramp: RAMP[ramp] } : V === "C" ? { ghost } : { step: 10 },
    }),
  };
}
