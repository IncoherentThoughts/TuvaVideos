import { useMemo } from "preact/hooks";
import { TYPES } from "../shared/filters";
import {
  SORTS, defaultDir, libraryQuery, parseLibrarySearch, viewVideos, type LibraryState, type SortKey,
} from "../shared/libraryView";
import type { VideoDto } from "../shared/types";
import { useStore } from "./data";
import { savePlayingFrom } from "./playingFrom";
import { Link, navigate, playHref } from "./router";
import { AvailabilityIcon, FavoriteBadge, Poster, Tags, resolutionLabel } from "./ui";
import { useWindowed } from "./windowed";

const SORT_LABEL: Record<SortKey, string> = { added: "Date added", title: "Title", duration: "Duration", played: "Last played" };

function Card({ v, onOpen }: { v: VideoDto; onOpen: () => void }) {
  const res = resolutionLabel(v.height);
  return (
    <Link href={playHref(v.id)} class="card" data-item="" data-id={v.id} data-fav-kind="video" onClickCapture={onOpen}>
      <Poster video={v} dur edge />
      <div class="ttl">
        {v.favoritedAt && <FavoriteBadge />}
        {v.title}
      </div>
      <Tags video={v} />
      <div class="meta">
        <AvailabilityIcon availability={v.availability} />
        <span class={v.chapterCount ? "" : "dim"}>{v.chapterCount} ch</span>
        {res && <span>{res}</span>}
      </div>
    </Link>
  );
}

export function Library({ search }: { search: string }) {
  const { videos } = useStore();
  const st = useMemo(() => parseLibrarySearch(search), [search]);
  const shown = useMemo(() => (videos ? viewVideos(videos, st) : []), [videos, st]);
  // Only a window of the grid is in the DOM (see windowed.ts); `shown` stays the whole list for the count and Playing from.
  const { limit, sentinel } = useWindowed(search, shown.length);

  const go = (patch: Partial<LibraryState>) => navigate(`/${libraryQuery({ ...st, ...patch })}`, { replace: true });
  const toggleType = (t: (typeof TYPES)[number]) => go({ types: st.types.includes(t) ? st.types.filter((x) => x !== t) : [...st.types, t] });

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
              <Card key={v.id} v={v} onOpen={() => savePlayingFrom("library", shown.map((x) => x.id))} />
            ))}
          </div>
          <div ref={sentinel} class="wall-more" aria-hidden="true" />
        </>
      )}
    </div>
  );
}
