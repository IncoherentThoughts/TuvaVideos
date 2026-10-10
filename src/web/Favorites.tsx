import { useEffect, useState } from "preact/hooks";
import type { FavoriteItem } from "../shared/types";
import { api, useStore } from "./data";
import { Link, navigate, playHref } from "./router";
import { AvailabilityIcon, FavoriteBadge, Poster, StripFrame, Tags, fmtDuration } from "./ui";

type Show = "both" | "videos" | "chapters";

function VideoRow({ item }: { item: Extract<FavoriteItem, { kind: "video" }> }) {
  const v = item.video;
  return (
    <Link href={playHref(v.id)} class="frow" data-item="" data-id={v.id} data-fav-kind="video">
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

function ChapterRow({ item }: { item: Extract<FavoriteItem, { kind: "chapter" }> }) {
  const { video: v, chapter: c } = item;
  const pos = v.durationS ? Math.min(100, Math.max(0, (c.startS / v.durationS) * 100)) : 0;
  return (
    <Link href={playHref(v.id, c.startS)} class="frow chapter" data-item="" data-id={c.id} data-fav-kind="chapter">
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
  const q = new URLSearchParams(search).get("show");
  const show: Show = q === "videos" || q === "chapters" ? q : "both";

  useEffect(() => {
    let alive = true;
    api.favorites().then((r) => alive && setItems(r)).catch((e) => alive && setErr(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [favVersion]);

  const setShow = (s: Show) => navigate(`/favorites${s === "both" ? "" : `?show=${s}`}`, { replace: true });
  const shown = (items ?? []).filter((i) => show === "both" || (show === "videos" ? i.kind === "video" : i.kind === "chapter"));

  return (
    <div class="page">
      <div class="controls">
        {(["both", "videos", "chapters"] as const).map((s) => (
          <button key={s} class={`chip${show === s ? " on" : ""}`} aria-pressed={show === s} onClick={() => setShow(s)}>
            {s === "both" ? "Videos and Chapters" : s === "videos" ? "Videos" : "Chapters"}
          </button>
        ))}
        <span class="count">{items ? `${shown.length} Favorite${shown.length === 1 ? "" : "s"}` : "loading…"}</span>
      </div>
      {err && <div class="empty-state">Could not load Favorites: {err}</div>}
      {items && shown.length === 0 && <div class="empty-state">Nothing starred yet. Press <kbd>f</kbd> on a Video in the Library to add one.</div>}
      <div class="flist">
        {shown.map((i) =>
          i.kind === "video" ? <VideoRow key={`v${i.video.id}`} item={i} /> : <ChapterRow key={`c${i.chapter.id}`} item={i} />,
        )}
      </div>
    </div>
  );
}
