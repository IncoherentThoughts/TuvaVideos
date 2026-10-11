// The State panel (the player prototype's "State" pane, kept for v1): what the <video> element is doing, the last
// seeks, a key log, and the key bindings. Toggled with `i` or the State button; refreshes 4x a second while shown.
import { useEffect, useState } from "preact/hooks";
import { fmtClock, frameNumber, type AbLoop } from "../shared/playerMath";
import type { ChapterMark } from "./Timeline";

export interface SeekLog {
  why: string;
  from: number;
  to: number;
  ms: number;
}
export interface KeyLog {
  key: string;
  handled: boolean;
  prevented: boolean;
  target: string;
}

interface Props {
  vid: { current: HTMLVideoElement | null };
  box: { current: HTMLDivElement | null };
  copyLabel: string;
  fps: number | null;
  ab: AbLoop;
  chapters: ChapterMark[];
  seeks: SeekLog[];
  keys: KeyLog[];
  onClose: () => void;
}

const fmtMs = (s: number) => `${fmtClock(s)}.${String(Math.floor((s % 1) * 1000)).padStart(3, "0")}`;
const ranges = (r: TimeRanges | undefined) => {
  if (!r || !r.length) return "—";
  const parts: string[] = [];
  for (let i = 0; i < r.length; i++) parts.push(`${fmtClock(r.start(i))}–${fmtClock(r.end(i))}`);
  return parts.join(", ");
};
const READY = ["HAVE_NOTHING", "HAVE_METADATA", "HAVE_CURRENT_DATA", "HAVE_FUTURE_DATA", "HAVE_ENOUGH_DATA"];
const NET = ["EMPTY", "IDLE", "LOADING", "NO_SOURCE"];

const BINDINGS: [string[], string][] = [
  [["space", "p"], "pause"], [["←", "→"], "±5 s"],
  [["↓", "↑"], "±60 s"], [["⇧←", "⇧→"], "±1 s exact"],
  [[",", "."], "frame step"], [["[", "]"], "speed ∓0.1"],
  [["{", "}"], "speed ½ / ×2"], [["⌫"], "speed 1.0"],
  [["9", "0"], "volume ±5"], [["m"], "mute"],
  [["f"], "fullscreen"], [["l"], "A-B loop (A, B, off)"],
  [["!", "@"], "chapter prev / next"], [["PgUp", "PgDn"], "chapter prev / next"],
  [["<", ">"], "prev / next Video"], [["s"], "screenshot"],
  [["o"], "OSD flash"], [["O"], "OSD always"],
  [["c"], "add Chapter here"], [["t"], "Studio playback"],
  [["i"], "this panel"], [["/"], "focus search"],
  [["Esc"], "back to the Player"], [[], ""],
];

export function StatePanel({ vid, box, copyLabel, fps, ab, chapters, seeks, keys, onClose }: Props) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);

  const v = vid.current;
  const rows: [string, string, string?][] = [];
  if (v) {
    const q = v.getVideoPlaybackQuality?.();
    const t = v.currentTime;
    const cur = [...chapters].filter((c) => c.startS <= t).sort((a, b) => b.startS - a.startS)[0];
    const focused = document.activeElement === box.current;
    const audioBytes = (v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount;
    rows.push(
      ["src", v.currentSrc.replace(location.origin, "") || "—"],
      ["copy", copyLabel],
      ["readyState", READY[v.readyState] ?? String(v.readyState)],
      ["network", NET[v.networkState] ?? String(v.networkState)],
      ["focus", focused ? "player (keys captured)" : `${(document.activeElement as HTMLElement | null)?.id || document.activeElement?.tagName?.toLowerCase() || "body"} (keys pass)`, focused ? "good" : "warn"],
      ["paused", String(v.paused)],
      ["time", fmtMs(t)],
      ["duration", Number.isFinite(v.duration) ? fmtMs(v.duration) : "∞ (no duration)", Number.isFinite(v.duration) ? undefined : "warn"],
      ["rate", `${v.playbackRate.toFixed(2)}×`],
      ["volume", `${Math.round(v.volume * 100)}${v.muted ? " muted" : ""}`],
      ["A-B", ab.a != null ? `${fmtClock(ab.a)} – ${ab.b != null ? fmtClock(ab.b) : "…"}` : "off"],
      ["chapter", cur?.title ?? "—"],
      ["seekable", ranges(v.seekable)],
      ["buffered", ranges(v.buffered)],
      ["video", `${v.videoWidth}×${v.videoHeight}${fps ? ` · ${fps.toFixed(2)} fps` : ""}`],
      ["frame", fps ? `#${frameNumber(t, fps)}` : "—"],
      ["frames", q ? `${q.totalVideoFrames} total · ${q.droppedVideoFrames} dropped` : "—", q && q.droppedVideoFrames > 0 ? "warn" : undefined],
      ["audio decoded", audioBytes == null ? "n/a" : `${(audioBytes / 1e3).toFixed(0)} kB`, audioBytes === 0 && !v.paused && t > 1 ? "bad" : undefined],
      ["fullscreen", String(!!document.fullscreenElement)],
      ["error", v.error ? `${v.error.code} ${v.error.message}` : "none", v.error ? "bad" : undefined],
    );
  }
  const slow = seeks.filter((s) => s.ms > 300).length;

  return (
    <div class="stpanel" data-keep-focus="" role="region" aria-label="Player state">
      <div class="stp-head">
        <h4>State</h4>
        <span class="dim">live · press <kbd>i</kbd> to hide</span>
        <button class="ib" tabIndex={-1} aria-label="Close the State panel" onClick={onClose}>×</button>
      </div>
      <div class="stp-cols">
        <section>
          <div class="kv">
            {rows.map(([k, x, cls]) => (
              <>
                <b>{k}</b>
                <span class={cls ?? ""} title={x}>{x}</span>
              </>
            ))}
          </div>
        </section>
        <section>
          <h5>Seeks <span class="dim">{seeks.length ? `${seeks.length} · ${slow} over 300 ms` : "none yet"}</span></h5>
          <div class="kv">
            {seeks.slice(-8).reverse().map((s, i) => (
              <>
                <b key={`k${i}`}>{s.why}</b>
                <span key={`v${i}`} class={s.ms > 300 ? "warn" : ""}>{fmtClock(s.from)} → {fmtClock(s.to)} · {s.ms} ms</span>
              </>
            ))}
          </div>
          <h5>Key log <span class="dim">last {keys.length}</span></h5>
          <div class="klog">
            {keys.length === 0 && <span class="dim">no keys yet</span>}
            {[...keys].reverse().map((k, i) => (
              <span key={i} class={k.handled ? "on" : ""} title={`target: ${k.target}`}>
                <kbd>{k.key === " " ? "space" : k.key}</kbd>
                {k.handled ? " handled" : " passed"}
                {k.prevented && " · prev"}
                {!k.handled && <i class="dim"> · {k.target}</i>}
              </span>
            ))}
          </div>
          <p class="note dim">Keys are handled only while the Player has focus (click it, Tab to it, or Esc from the search box). A key marked <b>passed</b> reached the page instead.</p>
        </section>
        <section>
          <h5>Bindings</h5>
          <div class="binds">
            {BINDINGS.map(([ks, what], i) => (
              <span key={i}>
                {ks.map((k) => <kbd key={k}>{k}</kbd>)} {what}
              </span>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
