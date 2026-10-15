// The Player (spec 4, playback-architecture.md): a plain <video> over the Range server inside a focusable container
// that owns the mpv-style keys. State machine of what is on screen: loading -> (preparing) -> ready, or unavailable.
// Seeks (spec 4.1): the bar and the plain arrows snap to the playing Copy's keyframes once its index has arrived
// (one decoded frame instead of a GOP); Shift-arrows, frame steps, Chapters, `?t=` and Resume are exact.
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { bestCopy, needsPrepare, nextCopy, readPrepare } from "../shared/copies";
import { awaitCopy } from "../shared/prepare";
import { dispatchKey, type PlayerAction } from "../shared/keymap";
import {
  AB_OFF, FALLBACK_FPS, abLoopTarget, abToggle, clampTime, fmtClock, frameNumber, frameStepTarget, keyframeSeekTarget, speedBy, storedLoop, volumeBy, type AbLoop,
} from "../shared/playerMath";
import { RESUME_INTERVAL_MS, ResumeClock, startPosition } from "../shared/resume";
import { SeekThrottle } from "../shared/seekThrottle";
import { studioRoute, type SongStudioDto } from "../shared/studio";
import type { CopyDto, VideoDto } from "../shared/types";
import { CopyPicker, copyLabel } from "./CopyPicker";
import { StripFrame, Timeline, type ChapterMark } from "./Timeline";
import { StudioBar, type StudioCtl } from "./Studio";
import { StatePanel } from "./StatePanel";
import { AudioEngine } from "./audioEngine";
import { isDefaultAudio, type AudioState } from "../shared/audio";
import { api, apiError, replaceVideo } from "./data";
import type { Playlist } from "../shared/playlist";
import { openAt, reachedEnd, repeatIcon, resumeAllowed, seekWidens, type EntryRange, type Move } from "../shared/playlistPlayer";

export type { ChapterMark } from "./Timeline";

export interface PlayerCtl {
  time(): number;
  seekTo(t: number): void;
  say(text: string): void;
  focus(): void;
  /** The <video> element, for the Audio panel's meters. */
  video(): HTMLVideoElement | null;
}

type Phase = "loading" | "preparing" | "ready" | "unavailable" | "failed";

interface Props {
  video: VideoDto;
  /** `?t=` of the URL, else the Resume position. */
  startT: number | null;
  /** The Video's Chapters (any order); the timeline ticks and `!` `@` PgUp PgDn read them. */
  chapters: ChapterMark[];
  /** `c`: add a Chapter at the playhead. */
  onAddChapter?(t: number): void;
  /** The playhead, whenever it moves (the page derives the current Chapter from it). */
  onTime?(t: number): void;
  /** Filled with a handle on the Player so the Chapter cards can read the playhead, seek, flash the OSD and take focus back. */
  ctl?: { current: PlayerCtl | null };
  /** `t`: the Songs whose Studio tracks to use, best first (the Chapter the playhead is in, then the Video's). */
  studioSongs?(): string[];
  /** The State panel (`i`): shown when true; the page owns the flag so it can place the panel in the drawer slot. */
  stateOpen?: boolean;
  /** The Video came back changed from the server (a counted view): the parent keeps its own copy. */
  onVideo?: (v: VideoDto) => void;
  onStateToggle?(): void;
  /** `y`: open or close the lyrics drawer; returns an OSD notice when there is nothing to show. */
  onLyricsToggle?(): string | null;
  /** `a`: the Audio panel (spec 4.7); the page owns the flag and the settings. */
  audioOpen?: boolean;
  onAudioToggle?(): void;
  /** The Video's Audio settings, applied to the sound as they change; the chain is built only once they differ from the defaults or the panel opens. */
  audioSettings?: AudioState;
  /** Where the State panel renders when the page has a free drawer slot; inline under the Player otherwise. */
  stateHost?: { current: HTMLElement | null };
  /** `<` `>`: navigate to the neighbour in Playing from; the returned text goes to the OSD (null: nothing to step to). */
  onStep(dir: 1 | -1): string | null;
  /** The active Playlist (spec 4.8) or null: Playing from behaviour (the Video loops itself). */
  playlist?: Playlist | null;
  /** The part of this Video the current Entry plays; null with no Playlist. */
  entry?: EntryRange | null;
  /** The Entry ended (`end`) or `n` / `>` was pressed (`key`): the page advances the Playlist and navigates; the reply says what to do here. */
  onPlaylistNext?(via: "end" | "key"): { kind: Move["kind"]; label: string | null };
  /** `N` / `<`: the OSD text, null when there is no earlier Entry. */
  onPlaylistPrev?(): string | null;
  /** `x` / the shuffle icon: starts a whole-library Playlist when none is active, else toggles the Play order; returns the OSD text. */
  onPlaylistShuffle?(): string;
  /** `e` / the repeat icon: cycles Repeat; returns the OSD text. */
  onPlaylistRepeat?(): string;
  /** `q`: the Playlist panel (ticket #68). */
  onPlaylistPanelToggle?(): void;
  /** Whether the Playlist panel is open (the control-bar button shows it pressed). */
  playlistPanelOpen?: boolean;
  /** A seek or step went past the end of a Chapter Entry: it becomes a Video Entry. */
  onPlaylistWiden?(): void;
}

