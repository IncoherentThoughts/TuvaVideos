// Search results page (`/search?q=`): the Videos a query matches, laid out like the Library grid (spec 6.2). Enter in
// the search box with no row highlighted lands here; Enter on a highlighted row still opens that row directly.
// Each card says why it matched: the title with the match marked, a matching Chapter title, the Song's name, or the
// first matching lyric line of a Song the Video performs. A Video reached only through a Chapter (its own title did not
// match) opens at that Chapter's start, like the dropdown's chapter rows do.
import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { parseQuery } from "../shared/filters";
import { escapeHtml, highlightHtml, matchRanges } from "../shared/fold";
import type { SearchResponse, SearchRow, VideoDto } from "../shared/types";
import { hasArtistNamed } from "../shared/libraryView";
import { Card } from "./Library";
import { api, useStore } from "./data";
import { searchEntries } from "../shared/playlistStart";
import { savePlayingFrom } from "./playingFrom";
import { startShuffle } from "./playlist";
import { Link, navigate, playHref, searchHref } from "./router";
import { fmtDuration } from "./ui";
import { useWindowed } from "./windowed";

const LIMIT = 500;

type ChapterRow = Extract<SearchRow, { kind: "chapter" }>;
type SongRow = Extract<SearchRow, { kind: "song" }>;

export interface ResultMatch {
  id: string;
  chapters: ChapterRow[];
  songs: SongRow[];
  /** The Latin title, when the match is there and not in the title itself. */
  latin?: string;
  /** Open the Video here: the matching Chapter's start, unless the title itself matched. */
  startS?: number | null;
}

/** The Videos the response names, in rank order and deduplicated, with the Chapter and Song rows that point at each.
 *  Video rows and Chapter rows come first (the Videos group's order); Videos reached only through a matching Song
 *  (its name or its lyrics) follow, in the Songs group's order; then, given the Library's Videos, those by a matching
 *  Artist (#artists) and those performing a matching Track's Song (#tracks). */
export function resultMatches(res: SearchResponse, library: VideoDto[] = []): ResultMatch[] {
  const byId = new Map<string, ResultMatch>();
  const order: ResultMatch[] = [];
  const at = (id: string) => {
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
  const artists = res.groups.find((g) => g.key === "artists")?.rows ?? [];
  for (const r of artists) if (r.kind === "artist") for (const v of library) if (hasArtistNamed(v, r.name)) at(v.id);
  const tracks = res.groups.find((g) => g.key === "tracks")?.rows ?? [];
  for (const r of tracks) if (r.kind === "track" && r.songId) for (const v of library) if (v.songId === r.songId) at(v.id);
  return order;
}

/** Where opening a result should start: the first matching Chapter's start when the Video was reached only through a
 *  Chapter (directly, or through a Song performed in a Chapter); null when the title itself matched or nothing points at a time. */
export function resultStart(m: ResultMatch, titleMatched: boolean): number | null {
  if (titleMatched) return null;
  const c = m.chapters[0];
  if (c) return c.startS;
  for (const s of m.songs) {
    const at = s.videos.find((v) => v.id === m.id)?.startS;
    if (at != null) return at;
  }
  return null;
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
    // Video filters (#fav #available #unshared #type: #artist:) hold for every card, however the Video was reached.
    const p = parseQuery(q);
    // A matching Chapter already passed them on the server (#fav there means the Chapter itself is a Favorite).
    const passes = (v: VideoDto, m: ResultMatch) =>
      (!p.available || v.available) && (!p.unshared || !v.shared) && (!p.fav || !!v.favoritedAt || m.chapters.length > 0) && (!p.types.length || p.types.includes(v.type)) && p.artists.every((a) => hasArtistNamed(v, a));
    return resultMatches(res, videos).flatMap((m) => {
      const v = byId.get(m.id);
      if (!v || !passes(v, m)) return [];
      const inTitle = !!res.needle && matchRanges(v.title, res.needle).length > 0;
      const inLatin = !!res.needle && !inTitle && !!v.titleLatin && matchRanges(v.titleLatin, res.needle).length > 0;
      if (inLatin) m.latin = v.titleLatin!;
      m.startS = resultStart(m, inTitle || inLatin);
      return [{ v, m }];
    });
  }, [res, videos, q]);
  // "views" keeps the ranking as the tie-break: equally watched Videos stay in match order.
  const ordered = useMemo(() => (sort === "views" ? [...shown].sort((a, b) => b.v.viewCount - a.v.viewCount) : shown), [shown, sort]);
  const ids = useMemo(() => ordered.map((x) => x.v.id), [ordered]);
  const { limit, sentinel } = useWindowed(`${q}|${sort}`, shown.length);
  const loading = !failed && (!res || !videos) && q.trim() !== "";
  const needle = res?.needle ?? "";
  // "shuffle results" (spec 4.8): the list as shown, capped; a Video reached through a Chapter still starts at its beginning.
  const shuffleResults = () => {
    savePlayingFrom("search", ids);
    const first = startShuffle(searchEntries(ids), "search");
    if (first) navigate(playHref(first.videoId, null));
  };

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
        <button class="chip shuffle" disabled={loading || shown.length === 0} title="Play the results in a random order" onClick={shuffleResults}>
          shuffle results
        </button>
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
                startS={m.startS}
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
