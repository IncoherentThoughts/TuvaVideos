// /play/:videoId[?t=] — the Now playing screen (spec 5.3): the Player on top, the title row, then availability icon,
// favorite badge, Type and Artist tags (edited inline, HeaderEdit.tsx), with the Chapter strip area reserved below
// (ticket #26) and the Lyrics drawer on the right (Lyrics.tsx, spec 5.4).
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { lyricsTarget } from "../shared/lyrics/target";
import { positionIn, resolvePlayingFrom, SOURCE_LABEL, stepFrom } from "../shared/playingFrom";
import type { VideoDto } from "../shared/types";
import { Player, type ChapterMark } from "./Player";
import { api, setLastPlayed, toggleFavorite, useStore } from "./data";
import { loadPlayingFrom, onPlayingFromChange, savePlayingFrom } from "./playingFrom";
import { navigate, playHref } from "./router";
import { HeaderFields, HeaderTitle } from "./HeaderEdit";
import { LyricsReader } from "./Lyrics";
import { AvailabilityIcon, FavoriteBadge, fmtDuration } from "./ui";

/** Chapters arrive with ticket #26; the Player, the timeline ticks and the strip area already take this list. */
const NO_CHAPTERS: ChapterMark[] = [];

const POLL_MS = 3000;

export function Play({ videoId, t, lyrics, lyricsVersion }: { videoId: number; t: number | null; lyrics: string | null; lyricsVersion: string | null }) {
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

  // The drawer: closed by default; opened by its button or by choosing a Song in the search box (`?lyrics=<song>`).
  const [drawer, setDrawer] = useState(!!lyrics);
  const [focusDrawer, setFocusDrawer] = useState(!!lyrics);
  const seenParam = useRef(lyrics);
  useEffect(() => {
    if (lyrics && (lyrics !== seenParam.current || !drawer)) (setDrawer(true), setFocusDrawer(true));
    seenParam.current = lyrics;
  }, [lyrics, lyricsVersion]);
  const closeDrawer = () => {
    setDrawer(false);
    setFocusDrawer(false);
    if (lyrics) navigate(playHref(videoId, t), { replace: true });
    document.querySelector<HTMLElement>("[data-player]")?.focus({ preventScroll: true });
  };
  // Chapters arrive with #26: the first argument is the Chapter the playhead is in (none yet), then the Video's own Song.
  const target = lyrics
    ? { songId: lyrics, versionId: lyricsVersion, fromChapter: false }
    : v ? lyricsTarget(null, v) : null;

  if (v === undefined) return <div class="np"><p class="muted">Loading…</p></div>;
  if (v === null || v.id !== videoId) return <div class="empty-state">No such Video.</div>;

  return (
    <div class="np">
      <div class="np-main">
        <Player key={v.id} video={v} startT={t} chapters={NO_CHAPTERS} onStep={onStep} />
        <div class="np-head">
          <div class="np-titlerow">
            <HeaderTitle video={v} onChange={setV} />
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
            <span class="mono dim">{fmtDuration(v.durationS)}</span>
            <button class={`btn small lyricsbtn${drawer ? " on" : ""}`} aria-pressed={drawer} aria-controls="lyrbody" onClick={() => (drawer ? closeDrawer() : (setDrawer(true), setFocusDrawer(true)))}>
              Lyrics
            </button>
          </div>
          <HeaderFields video={v} onChange={setV} />
        </div>
        <div class="chapter-strip" aria-label="Chapters">
          <span class="dim">No Chapters yet</span>
        </div>
      </div>
      {drawer && (
        <div class="drawer-wrap">
          {target ? (
            <LyricsReader key={`${target.songId}`} songId={target.songId} versionId={target.versionId} fromChapter={target.fromChapter} onClose={closeDrawer} autoFocus={focusDrawer} />
          ) : (
            <aside class="drawer" tabIndex={-1} data-lyrics-drawer="" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), closeDrawer())}>
              <div class="hd"><div class="row"><span class="ttl">Lyrics</span><button class="ib" aria-label="Close lyrics" onClick={closeDrawer}>×</button></div></div>
              <div class="body"><p class="empty">no lyrics: this Video has no Song. Set one with the Song row, or search for a Song.</p></div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
