// PROTOTYPE — throwaway (issue #50). Three variants of the TV home screen, switchable via ?variant=A|B|C (and the red
// key / v), on a 1920×1080 stage scaled to fit the window; one shared Player with the lyrics Reader beside the video,
// one shared Search. Real data from the running app (serve.ts proxies it). Nothing is written to the library.
import { pickRandomVideo } from "../../src/shared/random";
import { viewVideos } from "../../src/shared/libraryView";
import { makePlayer } from "./player";
import { makeSearch } from "./search";
import { type Ctx, type Data, type Screen, api, exitApp, lib, registerTizenKeys, toKey, toast } from "./shared";
import { VARIANTS, VARIANT_KEYS, type Home } from "./variants";

const tv = document.getElementById("tv")!;
const hints = document.getElementById("hints")!;
const bar = document.getElementById("bar")!;
const stateEl = document.getElementById("state")!;
const params = new URLSearchParams(location.search);

function fitStage() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  tv.style.transform = `scale(${s})`;
  tv.style.left = `${(innerWidth - 1920 * s) / 2}px`;
  tv.style.top = `${(innerHeight - 1080 * s) / 2}px`;
}
addEventListener("resize", fitStage);
fitStage();

const stack: Screen[] = [];
const topScreen = () => stack[stack.length - 1]!;
const show = (s: Screen) => { s.el.hidden = false; hints.textContent = s.hints; s.onShow?.(); };
function push(s: Screen) {
  if (stack.length) topScreen().el.hidden = true;
  stack.push(s);
  tv.insertBefore(s.el, hints);
  show(s);
}
function pop() {
  if (stack.length < 2) return;
  const s = stack.pop()!;
  s.dispose?.();
  s.el.remove();
  show(topScreen());
}

let home!: Home;
let data!: Data;
const ctx: Ctx = {
  get data() { return data; },
  push, pop,
  play(videoId, from, opts) { push(makePlayer(ctx, videoId, from, opts)); },
  playSong(songId) {
    void api.song(songId).then((s) => {
      const first = s.videos.find((x) => x.available && x.pointed) ?? s.videos.find((x) => x.available);
      if (!first) return toast(`no Available Video performs ${s.name}`);
      ctx.play(first.id, { label: s.name, ids: s.videos.filter((x) => x.available).map((x) => x.id) }, { t: first.startS, lyricsSong: s.id });
    }).catch(() => toast("the Song did not load"));
  },
  search() { if (topScreen().name !== "search") push(makeSearch(ctx)); },
  random() {
    const playing = topScreen().name === "player" ? (topScreen().state().videoId as number) : null;
    const id = pickRandomVideo(data.videos, playing);
    if (id == null) return toast("no Available Video");
    if (playing != null) pop();
    ctx.play(id, { label: "Library", ids: viewVideos(data.videos, lib).map((v) => v.id) });
  },
  openArtist(name) { while (stack.length > 1) pop(); home.openArtist(name); },
};

function setVariant(key: string) {
  if (!VARIANTS[key]) key = "A";
  const next = VARIANTS[key]!(ctx);
  if (stack.length) { const old = stack.shift()!; old.el.remove(); }
  stack.unshift(next);
  tv.insertBefore(next.el, hints);
  next.el.hidden = stack.length > 1;
  if (stack.length === 1) show(next);
  home = next;
  const p = new URLSearchParams(location.search);
  p.set("variant", key);
  history.replaceState(null, "", `?${p.toString().replace(/%2C/g, ",")}`);
  bar.querySelector("#lbl")!.textContent = `${key} — ${next.title}`;
}
const cycleVariant = (d: number) => {
  if (stack.length > 1) return toast("variants switch on the home screen (Back first)");
  setVariant(VARIANT_KEYS[(VARIANT_KEYS.indexOf(home.variant) + d + VARIANT_KEYS.length) % VARIANT_KEYS.length]!);
};
bar.querySelector("#prev")!.addEventListener("click", () => cycleVariant(-1));
bar.querySelector("#next")!.addEventListener("click", () => cycleVariant(1));
if (params.get("bar") === "0") bar.hidden = true;

let stateTimer: ReturnType<typeof setInterval> | undefined;
function toggleState() {
  stateEl.hidden = !stateEl.hidden;
  clearInterval(stateTimer);
  if (stateEl.hidden) return;
  const tick = () => { stateEl.textContent = JSON.stringify({ variant: home.variant, stack: stack.map((s) => s.name), screen: topScreen().state() }, null, 1); };
  tick();
  stateTimer = setInterval(tick, 400);
}

addEventListener("keydown", (e: KeyboardEvent) => {
  if (!data) return;
  const t = topScreen();
  const k = toKey(e, t.name === "search");
  if (!k) return;
  e.preventDefault();
  if (k.key === "state" || k.key === "info") return toggleState();
  if (k.key === "variant" || k.key === "red") return cycleVariant(1);
  if (k.key === "random") return ctx.random();
  if (k.key === "search") return ctx.search();
  if (t.onKey(k)) return;
  if (k.key === "back" && !t.onBack()) { if (stack.length > 1) pop(); else exitApp(); }
});
registerTizenKeys();

(async () => {
  const loading = document.createElement("div");
  loading.className = "loading";
  loading.textContent = "Loading the library…";
  tv.insertBefore(loading, hints);
  try {
    const [videos, artists, songs, favorites] = await Promise.all([api.videos(), api.artists(), api.songs(), api.favorites()]);
    data = { videos, artists, songs, favorites, byId: new Map(videos.map((v) => [v.id, v])) };
    loading.remove();
    setVariant(params.get("variant") ?? "A");
  } catch (e) {
    loading.innerHTML = `Could not reach the app.<br><small>Is TuvaVideos running on 127.0.0.1:4400? (<code>bun run start</code>)<br>${String(e)}</small>`;
  }
})();
