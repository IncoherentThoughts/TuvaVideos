// PROTOTYPE — throwaway (issue #50). The TV Player: the video on the left and the static lyrics Reader on the right, as
// on Now playing in the browser app: one Script at a time, numbered lines, no current line; Up/Down page the lines.
// Green (c) opens a Chapter strip (Down does too while the lyrics are hidden); any key shows the OSD; < > step through
// Playing from. Resume is read, never written: the prototype changes nothing in the library.
import type { ChapterDto, SongDto, VideoDto } from "../../src/shared/types";
import type { ScriptKey } from "../../src/shared/lyrics/types";
import { bestCopy } from "../../src/shared/copies";
import { numberedLines } from "../../src/shared/lyrics/normalize";
import { SCRIPTS, effectiveScript, presentScripts } from "../../src/shared/lyrics/scripts";
import { chapterAt, lyricsTarget } from "../../src/shared/lyrics/target";
import { openingVersionIndex } from "../../src/shared/lyrics/trackVersion";
import { startPosition } from "../../src/shared/resume";
import { BASE, type Ctx, type From, type Screen, api, esc, fmtTime, stepFrom, tagsHtml, toast } from "./shared";

let scriptPref: ScriptKey = "cyrillic";
const SEEK_S = 10, SKIP_S = 60;

export const HINTS_PLAYER = "←→ ±10 s · Enter pause · ↑↓ lyrics page · y (yellow) lyrics · s (blue) Script · c (green) Chapters · < > prev/next · Back";

