// The Playlist panel (spec 4.8 "Panel", `q` or the control-bar button): the Entries in Play order in the drawer column.
// Controlled: the page owns the Playlist (src/web/playlist.ts), the open flag and "show played"; this renders the rows
// (windowed, 25 at a time, inside the panel's own scrolling body) and reports clicks.
import { useEffect, useRef, useState } from "preact/hooks";
import { position, type Entry, type Playlist } from "../shared/playlist";
import { panelRows } from "../shared/playlistPanel";
import type { ChapterDto, VideoDto } from "../shared/types";
import { api } from "./data";
import { Poster, Tags } from "./ui";
import { useWindowed } from "./windowed";

export const PANEL_STEP = 25;

interface Props {
  playlist: Playlist;
  /** Which Playlist start this is: the window starts over with a new one. */
  gen: number;
  videos: ReadonlyMap<number, VideoDto>;
  showPlayed: boolean;
  onShowPlayed(): void;
  onJump(entryIndex: number): void;
  onPrev(): void;
  onNext(): void;
  onShuffle(): void;
  onRepeat(): void;
  onClose(): void;
}

const ico = (d: string) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const PREV = ico("M19 20 9 12l10-8zM5 19V5");
const NEXT = ico("m5 4 10 8-10 8zM19 5v14");
const SHUFFLE = ico("M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5");
const REPEAT = ico("m17 2 4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3");
const HISTORY = ico("M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2");

/** Chapters per Video, fetched when a Chapter Entry row first shows and kept for the panel's life. */
function useChapterTitles(): (e: Entry) => string | null {
  const cache = useRef(new Map<number, ChapterDto[] | "loading">());
  const [, bump] = useState(0);
  return (e) => {
    if (e.chapterId === undefined) return null;
    const hit = cache.current.get(e.videoId);
    if (hit === undefined) {
      cache.current.set(e.videoId, "loading");
      api.chapters(e.videoId).then((l) => cache.current.set(e.videoId, l)).catch(() => cache.current.set(e.videoId, [])).finally(() => bump((n) => n + 1));
    }
    if (!Array.isArray(hit)) return "Chapter";
    return hit.find((c) => c.id === e.chapterId)?.title || "untitled chapter";
  };
}

export function PlaylistPanel({ playlist: pl, gen, videos, showPlayed, onShowPlayed, onJump, onPrev, onNext, onShuffle, onRepeat, onClose }: Props) {
  const rows = panelRows(pl, showPlayed);
  const body = useRef<HTMLDivElement>(null);
  const curAt = rows.findIndex((r) => r.kind === "current");
  const { limit, sentinel } = useWindowed(`${gen}`, rows.length, PANEL_STEP, { root: body, local: true });
  // the current row is always rendered, however many Played rows sit above it
  const shown = Math.max(limit, curAt + 1);
  const chapterTitle = useChapterTitles();
  const { n, total } = position(pl);
  const curEntry = pl.order[pl.cursor];

  // keep the current Entry in view as it changes (and when Played rows appear above it)
  useEffect(() => {
    body.current?.querySelector<HTMLElement>("[data-current]")?.scrollIntoView({ block: "nearest" });
  }, [curEntry, showPlayed, gen]);

  return (
    <aside class="drawer playlist" tabIndex={-1} data-keep-focus="" role="region" aria-label="Playlist" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onClose())}>
      <div class="hd">
        <div class="row">
          <span class="ttl">Playlist</span>
          <span class="hctl">
            <button class="ib" aria-label="Previous (N)" title="Previous (N)" onClick={onPrev}>{PREV}</button>
            <button class="ib" aria-label="Next (n)" title="Next (n)" onClick={onNext}>{NEXT}</button>
            <button class={`ib${pl.shuffled ? " on" : ""}`} aria-pressed={pl.shuffled} aria-label="Shuffle (x)" title={`Shuffle ${pl.shuffled ? "on" : "off"} (x)`} onClick={onShuffle}>{SHUFFLE}</button>
            <button class={`ib rep${pl.repeat !== "off" ? " on" : ""}`} aria-label={`Repeat ${pl.repeat} (e)`} title={`Repeat ${pl.repeat}: click to cycle off, list, one (e)`} onClick={onRepeat}>
              {REPEAT}
              {pl.repeat !== "off" && <sup>{pl.repeat}</sup>}
            </button>
            <button class={`ib${showPlayed ? " on" : ""}`} aria-pressed={showPlayed} aria-label="Show played" title="Show played Entries above the current one" onClick={onShowPlayed}>{HISTORY}</button>
            <button class="ib close" aria-label="Close Playlist (q)" title="Close (q, Esc); the Playlist keeps playing" onClick={onClose}>×</button>
          </span>
        </div>
        <div class="count mono dim">{n} of {total}</div>
      </div>
      <div class="body plbody" ref={body}>
        {rows.slice(0, shown).map((r) => {
          const e = pl.entries[r.entryIndex]!;
          const v = videos.get(e.videoId);
          const ch = chapterTitle(e);
          const off = v ? !v.available : true;
          return (
            <button
              key={`${r.kind === "current" ? "c" : "e"}${r.entryIndex}`}
              class={`plrow ${r.kind}${off ? " off" : ""}`}
              data-current={r.kind === "current" ? "" : undefined}
              aria-current={r.kind === "current" ? "true" : undefined}
              title={r.kind === "played" ? "Played: click to play it again" : undefined}
              onClick={() => onJump(r.entryIndex)}
            >
              {v ? <Poster video={v} /> : <div class="thumb ph unavail" />}
              <span class="pltxt">
                <span class="pltitle">{v?.title ?? `Video ${e.videoId}`}</span>
                {v?.titleLatin && <span class="pllatin dim">{v.titleLatin}</span>}
                {ch && <span class="plchap">{ch}</span>}
                {v && <Tags video={v} />}
              </span>
            </button>
          );
        })}
        {shown < rows.length && <div ref={sentinel} class="plsentinel" />}
      </div>
    </aside>
  );
}
