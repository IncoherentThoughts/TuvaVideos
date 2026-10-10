// The Player's timeline bar (spec 4.6): progress and buffered span, chapter ticks (drawn from a list that is empty until
// ticket #26), A-B markers, and a hover preview with the scrub-strip frame and timestamp above the pointer.
// Drag scrubs through the throttled path; a plain press seeks at once.
import { useRef, useState } from "preact/hooks";
import { tileForTime } from "../server/stripGeometry";
import { fmtClock } from "../shared/playerMath";
import type { VideoDto } from "../shared/types";

export interface ChapterMark {
  startS: number;
  title: string;
  suggested: boolean;
}

interface Props {
  video: VideoDto;
  time: number;
  duration: number | null;
  bufferedEnd: number;
  chapters: ChapterMark[];
  ab: { a: number | null; b: number | null };
  /** `throttled` is true for pointer moves while dragging. */
  onSeek(t: number, throttled: boolean): void;
}

const PREVIEW_W = 160;

function Sprite({ video, t }: { video: VideoDto; t: number }) {
  const strip = video.thumbnail?.strip;
  if (!strip || !video.durationS) return null;
  const tile = tileForTime(t, video.durationS, { frames: strip.frames, columns: strip.columns, rows: strip.rows });
  const x = strip.columns > 1 ? (tile.column / (strip.columns - 1)) * 100 : 0;
  const y = strip.rows > 1 ? (tile.row / (strip.rows - 1)) * 100 : 0;
  const ratio = strip.frameWidth && strip.frameHeight ? strip.frameWidth / strip.frameHeight : 16 / 9;
  return (
    <div
      class="tl-sprite"
      style={{
        width: `${PREVIEW_W}px`,
        aspectRatio: String(ratio),
        backgroundImage: `url(${strip.url})`,
        backgroundSize: `${strip.columns * 100}% ${strip.rows * 100}%`,
        backgroundPosition: `${x}% ${y}%`,
      }}
    />
  );
}

export function Timeline({ video, time, duration, bufferedEnd, chapters, ab, onSeek }: Props) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const moved = useRef(false);
  const dur = duration && duration > 0 ? duration : null;

  const at = (e: PointerEvent) => {
    const r = bar.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return { f, x: f * r.width, w: r.width, t: f * (dur ?? 0) };
  };
  const pct = (t: number) => (dur ? `${Math.min(100, Math.max(0, (t / dur) * 100))}%` : "0%");

  const shown = drag ?? time;
  const half = PREVIEW_W / 2 + 4;

  return (
    <div
      class="tl"
      ref={bar}
      role="slider"
      aria-label="Position"
      aria-valuemin={0}
      aria-valuemax={dur ?? 0}
      aria-valuenow={Math.round(shown)}
      data-keep-focus=""
      onPointerDown={(e) => {
        if (!dur || e.button !== 0) return;
        bar.current!.setPointerCapture(e.pointerId);
        const p = at(e);
        moved.current = false;
        setDrag(p.t);
        onSeek(p.t, false); // a click is never throttled
      }}
      onPointerMove={(e) => {
        if (!dur) return;
        const p = at(e);
        setHover({ x: Math.min(p.w - half, Math.max(half, p.x)), t: p.t });
        if (drag !== null) {
          moved.current = true;
          setDrag(p.t);
          onSeek(p.t, true);
        }
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        const p = at(e);
        setDrag(null);
        if (moved.current) onSeek(p.t, false); // after a drag the release lands exactly where the pointer is
      }}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
    >
      <div class="tl-track">
        <i class="tl-buf" style={{ width: pct(bufferedEnd) }} />
        <i class="tl-done" style={{ width: pct(shown) }} />
        {ab.a != null && ab.b != null && <i class="tl-ab" style={{ left: pct(ab.a), width: `calc(${pct(ab.b)} - ${pct(ab.a)})` }} />}
        {ab.a != null && <i class="tl-abm" style={{ left: pct(ab.a) }} title={`A ${fmtClock(ab.a)}`} />}
        {ab.b != null && <i class="tl-abm" style={{ left: pct(ab.b) }} title={`B ${fmtClock(ab.b)}`} />}
        {chapters.map((c) => (
          <i key={c.startS} class={`tl-tick${c.suggested ? " sug" : ""}`} style={{ left: pct(c.startS) }} title={`${fmtClock(c.startS)} ${c.title}`} />
        ))}
        <b class="tl-head" style={{ left: pct(shown) }} />
      </div>
      {hover && dur && (
        <div class="tl-hover" style={{ left: `${hover.x}px` }}>
          <Sprite video={video} t={hover.t} />
          <span class="mono">{fmtClock(hover.t)}</span>
        </div>
      )}
    </div>
  );
}
