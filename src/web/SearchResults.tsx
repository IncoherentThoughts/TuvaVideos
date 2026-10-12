// Search results page (`/search?q=`): the Videos a query matches, laid out like the Library grid (spec 6.2). Enter in
// the search box with no row highlighted lands here; Enter on a highlighted row still opens that row directly.
// Each card says why it matched: the title with the match marked, a matching Chapter title, the Song's name, or the
// first matching lyric line of a Song the Video performs.
import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { parseQuery } from "../shared/filters";
import { escapeHtml, highlightHtml, matchRanges } from "../shared/fold";
import type { SearchResponse, SearchRow, VideoDto } from "../shared/types";
import { Card } from "./Library";
import { api, useStore } from "./data";
import { savePlayingFrom } from "./playingFrom";
import { Link, navigate, searchHref } from "./router";
import { fmtDuration } from "./ui";
import { useWindowed } from "./windowed";

const LIMIT = 500;

type ChapterRow = Extract<SearchRow, { kind: "chapter" }>;
type SongRow = Extract<SearchRow, { kind: "song" }>;

export interface ResultMatch {
  id: number;
  chapters: ChapterRow[];
  songs: SongRow[];
  /** The Latin title, when the match is there and not in the title itself. */
  latin?: string;
}

/** The Videos the response names, in rank order and deduplicated, with the Chapter and Song rows that point at each.
 *  Video rows and Chapter rows come first (the Videos group's order); Videos reached only through a matching Song
 *  (its name or its lyrics) follow, in the Songs group's order. */
export function resultMatches(res: SearchResponse): ResultMatch[] {
  const byId = new Map<number, ResultMatch>();
  const order: ResultMatch[] = [];
  const at = (id: number) => {
    let m = byId.get(id);
    if (!m) {
      m = { id, chapters: [], songs: [] };
      byId.set(id, m);
      order.push(m);
    }
    return m;
  };
  const videos = res.groups.find((g) => g.key === "videos")?.rows ?? [];
  for (const r of videos) {
    if (r.kind === "video") at(r.id);
    else if (r.kind === "chapter") at(r.videoId).chapters.push(r);
  }
  const songs = res.groups.find((g) => g.key === "songs")?.rows ?? [];
  for (const r of songs) if (r.kind === "song") for (const v of r.videos) at(v.id).songs.push(r);
  return order;
}

/** The lines under a card's title explaining the match. The title itself carries its own <mark>s. */
function Why({ m, needle }: { m: ResultMatch; needle: string }) {
  const lines: JSX.Element[] = [];
  // A title that matched only through its Latin title shows that Latin title with the match marked.
  if (m.latin) lines.push(<div class="why" key="latin"><span class="k">latin</span> <span dangerouslySetInnerHTML={{ __html: highlightHtml(m.latin, needle) }} /></div>);
  for (const c of m.chapters.slice(0, 2))
    lines.push(
      <div class="why" key={`c${c.id}`}>
        <span class="k">› {fmtDuration(c.startS)}</span> <span dangerouslySetInnerHTML={{ __html: highlightHtml(c.title, needle) }} />
      </div>,
    );
  const seen = new Set<string>();
  for (const s of m.songs) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const name = highlightHtml(s.name, needle) + (s.englishName ? ` <span class="en">· ${highlightHtml(s.englishName, needle)}</span>` : "");
    lines.push(
      <div class="why" key={`s${s.id}`}>
        <span class="k">♪</span> <span dangerouslySetInnerHTML={{ __html: name }} />
      </div>,
    );
    if (s.lyric)
      lines.push(
        <div class="why lyric" key={`l${s.id}`}>
          <span class="k">Lyrics:</span> <span dangerouslySetInnerHTML={{ __html: highlightHtml(s.lyric, needle) }} />
        </div>,
      );
  }
  return lines.length ? <div class="whys">{lines}</div> : null;
}

export function SearchResults({ q, sort }: { q: string; sort: "rank" | "views" }) {
  const { videos } = useStore();
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [failed, setFailed] = useState(false);

  // Videos and Songs (a Song match stands for the Videos performing it) with a page-sized cap instead of the dropdown's.
  useEffect(() => {
    setRes(null);
    setFailed(false);
    if (!q.trim()) return;
    const ac = new AbortController();
    const parsed = parseQuery(q);
    const query = parsed.groups.length || parsed.lyricsOnly ? q : `${q} #videos #songs`;
    api
      .search(query, ac.signal, LIMIT)
      .then(setRes)
      .catch(() => !ac.signal.aborted && setFailed(true));
    return () => ac.abort();
  }, [q]);

  const shown = useMemo(() => {
    if (!res || !videos) return [] as { v: VideoDto; m: ResultMatch }[];
    const byId = new Map(videos.map((v) => [v.id, v]));
    return resultMatches(res).flatMap((m) => {
      const v = byId.get(m.id);
      if (!v) return [];
      if (res.needle && v.titleLatin && !matchRanges(v.title, res.needle).length && matchRanges(v.titleLatin, res.needle).length) m.latin = v.titleLatin;
      return [{ v, m }];
    });
  }, [res, videos]);
  // "views" keeps the ranking as the tie-break: equally watched Videos stay in match order.
  const ordered = useMemo(() => (sort === "views" ? [...shown].sort((a, b) => b.v.viewCount - a.v.viewCount) : shown), [shown, sort]);
  const ids = useMemo(() => ordered.map((x) => x.v.id), [ordered]);
  const { limit, sentinel } = useWindowed(`${q}|${sort}`, shown.length);
  const loading = !failed && (!res || !videos) && q.trim() !== "";
  const needle = res?.needle ?? "";

  return (
    <div class="page">
      <div class="controls" role="toolbar" aria-label="Search results">
        <span class="chip on">Search: {parseQuery(q).text || q}</span>
        <span class="sep" />
        <select class="chip" aria-label="Sort" value={sort} onChange={(e) => navigate(searchHref(q, (e.target as HTMLSelectElement).value === "views" ? "views" : "rank"), { replace: true })}>
          <option value="rank">Best match</option>
          <option value="views">Most viewed</option>
        </select>
        <span class="count">{loading ? "searching…" : `${shown.length} Video${shown.length === 1 ? "" : "s"}`}</span>
      </div>
      {failed ? (
        <div class="empty-state">The search failed; try again.</div>
      ) : !q.trim() ? (
        <div class="empty-state">Type something in the search box.</div>
      ) : !loading && shown.length === 0 ? (
        <div class="empty-state">
          No Videos match “{q}”.{" "}
          <Link href="/" class="muted" style={{ textDecoration: "underline" }}>
            Back to the Library
          </Link>
        </div>
      ) : (
        <>
          <div class="wall">
            {ordered.slice(0, limit).map(({ v, m }) => (
              <Card
                key={v.id}
                v={v}
                titleHtml={needle ? highlightHtml(v.title, needle) : escapeHtml(v.title)}
                why={needle ? <Why m={m} needle={needle} /> : null}
                onOpen={() => savePlayingFrom("search", ids)}
              />
            ))}
          </div>
          <div ref={sentinel} class="wall-more" aria-hidden="true" />
        </>
      )}
    </div>
  );
}
