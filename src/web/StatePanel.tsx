// The State panel (`i` or the State button): the Video's metadata, what the <video> element is doing, its Copies, and
// the key bindings. Refreshes 4x a second while shown. Styled like a code buffer: mono, `// section` comments, a line
// number per row, and values colored by kind (gruvbox: strings green, numbers purple, booleans orange, keys blue).
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { BINDINGS } from "../shared/keyguide";
import { fmtClock, frameNumber, type AbLoop } from "../shared/playerMath";
import type { CopyDto, VideoDto } from "../shared/types";
import type { ChapterMark } from "./Timeline";
import { api } from "./data";
import { FavoriteBadge, artistSlot, resolutionLabel } from "./ui";
import { VideoHistory } from "./History";

interface Props {
  vid: { current: HTMLVideoElement | null };
  box: { current: HTMLDivElement | null };
  video: VideoDto;
  /** The Copy playing now (null while none is chosen). */
  copy: CopyDto | null;
  fps: number | null;
  ab: AbLoop;
  chapters: ChapterMark[];
  onClose: () => void;
}

/** A row: key, value (already colored), optional hover text. `null` rows are skipped. */
type Row = { k: string; v: ComponentChildren; title?: string } | null;

const fmtMs = (s: number) => `${fmtClock(s)}.${String(Math.floor((s % 1) * 1000)).padStart(3, "0")}`;
const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);
const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
const fmtWhen = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ---- value renderers (the syntax colors) ----
const Num = ({ v, u }: { v: string | number; u?: string }) => (
  <>
    <span class="n">{v}</span>
    {u && <span class="u">{u}</span>}
  </>
);
const Str = ({ v }: { v: string }) => <span class="s">{v}</span>;
const Bool = ({ v }: { v: boolean }) => <span class="b">{String(v)}</span>;
const Nil = ({ v = "null" }: { v?: string }) => <span class="nil">{v}</span>;
const Dim = ({ children }: { children: ComponentChildren }) => <span class="u">{children}</span>;

/** Seconds of media buffered past `t` (0 when nothing buffered holds `t`). */
export function bufferedAhead(r: TimeRanges | undefined, t: number): number {
  if (!r) return 0;
  for (let i = 0; i < r.length; i++) if (r.start(i) <= t + 0.5 && r.end(i) >= t) return Math.max(0, r.end(i) - t);
  return 0;
}

function Kv({ rows }: { rows: Row[] }) {
  return (
    <div class="kv">
      {rows.filter((r): r is NonNullable<Row> => r != null).map((r) => (
        <>
          <b>{r.k}</b>
          <span title={r.title}>{r.v}</span>
        </>
      ))}
    </div>
  );
}

function Section({ name, color, aside, children }: { name: string; color: string; aside?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class={`stp-sec ${name}`} style={{ "--c": `var(--${color})` }}>
      <h5>
        <span class="nm">{name}</span>
        {aside && <span class="aside">{aside}</span>}
      </h5>
      {children}
    </section>
  );
}

function CopyRow({ c, playing, preferred }: { c: CopyDto; playing: boolean; preferred: boolean }) {
  const [revealErr, setRevealErr] = useState<string | null>(null);
  const mode = c.playback === "native" ? null : c.fallback.state === "ready" ? c.playback : `${c.playback} · ${c.fallback.state}${c.fallback.error ? `: ${c.fallback.error}` : ""}`;
  return (
    <div class={`cp${playing ? " playing" : ""}${c.missing || !c.available ? " off" : ""}`} title={c.url}>
      <div class="cp1">
        <span class={`root ${c.rootKind}`}>{c.rootKind}</span>
        <span class="s">{[c.container, resolutionLabel(c.height)].filter(Boolean).join(" · ") || "Copy"}</span>
        {playing && <span class="flag on">playing</span>}
        {!playing && preferred && <span class="flag">preferred</span>}
        {c.missing ? <span class="flag bad">missing</span> : !c.available && <span class="flag nil">unavailable</span>}
      </div>
      <div class="cp2">
        {[c.videoCodec, c.audioCodec].filter(Boolean).join(" / ") || "?"}
        {c.width && c.height && <> · {c.width}×{c.height}</>}
        {c.frameRate != null && <> · {c.frameRate.toFixed(2)} fps</>}
        {" · "}{fmtSize(c.size)}
        {mode && <span class="warn"> · {mode}</span>}
      </div>
      <button class="cp3 p" title="Show in the Finder" onClick={() => api.revealCopy(c.id).then(() => setRevealErr(null), (e: Error) => setRevealErr(e.message))}>
        {c.path}
      </button>
      {revealErr && <div class="bad">{revealErr}</div>}
    </div>
  );
}

