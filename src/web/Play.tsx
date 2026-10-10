// /play/:videoId[?t=] — the Now playing screen (spec 5.3): the Player on top, the title row, then availability icon,
// favorite badge, Type and Artist tags, with the Chapter strip area reserved below (ticket #26) and the Lyrics
// drawer as a closed placeholder (ticket #25).
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { positionIn, resolvePlayingFrom, SOURCE_LABEL, stepFrom } from "../shared/playingFrom";
import type { VideoDto } from "../shared/types";
import { Player, type ChapterMark } from "./Player";
import { api, setLastPlayed, toggleFavorite, useStore } from "./data";
import { loadPlayingFrom, onPlayingFromChange, savePlayingFrom } from "./playingFrom";
import { navigate, playHref } from "./router";
import { AvailabilityIcon, FavoriteBadge, Tags, fmtDuration } from "./ui";

/** Chapters arrive with ticket #26; the Player, the timeline ticks and the strip area already take this list. */
const NO_CHAPTERS: ChapterMark[] = [];

const POLL_MS = 3000;

export function Play({ videoId, t }: { videoId: number; t: number | null }) {
  const { videos } = useStore();
  const [v, setV] = useState<VideoDto | null | undefined>(undefined);

  // load, then poll: Root availability changes under a playing Copy are seen here (spec 4.2)
  useEffect(() => {
    setLastPlayed(videoId);
    setV(undefined);
    let alive = true;
    api.video(videoId).then((r) => alive && setV(r)).catch(() => alive && setV(null));
    const timer = setInterval(() => {
      api.video(videoId).then((r) => alive && setV(r)).catch(() => {});
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [videoId]);

  // Playing from: the snapshot taken when this Video was opened from a list; library order otherwise
  const [snapVersion, setSnapVersion] = useState(0);
  useEffect(() => onPlayingFromChange(() => setSnapVersion((n) => n + 1)), []);
  const playingFrom = useMemo(
    () => resolvePlayingFrom(loadPlayingFrom(), videoId, videos ? videos.map((x) => x.id) : [videoId]),
    [videoId, videos, snapVersion],
  );
  useEffect(() => {
    // keep the library-order fallback across a reload; never replace a list snapshot that still holds the Video
    if (videos && playingFrom.source === "library" && loadPlayingFrom()?.ids.includes(videoId) !== true) savePlayingFrom("library", playingFrom.ids);
  }, [playingFrom, videos, videoId]);

  const byId = useMemo(() => new Map((videos ?? []).map((x) => [x.id, x])), [videos]);
  const pos = positionIn(playingFrom, videoId);

  const onStep = useCallback(
    (dir: 1 | -1): string | null => {
      // Videos with no Available Copy are skipped: stepping onto one would only show "Copy unavailable"
      const to = stepFrom(playingFrom, videoId, dir, (id) => byId.get(id)?.available ?? true);
      if (to == null) return null;
      navigate(playHref(to));
      return `${dir > 0 ? "Next" : "Previous"}: ${byId.get(to)?.title ?? `Video ${to}`}`;
    },
    [playingFrom, videoId, byId],
  );

  const refresh = () => api.video(videoId).then(setV).catch(() => {});

  if (v === undefined) return <div class="np"><p class="muted">Loading…</p></div>;
  if (v === null || v.id !== videoId) return <div class="empty-state">No such Video.</div>;

  return (
    <div class="np">
      <div class="np-main">
        <Player key={v.id} video={v} startT={t} chapters={NO_CHAPTERS} onStep={onStep} />
        <div class="np-head">
          <div class="np-titlerow">
            <h1 title={v.titleLatin ?? undefined}>{v.title}</h1>
            <span class="from mono" title="< and > step through this list">
              Playing from: {SOURCE_LABEL[playingFrom.source]}
              {pos && <> · {pos.n} of {pos.total}</>}
            </span>
          </div>
          {v.titleLatin && <div class="latin muted">{v.titleLatin}</div>}
          <div class="np-meta">
            <AvailabilityIcon availability={v.availability} />
            <button
              class="favtoggle"
              aria-pressed={!!v.favoritedAt}
              aria-label={v.favoritedAt ? "Remove from Favorites" : "Add to Favorites"}
              title={v.favoritedAt ? "Favorite: click to remove" : "Click to add to Favorites"}
              onClick={() => {
                void toggleFavorite("video", v.id).then(refresh);
                document.querySelector<HTMLElement>("[data-player]")?.focus({ preventScroll: true });
              }}
            >
              <FavoriteBadge off={!v.favoritedAt} />
            </button>
            <Tags video={v} />
            <span class="mono dim">{fmtDuration(v.durationS)}</span>
          </div>
        </div>
        <div class="chapter-strip" aria-label="Chapters">
          <span class="dim">No Chapters yet</span>
        </div>
      </div>
      <aside class="drawer-closed" title="Lyrics arrive with the archive import (ticket #25)" aria-disabled="true">
        <span>Lyrics</span>
      </aside>
    </div>
  );
}
