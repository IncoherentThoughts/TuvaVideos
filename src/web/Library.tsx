import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { TYPES } from "../shared/filters";
import {
  SORTS, defaultDir, libraryQuery, parseLibrarySearch, viewVideos, type LibraryState, type SortKey,
} from "../shared/libraryView";
import type { SongDto, VideoDto } from "../shared/types";
import { api, useStore } from "./data";
import { libraryFiltered, libraryStart } from "../shared/playlistStart";
import { savePlayingFrom } from "./playingFrom";
import { startShuffle } from "./playlist";
import { Link, navigate, playHref } from "./router";
import { AvailabilityIcon, FavoriteBadge, Poster, SpecTags, Tags } from "./ui";
import { useWindowed } from "./windowed";

const SORT_LABEL: Record<SortKey, string> = { added: "Date added", title: "Title", duration: "Duration", played: "Last played", views: "Views" };

export function Card({ v, onOpen, titleHtml, why, startS }: { v: VideoDto; onOpen: () => void; /** Title with <mark>s (search results); plain title otherwise. */ titleHtml?: string; /** Why the search matched: lines under the title. */ why?: ComponentChildren; /** Open the Video at this time (a search that matched a Chapter) instead of its Resume position. */ startS?: number | null }) {
  return (
    <Link href={playHref(v.id, startS)} class="card" data-item="" data-id={v.id} data-fav-kind="video" onClickCapture={onOpen}>
      <Poster video={v} dur />
      <div class="ttl">
        {v.favoritedAt && <FavoriteBadge />}
        {titleHtml != null ? <span dangerouslySetInnerHTML={{ __html: titleHtml }} /> : v.title}
      </div>
      {why}
      <Tags video={v} />
      <SpecTags video={v} />
      {(v.availability !== "local" || v.chapterCount > 0 || v.viewCount > 0) && (
        <div class="meta">
          {/* Nearly every Copy is local, so only the exceptions (external, unavailable) get an icon here; Now playing always shows it. */}
          {v.availability !== "local" && <AvailabilityIcon availability={v.availability} />}
          {v.chapterCount > 0 && <span>{v.chapterCount} ch</span>}
          {v.viewCount > 0 && <span>{v.viewCount} {v.viewCount === 1 ? "view" : "views"}</span>}
        </div>
      )}
    </Link>
  );
}

export function Library({ search }: { search: string }) {
  const { videos } = useStore();
  const st = useMemo(() => parseLibrarySearch(search), [search]);
  // `?song=`: the Videos performing that Song (its Song pointer, or a Chapter), from the Song's own record.
  const [song, setSong] = useState<SongDto | null | undefined>(undefined);
  useEffect(() => {
    if (!st.song) return void setSong(undefined);
    let alive = true;
    setSong(undefined);
    api.song(st.song).then((s) => alive && setSong(s)).catch(() => alive && setSong(null));
    return () => {
      alive = false;
    };
  }, [st.song]);
  const songVideos = useMemo(() => (song ? new Map(song.videos.map((x) => [x.id, x])) : null), [song]);
  const shown = useMemo(() => {
    if (!videos) return [];
    const all = viewVideos(videos, st);
    if (!st.song) return all;
    return songVideos ? all.filter((v) => songVideos.has(v.id)) : [];
  }, [videos, st, songVideos]);
  // Only a window of the grid is in the DOM (see windowed.ts); `shown` stays the whole list for the count and Playing from.
  const { limit, sentinel } = useWindowed(search, shown.length);

  const go = (patch: Partial<LibraryState>) => navigate(`/${libraryQuery({ ...st, ...patch })}`, { replace: true });
  const toggleType = (t: (typeof TYPES)[number]) => go({ types: st.types.includes(t) ? st.types.filter((x) => x !== t) : [...st.types, t] });
  // "shuffle random" (spec 4.8): the grid as shown; the whole library is the "library-all" source.
  const shuffleRandom = () => {
    const ids = shown.map((v) => v.id);
    const { entries, source } = libraryStart(ids, libraryFiltered(st));
    savePlayingFrom("library", ids);
    const first = startShuffle(entries, source);
    if (first) navigate(playHref(first.videoId, null));
  };

  return (
    <div class="page">
      <div class="controls" role="toolbar" aria-label="Library filters">
        {TYPES.map((t) => (
          <button key={t} class={`chip${st.types.includes(t) ? " on" : ""}`} aria-pressed={st.types.includes(t)} onClick={() => toggleType(t)}>
            {t}
          </button>
        ))}
        <span class="sep" />
        <button class={`chip${st.availableOnly ? " on" : ""}`} aria-pressed={st.availableOnly} onClick={() => go({ availableOnly: !st.availableOnly })}>
          {st.availableOnly ? "Available only" : "All Videos"}
        </button>
        <button class={`chip${st.fav ? " on" : ""}`} aria-pressed={st.fav} onClick={() => go({ fav: !st.fav })}>
          ★ Favorites
        </button>
        {st.artist && (
          <span class="chip on artist">
            Artist: {st.artist}
            <button aria-label="Clear the Artist filter" onClick={() => go({ artist: null })}>
              ×
            </button>
          </span>
        )}
        {st.song && (
          <span class="chip on song">
            Song: {song ? song.name : song === null ? "unknown song" : "…"}
            <button aria-label="Clear the Song filter" onClick={() => go({ song: null })}>
              ×
            </button>
          </span>
        )}
        <span class="sep" />
        <select
          class="chip"
          aria-label="Sort"
          value={st.sort}
          onChange={(e) => {
            const sort = (e.target as HTMLSelectElement).value as SortKey;
            go({ sort, dir: defaultDir(sort) });
          }}
        >
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABEL[s]}
            </option>
          ))}
        </select>
        <button class="chip" title="Reverse the order" aria-label={`Sorted ${st.dir === "asc" ? "ascending" : "descending"}; reverse`} onClick={() => go({ dir: st.dir === "asc" ? "desc" : "asc" })}>
          {st.dir === "asc" ? "↑" : "↓"}
        </button>
        <span class="count">{videos ? `${shown.length} of ${videos.length}` : "loading…"}</span>
        <button class="chip shuffle" disabled={shown.length === 0} title="Play the Videos shown, in a random order" onClick={shuffleRandom}>
          shuffle random
        </button>
      </div>
      {videos && shown.length === 0 ? (
        <div class="empty-state">
          No Videos match these filters.{" "}
          <Link href="/" class="muted" style={{ textDecoration: "underline" }}>
            Clear them
          </Link>
        </div>
      ) : (
        <>
          <div class="wall">
            {shown.slice(0, limit).map((v) => (
              // A Video performing the Song only in a Chapter opens at that Chapter.
              <Card key={v.id} v={v} startS={songVideos?.get(v.id)?.pointed ? null : songVideos?.get(v.id)?.startS} onOpen={() => savePlayingFrom("library", shown.map((x) => x.id))} />
            ))}
          </div>
          <div ref={sentinel} class="wall-more" aria-hidden="true" />
        </>
      )}
    </div>
  );
}