/** The panel's tab: the live state, or the Video's edit history (§4.8). Kept across Videos for this tab. */
let lastTab: "state" | "history" = "state";

export function StatePanel({ vid, box, video, copy, fps, ab, chapters, onClose }: Props) {
  const [, tick] = useState(0);
  const [tab, setTabState] = useState(lastTab);
  const setTab = (t: typeof tab) => ((lastTab = t), setTabState(t));
  useEffect(() => {
    if (tab !== "state") return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [tab]);

  const v = vid.current;
  const t = v?.currentTime ?? 0;
  const sorted = [...chapters].sort((a, b) => a.startS - b.startS);
  const curIdx = sorted.findLastIndex((c) => c.startS <= t);
  const cur = curIdx >= 0 ? sorted[curIdx] : undefined;
  const focused = document.activeElement === box.current;
  // (the header badge reads v.paused directly, so it follows play/pause within one tick)
  const focusedName = (document.activeElement as HTMLElement | null)?.id || document.activeElement?.tagName?.toLowerCase() || "body";
  const dur = v && Number.isFinite(v.duration) ? v.duration : video.durationS;

  const meta: Row[] = [
    { k: "id", v: <Num v={`#${video.id}`} /> },
    { k: "title", v: <Str v={video.title} />, title: video.title },
    video.titleLatin ? { k: "latin", v: <><Str v={video.titleLatin} />{video.titleLatinSource && <Dim> · {video.titleLatinSource}</Dim>}</>, title: video.titleLatin } : null,
    { k: "type", v: <><span class={`tp type-${video.type}`}>{video.type}</span>{video.typeSuggested && <Dim> · suggested</Dim>}</> },
    {
      k: "artists",
      v: video.artists.length ? video.artists.map((a, i) => (
        <>
          {i > 0 && <Dim>, </Dim>}
          <span class={a.suggested ? "sug" : ""} style={{ color: `var(--t${artistSlot(a.name)})` }} title={a.nameLatin ?? undefined}>{a.name}</span>
          {a.proposed && <span class="flag local"> proposed</span>}
        </>
      )) : <Nil v="none" />,
    },
    {
      k: "song",
      v: video.song ? (
        <>
          <Str v={video.song.name ?? "unknown song"} />
          {video.song.englishName && <Dim> · {video.song.englishName}</Dim>}
          {video.song.local && <span class="flag local"> local</span>}
          {video.song.proposed && <span class="flag local"> proposed</span>}
          {video.songSuggested && <Dim> · suggested{video.suggestionSource ? ` (${video.suggestionSource})` : ""}</Dim>}
        </>
      ) : <Nil v="none" />,
      title: video.song?.name ?? undefined,
    },
    video.youtubeId ? { k: "youtube", v: <a class="p" href={`https://www.youtube.com/watch?v=${video.youtubeId}`} target="_blank" rel="noopener noreferrer">{video.youtubeId}</a> } : null,
    video.instagramId ? { k: "instagram", v: <a class="p" href={`https://www.instagram.com/p/${video.instagramId}/`} target="_blank" rel="noopener noreferrer">{video.instagramId}</a> } : null,
    { k: "duration", v: dur != null ? <Num v={fmtClock(dur)} /> : <Nil /> },
    { k: "chapters", v: <Num v={chapters.length} /> },
    { k: "views", v: <Num v={video.viewCount} />, title: "Right-click the Video in a list to reset" },
    { k: "added", v: fmtDate(video.addedAt) ? <Num v={fmtDate(video.addedAt)!} /> : <Nil /> },
    { k: "last played", v: fmtWhen(video.lastPlayedAt) ? <Num v={fmtWhen(video.lastPlayedAt)!} /> : <Nil v="never" /> },
    video.resumeS != null ? { k: "resume", v: <Num v={fmtClock(video.resumeS)} /> } : null,
    { k: "favorite", v: video.favoritedAt ? <span class="stfav"><FavoriteBadge /><span class="warn">{fmtDate(video.favoritedAt)}</span></span> : <Bool v={false} /> },
  ];

  let live: Row[] = [];
  if (v) {
    const q = v.getVideoPlaybackQuality?.();
    const ahead = bufferedAhead(v.buffered, t);
    const state = v.error ? "error" : v.ended ? "ended" : v.paused ? "paused" : v.readyState < 3 ? "buffering" : "playing";
    const stateCls = { error: "bad", ended: "nil", paused: "warn", buffering: "warn", playing: "good" }[state];
    live = [
      { k: "state", v: <span class={stateCls}>{state}</span> },
      { k: "time", v: <><Num v={fmtMs(t)} />{dur ? <Dim> / {fmtMs(dur)} · {((t / dur) * 100).toFixed(1)}%</Dim> : null}</> },
      { k: "rate", v: <span class={v.playbackRate === 1 ? "n" : "warn"}>{v.playbackRate.toFixed(2)}×</span> },
      { k: "volume", v: <><Num v={Math.round(v.volume * 100)} />{v.muted && <span class="bad"> muted</span>}</> },
      { k: "A-B", v: ab.a != null ? <Str v={`${fmtClock(ab.a)} – ${ab.b != null ? fmtClock(ab.b) : "…"}`} /> : <Nil v="off" /> },
      { k: "chapter", v: cur ? <><Str v={cur.title} /><Dim> · {curIdx + 1}/{sorted.length}</Dim></> : <Nil v={sorted.length ? "before first" : "none"} />, title: cur?.title },
      { k: "frame", v: fps ? <><Num v={`#${frameNumber(t, fps)}`} /><Dim> @ {fps.toFixed(2)} fps</Dim></> : <Nil v="fps unknown" /> },
      { k: "dropped", v: q ? <><span class={q.droppedVideoFrames > 0 ? "warn" : "n"}>{q.droppedVideoFrames}</span><Dim> of {q.totalVideoFrames}</Dim></> : <Nil /> },
      { k: "buffered", v: <span class={ahead < 2 && !v.paused ? "warn" : "n"}>+{ahead.toFixed(1)} s</span>, title: "Media buffered past the playhead" },
      { k: "video", v: v.videoWidth ? <Num v={`${v.videoWidth}×${v.videoHeight}`} /> : <Nil /> },
      { k: "focus", v: focused ? <span class="good">player <Dim>· keys captured</Dim></span> : <span class="warn">{focusedName} <Dim>· keys pass</Dim></span> },
      v.error ? { k: "error", v: <span class="bad">{v.error.code} {v.error.message}</span> } : null,
    ];
  }

  return (
    <div class="stpanel" data-keep-focus="" role="region" aria-label="Player state">
      <div class="stp-head">
        <div class="stp-tabs" role="tablist">
          <button role="tab" tabIndex={-1} aria-selected={tab === "state"} class={tab === "state" ? "on" : ""} onClick={() => setTab("state")}>State</button>
          <button role="tab" tabIndex={-1} aria-selected={tab === "history"} class={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History</button>
        </div>
        {v && !v.paused && !v.ended ? <span class="live on"><i /> live</span> : <span class="live"><i /> {v?.ended ? "ended" : "paused"}</span>}
        <span class="dim">press <kbd>i</kbd> to hide</span>
        <button class="ib" tabIndex={-1} aria-label="Close the State panel" onClick={onClose}>×</button>
      </div>
      {tab === "history" ? <VideoHistory videoId={video.id} shared={video.shared} /> : <div class="stp-cols">
        <Section name="video" color="t3">
          <Kv rows={meta} />
        </Section>
        <Section name="playback" color="t4" aside={copy ? <span class="s">{[copy.container, resolutionLabel(copy.height)].filter(Boolean).join(" · ")}</span> : <Nil v="no Copy" />}>
          {v ? <Kv rows={live} /> : <p class="nil">no &lt;video&gt; yet</p>}
        </Section>
        <Section name="copies" color="t6" aside={<Num v={video.copies.length} />}>
          <div class="cps">
            {video.copies.map((c) => <CopyRow key={c.id} c={c} playing={copy?.id === c.id} preferred={video.preferredCopyId === c.id} />)}
            {video.copies.length === 0 && <p class="nil">none</p>}
          </div>
        </Section>
        <Section name="keys" color="t8" aside={<Dim>while the Player has focus</Dim>}>
          <div class="binds">
            {BINDINGS.map(([ks, what], i) => (
              <span key={i}>
                {ks.map((k) => <kbd key={k}>{k}</kbd>)} {what}
              </span>
            ))}
          </div>
        </Section>
      </div>}
    </div>
  );
}
