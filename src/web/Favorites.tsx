import { useEffect, useMemo, useState } from "preact/hooks";
import { TYPES } from "../shared/filters";
import {
  FAV_SHOWS, FAV_SORTS, cmpNullsLast, cmpText, favoritesQuery, nameMatches, naturalDir, parseFavoritesSearch, type FavSort, type FavoritesState,
} from "../shared/listView";
import type { FavoriteItem } from "../shared/types";
import { NameFilter, SortControls } from "./ListControls";
import { api, useStore } from "./data";
import { savePlayingFrom } from "./playingFrom";
import { Link, navigate, playHref } from "./router";
import { AvailabilityIcon, FavoriteBadge, Poster, StripFrame, Tags, fmtDuration } from "./ui";

const SORT_LABEL: Record<FavSort, string> = { starred: "Date starred", title: "Title", duration: "Duration", added: "Date added", views: "Views" };
const SHOW_LABEL = { both: "Videos and Chapters", videos: "Videos", chapters: "Chapters" } as const;

const titleOf = (i: FavoriteItem) => (i.kind === "video" ? i.video.title : i.chapter.title);
const latinOf = (i: FavoriteItem) => (i.kind === "video" ? i.video.titleLatin : i.chapter.titleLatin);

/** Filter and order the Favorites for the page. A Chapter's duration is its Video's; its title is its own. */
export function viewFavorites(items: FavoriteItem[], st: FavoritesState): FavoriteItem[] {
  const sign = st.dir === "asc" ? 1 : -1;
  const out = items.filter(
    (i) =>
      (st.show === "both" || (st.show === "videos" ? i.kind === "video" : i.kind === "chapter")) &&
      (!st.types.length || st.types.includes(i.video.type)) &&
      (!st.availableOnly || i.video.available) &&
      nameMatches(st.q, titleOf(i), latinOf(i), i.kind === "chapter" ? i.video.title : null, i.kind === "chapter" ? i.video.titleLatin : null),
  );
  out.sort((x, y) => {
    let c = 0;
    if (st.sort === "title") c = sign * cmpText(titleOf(x), titleOf(y));
    else if (st.sort === "duration") c = cmpNullsLast(x.video.durationS, y.video.durationS, sign);
    else if (st.sort === "added") c = cmpNullsLast(x.video.addedAt ?? x.video.createdAt, y.video.addedAt ?? y.video.createdAt, sign);
    else if (st.sort === "views") c = sign * (x.video.viewCount - y.video.viewCount);
    else c = cmpNullsLast(x.favoritedAt, y.favoritedAt, sign);
    return c || cmpNullsLast(x.favoritedAt, y.favoritedAt, -1);
  });
  return out;
}

function VideoRow({ item, onOpen }: { item: Extract<FavoriteItem, { kind: "video" }>; onOpen: () => void }) {
  const v = item.video;
  return (
    <Link href={playHref(v.id)} class="frow" data-item="" data-id={v.id} data-fav-kind="video" onClickCapture={onOpen}>
      <div class="thumbcol">
        <Poster video={v} />
      </div>
      <div class="body">
        <div class="ttl">
          <FavoriteBadge />
          {v.title}
        </div>
        <Tags video={v} />
      </div>
      <div class="right">
        <span>{fmtDuration(v.durationS)}</span>
        <AvailabilityIcon availability={v.availability} />
      </div>
    </Link>
  );
}

function ChapterRow({ item, onOpen }: { item: Extract<FavoriteItem, { kind: "chapter" }>; onOpen: () => void }) {
  const { video: v, chapter: c } = item;
  const pos = v.durationS ? Math.min(100, Math.max(0, (c.startS / v.durationS) * 100)) : 0;
  return (
    <Link href={playHref(v.id, c.startS)} class="frow chapter" data-item="" data-id={c.id} data-fav-kind="chapter" onClickCapture={onOpen}>
      <div class="thumbcol">
        <StripFrame video={v} t={c.startS} />
        <div class="posbar" title={`${fmtDuration(c.startS)} of ${fmtDuration(v.durationS)}`}>
          <i style={{ width: `${pos}%` }} />
          <b style={{ left: `${pos}%` }} />
        </div>
      </div>
      <div class="body">
        <div class="ttl">
          <FavoriteBadge />
          {c.title}
        </div>
        <div class="sub">{v.title}</div>
      </div>
      <div class="right">
        <span class="kindmark">chapter</span>
        <span>{fmtDuration(c.startS)}</span>
        <AvailabilityIcon availability={v.availability} />
      </div>
    </Link>
  );
}

export function Favorites({ search }: { search: string }) {
  const { favVersion } = useStore();
  const [items, setItems] = useState<FavoriteItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const st = useMemo(() => parseFavoritesSearch(search), [search]);

  useEffect(() => {
    let alive = true;
    api.favorites().then((r) => alive && setItems(r)).catch((e) => alive && setErr(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [favVersion]);

  const go = (patch: Partial<FavoritesState>) => navigate(`/favorites${favoritesQuery({ ...st, ...patch })}`, { replace: true });
  const toggleType = (t: (typeof TYPES)[number]) => go({ types: st.types.includes(t) ? st.types.filter((x) => x !== t) : [...st.types, t] });
  const shown = useMemo(() => (items ? viewFavorites(items, st) : []), [items, st]);
  const snapshot = () => savePlayingFrom("favorites", shown.map((i) => i.video.id));

  return (
    <div class="page">
      <div class="controls" role="toolbar" aria-label="Favorite filters">
        {FAV_SHOWS.map((s) => (
          <button key={s} class={`chip${st.show === s ? " on" : ""}`} aria-pressed={st.show === s} onClick={() => go({ show: s })}>
            {SHOW_LABEL[s]}
          </button>
        ))}
        <span class="sep" />
        {TYPES.map((t) => (
          <button key={t} class={`chip${st.types.includes(t) ? " on" : ""}`} aria-pressed={st.types.includes(t)} onClick={() => toggleType(t)}>
            {t}
          </button>
        ))}
        <span class="sep" />
        <button class={`chip${st.availableOnly ? " on" : ""}`} aria-pressed={st.availableOnly} onClick={() => go({ availableOnly: !st.availableOnly })}>
          {st.availableOnly ? "Available only" : "All Videos"}
        </button>
        <NameFilter value={st.q} onChange={(q) => go({ q })} placeholder="Filter by title…" label="Filter Favorites by title" />
        <span class="sep" />
        <SortControls sorts={FAV_SORTS} labels={SORT_LABEL} sort={st.sort} dir={st.dir} onSort={(sort) => go({ sort, dir: naturalDir(sort) })} onDir={(dir) => go({ dir })} />
        <span class="count">{items ? `${shown.length} of ${items.length} Favorite${items.length === 1 ? "" : "s"}` : "loading…"}</span>
      </div>
      {err && <div class="empty-state">Could not load Favorites: {err}</div>}
      {items && items.length === 0 && <div class="empty-state">Nothing starred yet. Press <kbd>f</kbd> on a Video in the Library to add one.</div>}
      {items && items.length > 0 && shown.length === 0 && (
        <div class="empty-state">
          No Favorites match these filters.{" "}
          <button class="linkbtn" onClick={() => navigate("/favorites", { replace: true })}>Clear them</button>
        </div>
      )}
      <div class="flist">
        {shown.map((i) =>
          i.kind === "video" ? <VideoRow key={`v${i.video.id}`} item={i} onOpen={snapshot} /> : <ChapterRow key={`c${i.chapter.id}`} item={i} onOpen={snapshot} />,
        )}
      </div>
    </div>
  );
}
