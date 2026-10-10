// SearchBox + ResultsDropdown (spec 5.2, 6.2). The query is never written to the URL.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { escapeHtml, highlightHtml } from "../shared/fold";
import { filterChips, hasVideoFilters, isFilterOnly, parseQuery } from "../shared/filters";
import { defaultLibraryState, libraryQuery } from "../shared/libraryView";
import type { SearchResponse, SearchRow } from "../shared/types";
import { api } from "./data";
import { SEARCH_ID, releaseSearch } from "./keys";
import { savePlayingFrom } from "./playingFrom";
import { navigate, playHref } from "./router";
import { fmtDuration } from "./ui";

// Chrome fires synthetic mousemoves when rows re-render under a resting pointer; only a real move may change the
// highlighted row, or Enter would open whatever the pointer happens to rest on.
const realMove = (e: MouseEvent) => e.movementX !== 0 || e.movementY !== 0;

const H = (text: string, needle: string) => ({ dangerouslySetInnerHTML: { __html: highlightHtml(text, needle) } });

function RowView({ row, needle, on, idx, pick, hover }: { row: SearchRow; needle: string; on: boolean; idx: number; pick: () => void; hover: () => void }) {
  const common = { class: `r${on ? " on" : ""}`, "data-idx": idx, role: "option" as const, "aria-selected": on, onMouseDown: (e: MouseEvent) => e.preventDefault(), onClick: pick, onMouseMove: (e: MouseEvent) => realMove(e) && hover() };
  switch (row.kind) {
    case "video":
      return (
        <div {...common}>
          <span class="nm" {...H(row.title, needle)} />
          <span class="typ video">video{row.durationS != null ? ` · ${fmtDuration(row.durationS)}` : ""}{row.available ? "" : " · unavailable"}</span>
          {row.songs.length > 0 && <span class="by">♪ {row.songs.join(", ")}</span>}
        </div>
      );
    case "chapter":
      return (
        <div {...common}>
          <span class="nm" dangerouslySetInnerHTML={{ __html: `${highlightHtml(row.videoTitle, needle)} › ${highlightHtml(row.title, needle)}` }} />
          <span class="typ chapter">chapter · {fmtDuration(row.startS)}</span>
        </div>
      );
    case "artist":
      return (
        <div {...common}>
          <span class="nm" {...H(row.name, needle)} />
          <span class="typ artist">artist{row.local ? " · local" : ""} · {row.videoCount} video{row.videoCount === 1 ? "" : "s"}</span>
        </div>
      );
    case "song":
      return (
        <div {...common}>
          <span class="nm" dangerouslySetInnerHTML={{ __html: highlightHtml(row.name, needle) + (row.englishName ? ` <span class="en">· ${highlightHtml(row.englishName, needle)}</span>` : "") }} />
          <span class="typ song">song{row.viaLyrics ? " · lyrics" : ""}</span>
          {row.lyric && <span class="sn" dangerouslySetInnerHTML={{ __html: `<b>Lyrics:</b> ${highlightHtml(row.lyric, needle)}` }} />}
        </div>
      );
    case "track":
      return (
        <div {...common}>
          <span class="nm" dangerouslySetInnerHTML={{ __html: highlightHtml(row.name, needle) + (row.album ? ` <span class="en">· ${escapeHtml(row.album)}</span>` : "") }} />
          <span class="typ track">track</span>
          <span class="by">by {row.by.join(" & ") || "—"}</span>
        </div>
      );
    case "album":
      return (
        <div {...common}>
          <span class="nm" {...H(row.name, needle)} />
          <span class="typ album">album{row.year ? ` · ${row.year}` : ""}</span>
          {row.by && <span class="by">{row.by}</span>}
        </div>
      );
  }
}