export function makePlayer(ctx: Ctx, videoId: number, from: From, opts: { t?: number | null; lyricsSong?: string | null } = {}): Screen {
  const video: VideoDto = ctx.data.byId.get(videoId)!;
  const copy = bestCopy(video.copies);
  const pos = from.ids.indexOf(videoId);
  const el = document.createElement("div");
  el.className = "screen pl";
  el.innerHTML = `<div class="pl-stage">
  <video playsinline></video>
  <div class="pl-osd">
    <div class="t1">${esc(video.title)}</div>
    <div class="tags">${tagsHtml(video, 4)}</div>
    <div class="tm"><span class="cur mono">0:00</span><div class="bar"><div class="ticks"></div><div class="fill"></div></div><span class="tot mono">${fmtTime(video.durationS)}</span></div>
    <div class="from">Playing from ${esc(from.label)}${pos >= 0 ? ` · ${pos + 1} of ${from.ids.length}` : ""}${copy ? ` · ${copy.container} ${copy.videoCodec}/${copy.audioCodec} ${copy.height ?? "?"}p · ${copy.rootKind}` : ""}</div>
  </div>
  <div class="pl-strip" hidden><h3>Chapters</h3><div class="cards"></div></div>
  <div class="pl-msg" hidden></div>
</div>
<aside class="pl-lyrics">
  <div class="hd"><h2></h2><div class="en"></div><div class="pills"></div><div class="scripts"></div></div>
  <div class="lines"></div>
  <div class="pager mono"></div>
</aside>`;
  const $ = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const v = $<HTMLVideoElement>("video");
  const osd = $(".pl-osd"), fill = $(".fill"), cur = $(".cur"), strip = $(".pl-strip"), cards = $(".cards"), lines = $(".lines"), pager = $(".pager"), msg = $(".pl-msg");

  let chapters: ChapterDto[] = [];
  let song: SongDto | null = null;
  let songId: string | null = null;
  let versionIdx = 0;
  let script: ScriptKey = scriptPref;
  let lyricsOn = true;
  let stripOn = false;
  let stripIdx = 0;
  let page = 0, pages = 1;
  let osdTimer: ReturnType<typeof setTimeout> | undefined;
  let resumed = false;

  const showMsg = (s: string | null) => { msg.hidden = !s; msg.textContent = s ?? ""; };
  const showOsd = (ms = 3000) => { osd.classList.add("on"); clearTimeout(osdTimer); osdTimer = setTimeout(() => { if (!v.paused) osd.classList.remove("on"); }, ms); };
  const layout = () => { el.classList.toggle("lyrics", lyricsOn && !!songId); el.classList.toggle("strip", stripOn); };

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
    v.addEventListener("pause", () => osd.classList.add("on"));
    v.addEventListener("play", () => showOsd());
  } else showMsg("No Available Copy");

  v.addEventListener("timeupdate", () => {
    const t = v.currentTime, d = v.duration || video.durationS || 0;
    cur.textContent = fmtTime(t);
    fill.style.width = d ? `${(100 * t) / d}%` : "0";
    followChapter(t);
  });

  // ---- Chapters: ticks on the bar, the strip, and which Song the lyrics follow ----
  const stripFrame = (startS: number): string => {
    const s = video.thumbnail?.strip;
    if (!s || !s.intervalS || !s.frameWidth || !s.frameHeight) return "";
    const i = Math.min(s.frames - 1, Math.floor(startS / s.intervalS));
    const x = (i % s.columns) * s.frameWidth, y = Math.floor(i / s.columns) * s.frameHeight;
    const scale = 260 / s.frameWidth;
    return `background-image:url(${BASE}${s.url});background-size:${s.columns * s.frameWidth * scale}px auto;background-position:-${x * scale}px -${y * scale}px`;
  };
  void api.chapters(videoId).then((cs) => {
    chapters = cs.sort((a, b) => a.startS - b.startS);
    const d = video.durationS || 1;
    $(".ticks").innerHTML = chapters.map((c) => `<i style="left:${(100 * c.startS) / d}%"></i>`).join("");
    cards.innerHTML = chapters.map((c, i) => `<div class="cc" data-i="${i}"><div class="fr" style="${stripFrame(c.startS)}"></div><div class="cm"><span class="mono">${fmtTime(c.startS)}</span>${c.songId ? " ♪" : ""}${c.suggested ? ' <span class="sug">suggested</span>' : ""}</div><div class="ct">${esc(c.title || "untitled")}</div></div>`).join("");
    followChapter(v.currentTime);
  }).catch(() => {});
  let lastChapterId: number | null | "none" = "none";
  const followChapter = (t: number) => {
    const ch = chapterAt(chapters, t);
    if ((ch?.id ?? null) !== lastChapterId) {
      lastChapterId = ch?.id ?? null;
      cards.querySelectorAll(".cc").forEach((c, i) => c.classList.toggle("cur", chapters[i] === ch));
      const target = opts.lyricsSong ? { songId: opts.lyricsSong, versionId: null } : lyricsTarget(ch, video);
      if ((target?.songId ?? null) !== songId) void loadSong(target);
    }
  };

  // ---- lyrics: the Reader, static ----
  async function loadSong(target: { songId: string; versionId: string | null } | null) {
    songId = target?.songId ?? null;
    song = null;
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
    $(".hd h2").innerHTML = `${esc(song.name)}${song.local ? ' <span class="loc">local</span>' : ""}`;
    $(".en").textContent = song.englishName ?? "";
    $(".pills").innerHTML = song.versions.length > 1 ? song.versions.map((x, i) => `<span class="pill${i === versionIdx ? " on" : ""}">${esc(x.label)}</span>`).join("") : "";
    if (!ver) { lines.innerHTML = `<p class="none">no lyrics in the archive for this Song</p>`; $(".scripts").innerHTML = ""; pager.textContent = ""; return; }
    const texts = { cyrillic: ver.scripts.cyrillic.html, transliteration: ver.scripts.transliteration.html, translation: ver.scripts.translation.html };
    const present = presentScripts(texts);
    script = effectiveScript(scriptPref, present);
    $(".scripts").innerHTML = SCRIPTS.map((s) => `<span class="${s.key === script ? "on" : present.includes(s.key) ? "" : "off"}">${s.label}</span>`).join("");
    const ls = numberedLines(texts[script]);
    lines.lang = SCRIPTS.find((s) => s.key === script)!.lang;
    lines.innerHTML = ls.length ? ls.map((l) => (l.blank ? `<div class="sp"></div>` : `<p class="ln"><span class="n mono">${l.n}</span><span class="tx">${l.html}</span></p>`)).join("") : `<p class="none">this Version has no ${script} text</p>`;
    pageTo(page);
  }
  function pageTo(n: number) {
    const h = lines.clientHeight || 1;
    pages = Math.max(1, Math.ceil(lines.scrollHeight / h));
    page = Math.max(0, Math.min(pages - 1, n));
    lines.scrollTop = page * h;
    pager.textContent = pages > 1 ? `page ${page + 1} of ${pages} · ↑ ↓` : "";
  }
  function cycleScript() {
    if (!song?.versions[versionIdx]) return toast("no lyrics to switch");
    const ver = song.versions[versionIdx];
    const present = presentScripts({ cyrillic: ver.scripts.cyrillic.html, transliteration: ver.scripts.transliteration.html, translation: ver.scripts.translation.html });
    if (present.length < 2) return toast(`only ${script} for this Version`);
    scriptPref = present[(present.indexOf(script) + 1) % present.length]!;
    page = 0;
    renderLyrics();
  }

  // ---- strip ----
  const setStrip = (on: boolean) => {
    if (on && !chapters.length) return toast("no Chapters in this Video");
    stripOn = on;
    strip.hidden = !on;
    if (on) { stripIdx = Math.max(0, chapters.findIndex((c) => c === chapterAt(chapters, v.currentTime))); markStrip(); }
    layout();
  };
  const markStrip = () => {
    cards.querySelectorAll<HTMLElement>(".cc").forEach((c, i) => c.classList.toggle("f", i === stripIdx));
    const c = cards.children[stripIdx] as HTMLElement | undefined;
    if (c) cards.scrollLeft = Math.max(0, c.offsetLeft - cards.clientWidth / 2 + c.offsetWidth / 2);
  };
  const seek = (dt: number) => { v.currentTime = Math.max(0, Math.min((v.duration || 1e9) - 0.5, v.currentTime + dt)); showOsd(); };
  const stepVideo = (dir: 1 | -1) => {
    const id = stepFrom(from, videoId, dir, (x) => ctx.data.byId.get(x)?.available ?? false);
    if (id == null) return toast("nothing else in " + from.label);
    ctx.pop();
    ctx.play(id, from);
  };

  return {
    name: "player", el, hints: HINTS_PLAYER,
    onKey(k) {
      showOsd();
      switch (k.key) {
        case "left": if (stripOn) { stripIdx = Math.max(0, stripIdx - 1); markStrip(); } else seek(-SEEK_S); return true;
        case "right": if (stripOn) { stripIdx = Math.min(chapters.length - 1, stripIdx + 1); markStrip(); } else seek(SEEK_S); return true;
        case "rew": seek(-SKIP_S); return true;
        case "ff": seek(SKIP_S); return true;
        case "up": if (stripOn) setStrip(false); else if (el.classList.contains("lyrics")) pageTo(page - 1); return true;
        case "down": if (stripOn) return true; if (el.classList.contains("lyrics")) pageTo(page + 1); else setStrip(true); return true;
        case "chup": pageTo(page - 1); return true;
        case "chdown": pageTo(page + 1); return true;
        case "enter": case "playpause":
          if (stripOn && k.key === "enter") { const c = chapters[stripIdx]; if (c) { v.currentTime = c.startS; followChapter(c.startS); } setStrip(false); void v.play(); return true; }
          if (v.paused) void v.play(); else v.pause();
          return true;
        case "play": void v.play(); return true;
        case "pause": v.pause(); return true;
        case "stop": ctx.pop(); return true;
        case "prev": stepVideo(-1); return true;
        case "next": stepVideo(1); return true;
        case "yellow": case "lyrics":
          if (!songId) return toast("no lyrics: this Video has no Song"), true;
          lyricsOn = !lyricsOn; layout(); if (lyricsOn) pageTo(page); return true;
        case "blue": case "script": cycleScript(); return true;
        case "green": case "strip": setStrip(!stripOn); return true;
        case "back": if (stripOn) { setStrip(false); return true; } return false;
        default: return false;
      }
    },
    onBack: () => false,
    onShow() { layout(); },
    dispose() { v.pause(); v.removeAttribute("src"); v.load(); clearTimeout(osdTimer); },
    state: () => ({
      videoId, title: video.title, copyId: copy?.id ?? null, t: Math.round(v.currentTime * 10) / 10, paused: v.paused, resumedFrom: resumed ? video.resumeS : null,
      from: { label: from.label, position: pos + 1, of: from.ids.length },
      chapters: chapters.length, chapterNow: chapterAt(chapters, v.currentTime)?.title ?? null,
      lyrics: { songId, song: song?.name ?? null, version: song?.versions[versionIdx]?.label ?? null, script, page: page + 1, pages, shown: el.classList.contains("lyrics"), wanted: lyricsOn },
      strip: { open: stripOn, index: stripIdx },
    }),
  };
}
