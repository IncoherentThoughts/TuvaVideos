// PROTOTYPE — throwaway (issue #50). Search on the TV: an on-screen keyboard driven by the D-pad (a physical keyboard
// types too), results from the app's /api/search on the right, grouped Songs / Videos / Artists. Enter on a Song plays
// its newest Video with the lyrics open; on a Video plays it; on an Artist opens that Artist in the home variant.
import type { SearchResponse } from "../../src/shared/types";
import { type Ctx, type Screen, api, esc, fmtTime, focus, focusables, getFocused, moveFocus, toast } from "./shared";
import { activate, idsIn } from "./variants";

const LATIN = "abcdefghijklmnopqrstuvwxyz".split("");
const CYR = "абвгдеёжзийклмнопрстуфхцчшщъыьэюяөүң".split("");
const DIGITS = "1234567890".split("");
export const HINTS_SEARCH = "↑↓←→ keys · Enter type / open · → results · Back deletes, then leaves · a keyboard types too";

export function makeSearch(ctx: Ctx): Screen {
  const el = document.createElement("div");
  el.className = "screen se";
  let q = "", mode: "latin" | "cyr" | "digits" = "latin", timer: ReturnType<typeof setTimeout> | undefined, last: SearchResponse | null = null;
  el.innerHTML = `<div class="se-left">
  <div class="q"><span class="txt"></span><span class="caret"></span><span class="ph">Search Songs, Videos, Artists, lyrics</span></div>
  <div class="kb" data-group="kb" data-cols="7"></div>
</div>
<div class="se-right"><div class="res" data-group="res" data-linear="v"><div class="empty">Type to search · lyrics need 3 letters</div></div></div>`;
  const kb = el.querySelector<HTMLElement>(".kb")!, res = el.querySelector<HTMLElement>(".res")!, txt = el.querySelector<HTMLElement>(".txt")!;

  const renderKb = () => {
    const letters = mode === "latin" ? LATIN : mode === "cyr" ? CYR : DIGITS;
    kb.innerHTML = letters.map((c) => `<button class="kbk" data-f data-ch="${c}">${c}</button>`).join("") +
      `<button class="kbk sp" data-f data-ch=" ">␣</button><button class="kbk" data-f data-op="del">⌫</button>` +
      `<button class="kbk op${mode === "cyr" ? " on" : ""}" data-f data-op="cyr">АБВ</button><button class="kbk op${mode === "latin" ? " on" : ""}" data-f data-op="latin">abc</button>` +
      `<button class="kbk op${mode === "digits" ? " on" : ""}" data-f data-op="digits">123</button><button class="kbk op" data-f data-op="clear">clear</button>`;
  };
  renderKb();
  const setQ = (s: string) => {
    q = s;
    txt.textContent = q;
    el.querySelector<HTMLElement>(".ph")!.hidden = !!q;
    clearTimeout(timer);
    if (!q.trim()) { last = null; res.innerHTML = `<div class="empty">Type to search · lyrics need 3 letters</div>`; return; }
    timer = setTimeout(() => void api.search(q).then((r) => { if (q) { last = r; renderRes(r); } }).catch(() => toast("search failed")), 220);
  };
  const renderRes = (r: SearchResponse) => {
    const groups = r.groups.filter((g) => g.key === "songs" || g.key === "videos" || g.key === "artists");
    if (!groups.some((g) => g.rows.length)) { res.innerHTML = `<div class="empty">Nothing for “${esc(q)}” <span class="dim">(${r.ms} ms)</span></div>`; return; }
    res.innerHTML = groups.map((g) => `<div class="rh">${g.label} <span class="dim">${g.total}</span></div>` + g.rows.map((row) => {
      if (row.kind === "song") return `<div class="rr" data-f data-song="${row.id}"><div class="t">${esc(row.name)}${row.englishName ? ` <span class="dim">${esc(row.englishName)}</span>` : ""}</div><div class="s">${row.viaLyrics ? `<span class="k">lyrics:</span> ${esc(row.lyric ?? "")}` : `${row.videos.length} Video${row.videos.length === 1 ? "" : "s"}${row.lyric ? ` · <span class="k">lyrics</span>` : ""}`}</div></div>`;
      if (row.kind === "video") return `<div class="rr" data-f data-video="${row.id}"><div class="t">${esc(row.title)}</div><div class="s"><span class="k">${row.type}</span> · ${fmtTime(row.durationS)}${row.songs.length ? ` · ♪ ${esc(row.songs.join(", "))}` : ""}</div></div>`;
      if (row.kind === "artist") return `<div class="rr" data-f data-artist="${esc(row.name)}"><div class="t">${esc(row.name)}</div><div class="s">${row.videoCount} Video${row.videoCount === 1 ? "" : "s"}${row.local ? " · local" : ""}</div></div>`;
      return "";
    }).join("")).join("") + `<div class="ms dim mono">${r.ms} ms</div>`;
  };

  return {
    name: "search", el, hints: HINTS_SEARCH,
    onKey(k) {
      if (k.key === "char") { setQ(q + k.char); return true; }
      if (k.key === "up" || k.key === "down" || k.key === "left" || k.key === "right") { moveFocus(el, k.key); return true; }
      if (k.key === "back") { if (q) { setQ(q.slice(0, -1)); return true; } return false; }
      if (k.key !== "enter") return false;
      const f = getFocused();
      if (!f) return false;
      if (f.dataset.ch != null) { setQ(q + f.dataset.ch); return true; }
      if (f.dataset.op) {
        const op = f.dataset.op;
        if (op === "del") setQ(q.slice(0, -1));
        else if (op === "clear") setQ("");
        else { mode = op as typeof mode; renderKb(); focus(el.querySelector<HTMLElement>(`[data-op="${op}"]`)); }
        return true;
      }
      return activate(ctx, f, () => ({ label: "Search", ids: idsIn(res) }));
    },
    onBack: () => false,
    onShow() { focus(getFocused() && el.contains(getFocused()!) ? getFocused() : focusables(kb)[0] ?? null); },
    dispose() { clearTimeout(timer); },
    state: () => ({ q, mode, results: last ? Object.fromEntries(last.groups.map((g) => [g.key, g.total])) : null, focused: getFocused()?.dataset }),
  };
}
