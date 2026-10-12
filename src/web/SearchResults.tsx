// Search results page (`/search?q=`): the Videos a query matches, laid out like the Library grid (spec 6.2). Enter in
// the search box with no row highlighted lands here; Enter on a highlighted row still opens that row directly.
import { useEffect, useMemo, useState } from "preact/hooks";
import { parseQuery } from "../shared/filters";
import type { SearchResponse, VideoDto } from "../shared/types";
import { Card } from "./Library";
import { api, useStore } from "./data";
import { savePlayingFrom } from "./playingFrom";
import { Link } from "./router";
import { useWindowed } from "./windowed";

const LIMIT = 500;

/** Video ids the response names, in rank order, deduplicated (a chapter row stands for its Video). */
export function resultVideoIds(res: SearchResponse): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const g of res.groups) {
    for (const r of g.rows) {
      const id = r.kind === "video" ? r.id : r.kind === "chapter" ? r.videoId : null;
      if (id != null && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

export function SearchResults({ q }: { q: string }) {
  const { videos } = useStore();
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [failed, setFailed] = useState(false);

  // The Videos group alone, with a page-sized cap instead of the dropdown's.
  useEffect(() => {
    setRes(null);
    setFailed(false);
    if (!q.trim()) return;
    const ac = new AbortController();
    const parsed = parseQuery(q);
    const query = parsed.groups.includes("videos") ? q : `${q} #videos`;
    api
      .search(query, ac.signal, LIMIT)
      .then(setRes)
      .catch(() => !ac.signal.aborted && setFailed(true));
    return () => ac.abort();
  }, [q]);

  const shown = useMemo(() => {
    if (!res || !videos) return [] as VideoDto[];
    const byId = new Map(videos.map((v) => [v.id, v]));
    return resultVideoIds(res).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }, [res, videos]);
  const { limit, sentinel } = useWindowed(q, shown.length);
  const loading = !failed && (!res || !videos) && q.trim() !== "";

  return (
    <div class="page">
      <div class="controls" role="toolbar" aria-label="Search results">
        <span class="chip on">Search: {parseQuery(q).text || q}</span>
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
            {shown.slice(0, limit).map((v) => (
              <Card key={v.id} v={v} onOpen={() => savePlayingFrom("search", shown.map((x) => x.id))} />
            ))}
          </div>
          <div ref={sentinel} class="wall-more" aria-hidden="true" />
        </>
      )}
    </div>
  );
}