// Volume and mute survive stepping from one Video to the next within a page session (not persisted).
const audio = { volume: 1, muted: false };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const VOL_ICON = {
  off: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="m23 9-6 6M17 9l6 6" />
    </svg>
  ),
  low: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </svg>
  ),
  high: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 5a9 9 0 0 1 0 14" />
    </svg>
  ),
};
const FS_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </svg>
);
const SHUFFLE_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
  </svg>
);
const REPEAT_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="m17 2 4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </svg>
);
const PLAY_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);
const PAUSE_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
  </svg>
);

export function Player({ video, startT, chapters, onStep, onAddChapter, onTime, ctl, studioSongs, stateOpen, onVideo, onStateToggle, onLyricsToggle, stateHost, audioOpen, onAudioToggle, audioSettings, playlist = null, entry = null, onPlaylistNext, onPlaylistPrev, onPlaylistShuffle, onPlaylistRepeat, onPlaylistPanelToggle, playlistPanelOpen, onPlaylistWiden }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);

  // ---- what is on screen ----
  const [phase, setPhase] = useState<Phase>("loading");
  const [prep, setPrep] = useState<number | null>(null);
  const [copyId, setCopyId] = useState<number | null>(null);
  const [time, setTime] = useState(0);
  const [bufEnd, setBufEnd] = useState(0);
  const [paused, setPaused] = useState(true);
  const [rate, setRate] = useState(1);
  const [vol, setVol] = useState({ volume: audio.volume, muted: audio.muted });
  const [buffering, setBuffering] = useState(false);
  const [fs, setFs] = useState(false);
  const [ab, setAb] = useState<AbLoop>(() => storedLoop(video.loop) ?? AB_OFF); // a loop left set last time comes back (spec 4.3)
  const [aspect, setAspect] = useState<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null); // the bar is being dragged: the strip frame at this time covers the stage
  const [osd, setOsd] = useState<{ text: string; n: number } | null>(null);
  const [osdFlash, setOsdFlash] = useState(false);
  const [osdAlways, setOsdAlways] = useState(false);
  const [studio, setStudio] = useState<{ songId: string; data: SongStudioDto } | null>(null);
  const showState = !!stateOpen;
  const studioOn = useRef(false);
  studioOn.current = !!studio;
  const studioCtl = useRef<StudioCtl | null>(null);
  const studioBusy = useRef(false);
  const closeStudioRef = useRef<() => Promise<void>>(async () => {});

  // ---- mutable state that handlers read ----
  const V = useRef(video);
  V.current = video;
  const PL = useRef({ playlist, entry, next: onPlaylistNext, widen: onPlaylistWiden });
  PL.current = { playlist, entry, next: onPlaylistNext, widen: onPlaylistWiden };
  const R = useRef({
    copyId: null as number | null,
    token: 0, // bumped by every load and on unmount; a stale async load stops when it sees a newer one
    started: false, // metadata loaded and the start position applied: only then may Resume be written
    resumeOn: true, // false while no Copy plays, so the Resume position is kept as it was
    viewed: false, // a view is counted once per Now playing visit, the first time playback starts (spec 4.3)
    pending: { at: 0, play: true },
    failed: new Set<number>(),
    retries: new Map<number, number>(),
    lastPos: 0,
    hold: 0, // position kept while "Copy unavailable"
    keyframes: null as number[] | null, // the playing Copy's keyframe index, once fetched
    seekTarget: null as number | null, // the last requested seek while it is in flight or queued: held keys step from it
    wasPlaying: true,
    ab: (storedLoop(video.loop) ?? AB_OFF) as AbLoop,
    phase: "loading" as Phase,
    osdN: 0,
    osdTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    flashTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    seekWrite: 0 as unknown as ReturnType<typeof setTimeout>,
    firstT: true,
    entryDone: false, // the Entry's end was handled once; cleared when the playhead is back inside it
  });
  const rateRef = useRef(1);
  const alwaysRef = useRef(false);
  const clock = useRef(new ResumeClock(RESUME_INTERVAL_MS));
  const throttle = useRef(new SeekThrottle((t) => {
    const v = vid.current;
    if (v) v.currentTime = t;
  }));
  R.current.ab = ab;
  R.current.phase = phase;
  R.current.copyId = copyId;

  const copies = video.copies;
  const copy = copies.find((c) => c.id === copyId) ?? null;
  const duration = (vid.current && Number.isFinite(vid.current.duration) ? vid.current.duration : null) ?? copy?.durationS ?? video.durationS;

  const refocus = () => box.current?.focus({ preventScroll: true });

  // ---- OSD ----
  const say = (text: string, ms = 1400) => {
    const r = R.current;
    setOsd({ text, n: ++r.osdN });
    clearTimeout(r.osdTimer);
    r.osdTimer = setTimeout(() => setOsd(null), ms);
  };
  const flash = () => {
    const r = R.current;
    setOsdFlash(true);
    clearTimeout(r.flashTimer);
    r.flashTimer = setTimeout(() => setOsdFlash(false), 1600);
  };

  // ---- Resume (spec 4.3) ----
  const writeResume = (beacon = false) => {
    const r = R.current;
    if (!r.started || !r.resumeOn) return;
    const v = vid.current;
    const pos = v && v.readyState > 0 ? v.currentTime : r.lastPos;
    const url = `/api/videos/${V.current.id}/resume`;
    const body = JSON.stringify({ resumeS: pos, copyId: r.copyId });
    clock.current.wrote(Date.now());
    try {
      if (beacon && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      else void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
    } catch {}
  };

  // ---- loading a Copy ----
  const attach = (id: number, at: number, play: boolean) => {
    const v = vid.current;
    if (!v) return;
    const r = R.current;
    r.pending = { at, play };
    r.started = false;
    r.keyframes = null;
    r.seekTarget = null;
    throttle.current.reset();
    v.src = `/copy/${id}`;
    v.load();
  };

  /** The Copy's keyframe index (spec 4.1): asked for on load; a Copy being indexed is polled, one that cannot be is left exact. */
  const fetchKeyframes = async (id: number, token: number) => {
    for (let tries = 0; tries < 60; tries++) {
      const st = await api.keyframes(id).catch(() => null);
      if (token !== R.current.token || !st || st.state === "none") return;
      if (st.state === "ready") {
        R.current.keyframes = st.keyframes;
        return;
      }
      await sleep(3000);
    }
  };

  /** Waits out a "preparing" Fallback (spec 3.4): the overlay shows while `awaitCopy` polls. */
  const prepare = async (id: number, token: number): Promise<boolean> => {
    const res = await awaitCopy(id, {
      fetch: (url, init) => fetch(url, init),
      sleep,
      cancelled: () => token !== R.current.token,
      onProgress: (p) => {
        setPhase("preparing");
        setPrep(p);
      },
    });
    return res === "ready";
  };

  const loadCopy = async (id: number, at: number, play: boolean, forcePrepare = false) => {
    const r = R.current;
    const token = ++r.token;
    r.copyId = id;
    r.wasPlaying = play;
    r.resumeOn = resumeAllowed(!!PL.current.playlist); // inside a Playlist no Resume position is ever written (spec 4.8)
    setCopyId(id);
    setPhase("loading");
    setPrep(null);
    const c = V.current.copies.find((x) => x.id === id);
    if (forcePrepare || (c && needsPrepare(c))) {
      const ok = await prepare(id, token);
      if (token !== r.token) return;
      if (!ok) return void lose(id, true, at, play);
    }
    attach(id, at, play);
    void fetchKeyframes(id, token);
  };

  /** The playing Copy is gone (Root unmounted) or broken: next Available Copy at the same timestamp, else "Copy unavailable". */
  const lose = (id: number, markFailed: boolean, atOverride?: number, playOverride?: boolean) => {
    const r = R.current;
    const v = vid.current;
    const pos = atOverride ?? (v && v.readyState > 0 ? v.currentTime : r.lastPos);
    const wasPlaying = playOverride ?? (v ? !v.paused : r.wasPlaying);
    if (markFailed) r.failed.add(id);
    writeResume();
    const n = nextCopy(V.current.copies, id, r.failed);
    if (n) {
      say(`Switching to ${n.rootKind} Copy · ${copyLabel(n)}`, 2200);
      void loadCopy(n.id, pos, wasPlaying);
      return;
    }
    // none left: keep the Resume position, show the overlay
    r.token++;
    r.hold = pos;
    r.wasPlaying = wasPlaying;
    r.resumeOn = false;
    r.started = false;
    if (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    setPaused(true);
    setPhase(markFailed ? "failed" : "unavailable");
  };

  const pickCopy = (id: number) => {
    const v = vid.current;
    const pos = v && v.readyState > 0 ? v.currentTime : R.current.lastPos;
    writeResume();
    R.current.failed.delete(id);
    say(`Copy: ${copyLabel(V.current.copies.find((c) => c.id === id) ?? { container: null, height: null })}`);
    void loadCopy(id, pos, v ? !v.paused : true);
  };

  // open: pick the Preferred Copy and start at ?t= or the Resume position
  useEffect(() => {
    const r = R.current;
    const c = bestCopy(video.copies);
    if (!c) {
      r.resumeOn = false;
      r.hold = startPosition({ t: startT, resumeS: video.resumeS, durationS: video.durationS });
      setPhase("unavailable");
    } else {
      void loadCopy(c.id, openAt({ t: startT, resumeS: video.resumeS, durationS: c.durationS ?? video.durationS }, !!PL.current.playlist), true);
    }
    refocus();
    return () => {
      r.token++;
      clearTimeout(r.osdTimer);
      clearTimeout(r.flashTimer);
      clearTimeout(r.seekWrite);
      writeResume(true); // leaving the Player (route change) writes the position
      const v = vid.current;
      if (v) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
    };
  }, []);

  // a Playlist starting (or ending) under a playing Video: no Resume writes from now on (spec 4.8)
  useEffect(() => {
    if (R.current.started) R.current.resumeOn = resumeAllowed(!!playlist);
  }, [!!playlist]);

  // `?t=` changed while this Video is open (a Chapter row or result for the same Video): seek there
  useEffect(() => {
    const r = R.current;
    if (r.firstT) {
      r.firstT = false;
      return;
    }
    if (startT != null && r.started) seekTo(startT, "exact", undefined, false, true);
  }, [startT]);

  // the library poll: a Root unmounting under the playing Copy, or a Copy coming back after "unavailable"
  useEffect(() => {
    const r = R.current;
    const cur = copyId != null ? video.copies.find((c) => c.id === copyId) : null;
    if (phase === "unavailable" || phase === "failed") {
      const b = bestCopy(video.copies, r.failed);
      if (b) {
        say(`Copy available again · ${copyLabel(b)}`, 2200);
        void loadCopy(b.id, r.hold, r.wasPlaying);
      }
      return;
    }
    if (cur && (!cur.available || cur.missing)) lose(cur.id, false);
  }, [video, copyId, phase]);

  // ---- seeking ----
  type SeekMode = "exact" | "keyframe";
  /**
   * `keyframe` snaps to the Copy's keyframe index when it has arrived (nearest to `t`; for a relative seek `from` is
   * where it started, so it always moves). `throttled`: one seek in flight, the latest target wins (held keys).
   */
  const seekTo = (t: number, mode: SeekMode = "exact", from?: number, throttled = false, internal = false) => {
    const v = vid.current;
    if (!v || v.readyState === 0) return;
    const dur = Number.isFinite(v.duration) ? v.duration : null;
    let c = clampTime(t, dur);
    const pl = PL.current;
    if (!internal && pl.playlist && pl.entry && seekWidens(pl.entry, c)) pl.widen?.(); // past the Chapter Entry's end: it is a Video Entry now
    if (mode === "keyframe" && R.current.keyframes) c = clampTime(keyframeSeekTarget(c, R.current.keyframes, from), dur);
    R.current.seekTarget = c;
    throttle.current.request(c, throttled);
    setTime(c);
  };

  useEffect(() => onTime?.(time), [time]);
  if (ctl) ctl.current = { time: () => vid.current?.currentTime ?? time, seekTo: (t) => seekTo(t), say: (text) => say(text, 2200), focus: refocus, video: () => vid.current };

  // ---- Audio settings (spec 4.7) ----
  useEffect(() => {
    const v = vid.current;
    if (!v || !audioSettings) return;
    if (AudioEngine.has(v) || audioOpen || !isDefaultAudio(audioSettings)) AudioEngine.for(v).set(audioSettings);
  }, [audioSettings, audioOpen]);
  useEffect(() => () => {
    const v = vid.current;
    if (v && AudioEngine.has(v)) AudioEngine.for(v).dispose();
  }, []);

  // ---- media events ----
  useEffect(() => {
    const v = vid.current!;
    const r = R.current;
    const on = (ev: string, f: (e: Event) => void) => v.addEventListener(ev, f);
    on("loadedmetadata", () => {
      const { at, play } = r.pending;
      v.volume = audio.volume;
      v.muted = audio.muted;
      v.defaultPlaybackRate = v.playbackRate = rateRef.current;
      if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
      if (at > 0) v.currentTime = clampTime(at, v.duration);
      r.started = true;
      r.resumeOn = resumeAllowed(!!PL.current.playlist);
      r.lastPos = at;
      setTime(at);
      setPhase("ready");
      setBuffering(false);
      if (play) {
        v.play().catch(() => {
          setPaused(true);
          say("Press space to play", 3000);
        });
      }
    });
    on("play", () => {
      setPaused(false);
      // the Video resuming by any path (click on the frame, the ⏵ button) ends Studio playback: never both at once
      if (studioOn.current) void closeStudioRef.current();
    });
    on("playing", () => {
      setPaused(false);
      setBuffering(false);
      if (!r.viewed) {
        r.viewed = true;
        api.recordView(V.current.id).then((fresh) => (replaceVideo(fresh), onVideo?.(fresh))).catch(() => {});
      }
    });
    on("pause", () => {
      setPaused(v.paused);
      clock.current.stopped();
      if (r.started) {
        r.lastPos = v.currentTime;
        writeResume();
      }
      setTime(v.currentTime);
    });
    on("waiting", () => r.started && setBuffering(true));
    on("canplay", () => setBuffering(false));
    on("seeked", () => {
      throttle.current.landed();
      if (!throttle.current.busy) r.seekTarget = null;
      setTime(v.currentTime);
      r.lastPos = v.currentTime;
      clearTimeout(r.seekWrite);
      r.seekWrite = setTimeout(() => writeResume(), 400); // one write per burst of seeks (a scrub drag is many)
    });
    on("ratechange", () => {
      rateRef.current = v.playbackRate;
      setRate(v.playbackRate);
    });
    on("volumechange", () => {
      audio.volume = v.volume;
      audio.muted = v.muted;
      setVol({ volume: v.volume, muted: v.muted });
    });
    on("ended", () => {
      if (PL.current.playlist) return void entryEnded();
      // loop by default (as mpv's --loop-file): back to A with an A-B loop set, else to the start
      const t = abLoopTarget(r.ab, v.currentTime, true) ?? 0;
      v.currentTime = t;
      void v.play().catch(() => {});
    });
    on("error", () => void onMediaError());
    const fsChange = () => setFs(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", fsChange);

    // page leave: sendBeacon, so it survives the unload
    const leave = () => writeResume(true);
    const vis = () => document.visibilityState === "hidden" && writeResume(true);
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", vis);

    // The tick: time, buffered span, A-B loop and the 5 s Resume cadence. A timer, not requestAnimationFrame: a tab in
    // the background keeps playing audio, and rAF stops there, which would silently stop Resume writes and the loop.
    let lastUi = 0;
    const tick = () => {
      if (!r.started) return;
      const t = v.currentTime;
      r.lastPos = t;
      if (!v.paused) {
        const tgt = AudioEngine.has(v) && AudioEngine.for(v).measuring ? null : abLoopTarget(r.ab, t);
        if (tgt != null) seekTo(tgt, "exact", undefined, false, true);
        const pl = PL.current;
        if (pl.playlist && pl.entry?.end != null) {
          if (reachedEnd(pl.entry, t)) {
            if (!r.entryDone && !v.seeking) entryEnded();
          } else if (t < pl.entry.end - 0.5) r.entryDone = false;
        }
        if (clock.current.tick(Date.now(), true)) writeResume();
      }
      const now = performance.now();
      if (now - lastUi >= 100) {
        lastUi = now;
        if (!throttle.current.busy) setTime(t);
        let end = 0;
        for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) >= end) end = v.buffered.end(i);
        setBufEnd(end);
      }
    };
    const timer = setInterval(tick, 50);

    return () => {
      clearInterval(timer);
      document.removeEventListener("fullscreenchange", fsChange);
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);

  /** The current Entry is over (the Video ended, or a Chapter Entry reached the next Chapter): Repeat one restarts it, else the Playlist advances (spec 4.8). */
  const entryEnded = () => {
    const r = R.current;
    const v = vid.current;
    const { playlist: pl, entry: range, next } = PL.current;
    if (!pl || !v || !next || r.entryDone) return;
    r.entryDone = true;
    const move = next("end");
    if (move.kind === "restart") {
      seekTo(range?.start ?? 0, "exact", undefined, false, true);
      r.entryDone = false;
      void v.play().catch(() => {});
    } else if (move.kind === "ended") {
      v.pause();
      say("Playlist ended", 4000);
    } else if (move.label) say(move.label, 2200);
  };

  /** The element failed: ask the server why. A Fallback still being made is "preparing"; a gone Copy fails over. */
  const onMediaError = async () => {
    const r = R.current;
    const id = r.copyId;
    const v = vid.current;
    if (id == null || !v || !v.getAttribute("src")) return;
    const pos = r.started ? v.currentTime : r.pending.at;
    const play = r.started ? !v.paused : r.pending.play;
    const res = await fetch(`/copy/${id}`, { headers: { range: "bytes=0-0" } }).catch(() => null);
    if (R.current.copyId !== id) return;
    void res?.body?.cancel();
    if (res && res.status === 503) {
      const body = (await fetch(`/api/copies/${id}`).then((x) => x.json()).catch(() => null)) as CopyDto | null;
      if (body && body.playback !== "native" && readPrepare(body.fallback).kind !== "ready") return void loadCopy(id, pos, play, true);
      const tries = r.retries.get(id) ?? 0; // the drive hiccuped (EIO): try the same Copy twice more before giving up
      if (tries < 2) {
        r.retries.set(id, tries + 1);
        await sleep(1500);
        if (R.current.copyId === id) void loadCopy(id, pos, play);
        return;
      }
    }
    lose(id, true, pos, play);
  };

  // ---- actions ----
  const togglePause = () => {
    const v = vid.current;
    if (!v || !R.current.started) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };

  const takeScreenshot = async () => {
    const v = vid.current;
    if (!v || !v.videoWidth) return say("Screenshot: no frame yet");
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    const t = v.currentTime;
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
    if (!blob) return say("Screenshot failed");
    try {
      const res = await fetch(`/api/videos/${V.current.id}/screenshot?t=${t.toFixed(2)}`, { method: "POST", headers: { "content-type": "image/png" }, body: blob });
      const j = (await res.json()) as { saved?: string; error?: string };
      say(j.saved ? `Screenshot: ${j.saved.replace(/^\/Users\/[^/]+/, "~")}` : `Screenshot failed: ${j.error ?? res.status}`, 3200);
    } catch (e) {
      say(`Screenshot failed: ${(e as Error).message}`);
    }
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen().catch(() => {});
  };

  /** `t` (spec 7.4): the Video pauses on its frame and the Studio bar opens on the first Song that has Studio tracks. */
  const openStudio = async () => {
    if (studioBusy.current) return;
    studioBusy.current = true;
    try {
      const songs = studioSongs?.() ?? [];
      if (!songs.length) return say("no studio tracks", 2000);
      const found: SongStudioDto[] = [];
      for (const id of songs) found.push(await api.studio(id));
      const pick = found.find((d) => d.tracks.some((t) => t.state !== "missing")) ?? found.find((d) => d.tracks.length || d.missing.length);
      if (!pick) return say("no studio tracks", 2000);
      vid.current?.pause();
      setStudio({ songId: pick.songId, data: pick });
    } catch (e) {
      say(apiError(e), 2600);
    } finally {
      studioBusy.current = false;
    }
  };
  /** `t` again, Esc or ×: Music.app stops, the Video is still paused at the same timestamp. */
  const closeStudio = async () => {
    await studioCtl.current?.stop();
    setStudio(null);
    refocus();
  };
  closeStudioRef.current = closeStudio;

  /** The Playlist keys (spec 4.8). `n` at the end with Repeat off does nothing; `N` and the rest say what they did. */
  const playlistOp = (op: Extract<PlayerAction, { type: "playlist" }>["op"]) => {
    switch (op) {
      case "next": {
        if (!playlist) return say("No Playlist: press x to shuffle the library", 2000);
        const m = onPlaylistNext?.("key");
        if (m?.label) say(m.label, 2200);
        break;
      }
      case "prev": {
        if (!playlist) return say("No Playlist: press x to shuffle the library", 2000);
        const label = onPlaylistPrev?.();
        if (label) say(label, 2200);
        break;
      }
      case "shuffle":
        say(onPlaylistShuffle?.() ?? "Shuffle");
        break;
      case "repeat":
        say(playlist ? (onPlaylistRepeat?.() ?? "Repeat") : "Repeat: one (this Video loops; shuffle to start a Playlist)", 2000);
        break;
      case "panel":
        if (!playlist) return say("No Playlist: press x to shuffle the library", 2000);
        onPlaylistPanelToggle?.();
        break;
    }
  };

  const perform = (a: PlayerAction) => {
    const v = vid.current;
    if (!v) return;
    if (studioOn.current) {
      const route = studioRoute(a); // while the bar is active most keys belong to Music.app (spec 7.4)
      if (route.to === "music") return void studioCtl.current?.key(route.op);
      if (route.to === "exit") return void closeStudio();
      if (route.to === "noop") return say(route.notice, 1400);
    }
    const dur = Number.isFinite(v.duration) ? v.duration : null;
    switch (a.type) {
      case "togglePause":
        togglePause();
        flash();
        break;
      case "seekBy": {
        // a held key steps from the seek already requested, not from the frame still on screen
        const base = R.current.seekTarget ?? v.currentTime;
        seekTo(base + a.seconds, a.exact ? "exact" : "keyframe", base, true);
        flash();
        break;
      }
      case "frameStep": {
        const fps = copy?.frameRate ?? FALLBACK_FPS;
        v.pause();
        const target = frameStepTarget(v.currentTime, fps, a.dir, dur);
        seekTo(target);
        say(`Frame ${frameNumber(target, fps)}${copy?.frameRate ? "" : ` (${FALLBACK_FPS} fps assumed)`}`);
        break;
      }
      case "speedBy": {
        const r = speedBy(v.playbackRate, a.delta);
        v.defaultPlaybackRate = v.playbackRate = r;
        say(`Speed: ${r.toFixed(2)}×`);
        break;
      }
      case "speedSet":
        v.defaultPlaybackRate = v.playbackRate = a.rate;
        say(`Speed: ${a.rate.toFixed(2)}×`);
        break;
      case "volumeBy": {
        const n = volumeBy(v.volume, a.delta);
        v.volume = n;
        say(`Volume: ${Math.round(n * 100)}${v.muted ? " (muted)" : ""}`);
        break;
      }
      case "mute":
        v.muted = !v.muted;
        say(v.muted ? "Mute: yes" : "Mute: no");
        break;
      case "fullscreen":
        toggleFullscreen();
        break;
      case "abLoop": {
        const was = storedLoop(R.current.ab);
        const s = abToggle(R.current.ab, v.currentTime);
        R.current.ab = s.ab;
        setAb(s.ab);
        say(s.label);
        // persist a complete loop, and its clearing; a half-set A is not kept (spec 4.3)
        const now = storedLoop(s.ab);
        if (now || was) void api.setLoop(V.current.id, now).catch(() => {});
        break;
      }
      case "chapter": {
        if (!chapters.length) return say("no chapters");
        const sorted = [...chapters].sort((x, y) => x.startS - y.startS);
        let i = -1;
        sorted.forEach((c, k) => {
          if (v.currentTime >= c.startS - 0.001) i = k;
        });
        if (a.dir < 0 && i >= 0 && v.currentTime - sorted[i]!.startS >= 2) i += 1; // restart the current one first
        const to = sorted[Math.min(sorted.length - 1, Math.max(0, i + a.dir))]!;
        seekTo(to.startS);
        say(`Chapter: ${to.title}`);
        flash();
        break;
      }
      case "chapterAdd":
        if (onAddChapter) onAddChapter(v.currentTime);
        break;
      case "video": {
        if (playlist) {
          const label = a.dir > 0 ? onPlaylistNext?.("key").label : onPlaylistPrev?.();
          say(label ?? "No other Entry in the Playlist", 2200);
          break;
        }
        const label = onStep(a.dir);
        say(label ?? "No other Video in Playing from", 2200);
        break;
      }
      case "playlist":
        playlistOp(a.op);
        break;
      case "screenshot":
        void takeScreenshot();
        break;
      case "osd":
        if (a.always) {
          alwaysRef.current = !alwaysRef.current;
          setOsdAlways(alwaysRef.current);
          say(`OSD: ${alwaysRef.current ? "always" : "auto"}`);
        } else flash();
        break;
      case "studio":
        void openStudio();
        break;
      case "state":
        onStateToggle?.();
        break;
      case "lyrics": {
        const notice = onLyricsToggle?.();
        if (notice) say(notice, 2000);
        break;
      }
      case "audio":
        onAudioToggle?.();
        break;
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && studioOn.current && document.activeElement === box.current) {
      e.preventDefault();
      void closeStudio();
      return;
    }
    const { action, handled } = dispatchKey(e, { containerFocused: document.activeElement === box.current });
    if (!handled) return;
    e.preventDefault();
    if (action) perform(action);
  };

  // ---- render ----
  const fps = copy?.frameRate ?? null;
  const shownAspect = aspect ?? (copy?.width && copy?.height ? copy.width / copy.height : video.width && video.height ? video.width / video.height : 16 / 9);
  const volState = vol.muted || vol.volume === 0 ? "off" : vol.volume < 0.5 ? "low" : "high";
  const showStatus = osdAlways || osdFlash;
  const poster = video.thumbnail?.poster;
  const rep = repeatIcon(playlist);

  return (
    <div
      class={`player${fs ? " fs" : ""}${studio ? " studio-on" : ""}`}
      ref={box}
      tabIndex={0}
      data-player=""
      role="application"
      aria-label="Video player. Keys are active while this has focus."
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("[data-keep-focus]")) refocus();
      }}
    >
      <div class="stage" style={{ "--ar": String(shownAspect), aspectRatio: String(shownAspect) }}>
        <video
          ref={vid}
          class="vid"
          playsInline
          preload="auto"
          poster={poster}
          onClick={() => {
            togglePause();
            flash();
          }}
          onDblClick={toggleFullscreen}
        />
        {(osd || showStatus) && (
          <div class="osd mono" aria-live="polite">
            {osd && <div class="m">{osd.text}</div>}
            {showStatus && (
              <div class="s">
                {paused ? "⏸" : "▶"} {fmtClock(time)} / {fmtClock(duration)}
                {rate !== 1 && `  ${rate.toFixed(2)}×`}
                {vol.muted && "  muted"}
                {paused && fps != null && `  #${frameNumber(time, fps)}`}
              </div>
            )}
          </div>
        )}
        {scrub != null && (
          <div class="scrub" aria-hidden="true">
            <StripFrame video={video} t={scrub} width="min(60%, 560px)" />
            <span class="mono">{fmtClock(scrub)}</span>
          </div>
        )}
        {(buffering || phase === "loading") && <div class="spin" aria-label="Loading" />}
        {phase === "preparing" && (
          <div class="overlay" role="status">
            <div class="card">
              <h3>Preparing this Copy…</h3>
              <p>The browser cannot play the file as it is. A one-time conversion is running; playback starts when it lands.</p>
              <div class="pbar">
                <i style={prep != null ? { width: `${Math.round(prep * 100)}%` } : { width: "35%" }} class={prep == null ? "ind" : ""} />
              </div>
              <span class="mono dim">{prep != null ? `${Math.round(prep * 100)}%` : "working…"}</span>
            </div>
          </div>
        )}
        {(phase === "unavailable" || phase === "failed") && (
          <div class="overlay" role="alert">
            <div class="card">
              <h3>Copy unavailable</h3>
              <p>
                {phase === "failed"
                  ? "Every Copy of this Video failed to play."
                  : "No Copy of this Video is on a mounted drive right now. Plug the drive in and playback continues by itself."}{" "}
                Your place, <span class="mono">{fmtClock(R.current.hold)}</span>, is kept.
              </p>
            </div>
          </div>
        )}
      </div>
      <Timeline video={video} time={time} duration={duration} bufferedEnd={bufEnd} chapters={chapters} ab={ab} onSeek={(t) => seekTo(t, "keyframe")} onScrub={setScrub} />
      <div class="ctl" data-keep-focus="">
        <button class="ib" tabIndex={-1} title="Play / pause (space)" onClick={() => (togglePause(), refocus())}>
          {paused ? PLAY_ICON : PAUSE_ICON}
        </button>
        <span class="mono clock">
          {fmtClock(time)} <span class="dim">/ {fmtClock(duration)}</span>
        </span>
        {paused && fps != null && phase === "ready" && <span class="mono dim" title="Frame number">#{frameNumber(time, fps)}</span>}
        {rate !== 1 && <span class="mono rate">{rate.toFixed(2)}×</span>}
        {ab.a != null && (
          <span class="mono ablbl">
            A {fmtClock(ab.a)}
            {ab.b != null ? ` – B ${fmtClock(ab.b)}` : ""}
          </span>
        )}
        <button class={`cbtn statebtn plbtn${playlist?.shuffled ? " on" : ""}`} tabIndex={-1} aria-pressed={!!playlist?.shuffled} title={playlist ? `Shuffle ${playlist.shuffled ? "on" : "off"} (x while the Player has focus)` : "Shuffle the library into a Playlist (x while the Player has focus)"} onClick={() => (say(onPlaylistShuffle?.() ?? "Shuffle"), refocus())}>
          {SHUFFLE_ICON} <kbd>x</kbd>
        </button>
        <button class={`cbtn statebtn plbtn${rep.mode !== "off" && !rep.disabled ? " on" : ""}`} tabIndex={-1} disabled={rep.disabled} title={rep.disabled ? "Repeat: one. This Video loops until you pick another; shuffle starts a Playlist (e)" : `Repeat ${rep.mode}: click to cycle off, list, one (e while the Player has focus)`} onClick={() => (say(onPlaylistRepeat?.() ?? "Repeat"), refocus())}>
          {REPEAT_ICON} <span class="mono">{rep.mode}</span> <kbd>e</kbd>
        </button>
        <span class="grow" />
        <button class={`cbtn studiobtn${studio ? " on" : ""}`} tabIndex={-1} aria-pressed={!!studio} title="Studio playback in Music.app (t)" onClick={() => (studio ? void closeStudio() : void openStudio(), refocus())}>
          Studio
        </button>
        <CopyPicker copies={copies} playingId={copyId} onPick={pickCopy} refocus={refocus} />
        <button
          class="ib"
          tabIndex={-1}
          title={`Volume ${Math.round(vol.volume * 100)}${vol.muted ? " (muted)" : ""} (9 / 0, m)`}
          onClick={() => {
            if (vid.current) vid.current.muted = !vid.current.muted;
            refocus();
          }}
        >
          {VOL_ICON[volState]}
        </button>
        <button class="ib" tabIndex={-1} title="Fullscreen (f)" onClick={() => (toggleFullscreen(), refocus())}>
          {FS_ICON}
        </button>
        <button class={`cbtn statebtn${audioOpen ? " on" : ""}`} tabIndex={-1} aria-pressed={!!audioOpen} title="Audio: channels, equalizer, level (a while the Player has focus)" onClick={() => (onAudioToggle?.(), refocus())}>
          Audio <kbd>a</kbd>
        </button>
        <button class={`cbtn statebtn${showState ? " on" : ""}`} tabIndex={-1} aria-pressed={showState} title="State: metadata, playback, Copies and key bindings (i while the Player has focus)" onClick={() => (onStateToggle?.(), refocus())}>
          State <kbd>i</kbd>
        </button>
        <button class={`cbtn statebtn${playlistPanelOpen && playlist ? " on" : ""}`} tabIndex={-1} disabled={!playlist} aria-pressed={!!playlistPanelOpen && !!playlist} title={playlist ? "Playlist panel (q while the Player has focus)" : "Playlist panel: shuffle (x) to start a Playlist"} onClick={() => (onPlaylistPanelToggle?.(), refocus())}>
          Playlist <kbd>q</kbd>
        </button>
      </div>
      {studio && <StudioBar key={studio.songId} songId={studio.songId} initial={studio.data} say={(t, ms) => say(t, ms)} onClose={() => (setStudio(null), refocus())} ctl={studioCtl} />}
      {showState && (() => {
        const panel = <StatePanel vid={vid} box={box} video={video} copy={copy} fps={fps} ab={ab} chapters={chapters} onClose={() => (onStateToggle?.(), refocus())} />;
        return stateHost?.current ? createPortal(panel, stateHost.current) : panel;
      })()}
    </div>
  );
}