export function SearchBox() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [hi, setHi] = useState(-1);
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const dd = useRef<HTMLDivElement>(null);

  const parsed = useMemo(() => parseQuery(q), [q]);
  const chips = useMemo(() => filterChips(parsed), [parsed]);
  const flat = useMemo(() => (res ? res.groups.flatMap((g) => g.rows) : []), [res]);

  // fetch (debounced, previous request aborted)
  useEffect(() => {
    if (!q.trim()) {
      setRes(null);
      setHi(-1);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      api
        .search(q, ac.signal)
        .then((r) => {
          setRes(r);
          setHi(-1);
        })
        .catch(() => {});
    }, 60);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q]);

  // click outside closes
  useEffect(() => {
    const on = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, []);

  useEffect(() => {
    if (hi >= 0) dd.current?.querySelector(`[data-idx="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const close = () => {
    setOpen(false);
    setNote(null);
  };

  /** Playing from: the Videos the dropdown shows, in order (a chapter row stands for its Video). */
  const snapshotResults = () => {
    const ids = flat.flatMap((r) => (r.kind === "video" ? [r.id] : r.kind === "chapter" ? [r.videoId] : []));
    savePlayingFrom("search", ids);
  };

  const openRow = (row: SearchRow) => {
    if (row.kind === "video") (snapshotResults(), navigate(playHref(row.id)));
    else if (row.kind === "chapter") (snapshotResults(), navigate(playHref(row.videoId, row.startS)));
    else if (row.kind === "artist") navigate(`/${libraryQuery({ ...defaultLibraryState(), artist: row.name })}`);
    else {
      // Songs, Tracks and Albums open lyrics in the Now playing drawer, which ticket #24/#25 build.
      setNote("Opening lyrics arrives with the Now playing screen and the archive import (tickets #24, #25).");
      return;
    }
    close();
    (document.activeElement as HTMLElement | null)?.blur();
  };

  /** Filter-only query + Enter: apply the Library-grid filters to the URL and close the dropdown. */
  const applyFilters = () => {
    const st = defaultLibraryState();
    st.types = [...parsed.types];
    st.availableOnly = parsed.available;
    st.fav = parsed.fav;
    st.artist = parsed.artists[0] ?? null;
    navigate(`/${libraryQuery(st)}`);
    setQ("");
    setRes(null);
    close();
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const removeChip = (token: string) => {
    const t = token.toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const i = words.findIndex((w) => w.toLowerCase() === t);
    if (i >= 0) words.splice(i, 1);
    setQ(words.join(" "));
    document.getElementById(SEARCH_ID)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      releaseSearch();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      if (!flat.length) return;
      setHi((h) => (e.key === "ArrowDown" ? (h + 1) % flat.length : h <= 0 ? flat.length - 1 : h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hi >= 0 && flat[hi]) return openRow(flat[hi]!);
      if (isFilterOnly(parsed) && hasVideoFilters(parsed)) return applyFilters();
      if (parsed.text.trim() && flat[0]) openRow(flat[0]);
    }
  };

  const showDd = open && q.trim() !== "";
  let idx = -1;
  const total = res ? res.groups.reduce((n, g) => n + g.total, 0) : 0;
  const filterOnlyApplicable = isFilterOnly(parsed) && hasVideoFilters(parsed);

  return (
    <div class="sbox" ref={box}>
      <input
        id={SEARCH_ID}
        class="search"
        type="search"
        autocomplete="off"
        spellcheck={false}
        placeholder="Search titles, artists, lyrics…  #fav #available"
        value={q}
        aria-controls="results"
        onInput={(e) => {
          setQ((e.target as HTMLInputElement).value);
          setOpen(true);
          setNote(null);
        }}
        onFocus={() => q.trim() && setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <span class="hint">
        <kbd>/</kbd>
      </span>
      {showDd && (
        <div class="dd" id="results" role="listbox" ref={dd}>
          <div class="dd-head">
            {chips.length ? (
              chips.map((c) => (
                <span class="fchip" key={c.token}>
                  {c.label}
                  <button aria-label={`Remove ${c.label}`} onMouseDown={(e) => e.preventDefault()} onClick={() => removeChip(c.token)}>
                    ×
                  </button>
                </span>
              ))
            ) : (
              <span>narrow with #songs #videos #artists #tracks #albums #lyrics</span>
            )}
            <span class="n">{res ? `${total} result${total === 1 ? "" : "s"}` : "…"}</span>
          </div>
          {filterOnlyApplicable && (
            <div class="tip">
              <kbd>Enter</kbd> applies these filters to the Library grid. <kbd>↓</kbd> then <kbd>Enter</kbd> opens a result.
            </div>
          )}
          {res && total === 0 && <div class="empty">No results for “{parsed.text || q}”</div>}
          {res?.groups.map((g) => (
            <div key={g.key}>
              <h5>
                <span>{g.label}</span>
                <span class="c">{g.total}</span>
              </h5>
              {g.rows.map((row) => {
                idx++;
                const i = idx;
                return <RowView key={`${row.kind}${row.id}`} row={row} needle={res.needle} idx={i} on={i === hi} pick={() => openRow(row)} hover={() => setHi(i)} />;
              })}
              {g.total > g.rows.length && <div class="more">… {g.total - g.rows.length} more; add #{g.key} to see up to 40</div>}
            </div>
          ))}
          {note && <div class="note">{note}</div>}
        </div>
      )}
    </div>
  );
}
