// SearchBox + ResultsDropdown (spec 5.2, 6.2). The query is never written to the URL.
// A typed filter (#songs, #fav, #type:concert …) becomes a coloured pill inside the box once a space follows it; the
// pills and the text after them make up the query. Backspace at the start of the text removes the last pill.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { escapeHtml, highlightHtml } from "../shared/fold";
import { filterSlot, hasVideoFilters, isFilterToken, parseQuery } from "../shared/filters";
import { defaultLibraryState, libraryQuery } from "../shared/libraryView";
import type { SearchResponse, SearchRow } from "../shared/types";
import { api } from "./data";
import { SEARCH_ID, releaseSearch } from "./keys";
import { savePlayingFrom } from "./playingFrom";
import { openLyrics } from "./lyricsNav";
import { navigate, playHref, searchHref } from "./router";
import { artistSlot, fmtDuration } from "./ui";

const pillLabel = (token: string) => {
  const a = parseQuery(token).artists[0];
  return a ? `#artist:${a}` : token;
};
const pillSlot = (token: string) => {
  const a = parseQuery(token).artists[0];
  return a ? artistSlot(a) : filterSlot(token);
};

const H = (text: string, needle: string) => ({ dangerouslySetInnerHTML: { __html: highlightHtml(text, needle) } });

// Only ↑/↓ choose the row Enter opens; the pointer just hovers (CSS), so a dropdown opening under a resting or
// jittering pointer can never turn Enter into "open this row".
function RowView({ row, needle, on, idx, pick }: { row: SearchRow; needle: string; on: boolean; idx: number; pick: () => void }) {
  const common = { class: `r${on ? " on" : ""}`, "data-idx": idx, role: "option" as const, "aria-selected": on, onMouseDown: (e: MouseEvent) => e.preventDefault(), onClick: pick };
  switch (row.kind) {
    case "video":
      return (
        <div {...common}>
          <span class="nm" {...H(row.title, needle)} />
          <span class="typ video">video{row.durationS != null ? ` · ${fmtDuration(row.durationS)}` : ""}{row.available ? "" : " · unavailable"}</span>
          {row.songs.length > 0 && <span class={`by${row.songSuggested ? " sug" : ""}`}>♪ {row.songs.join(", ")}{row.songSuggested && <i class="sugmark">suggested</i>}</span>}
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
          <span class="typ artist">artist{row.local ? " · local" : ""}{row.proposed ? " · proposed" : ""} · {row.videoCount} video{row.videoCount === 1 ? "" : "s"}</span>
        </div>
      );
    case "song":
      return (
        <div {...common}>
          <span class="nm" dangerouslySetInnerHTML={{ __html: highlightHtml(row.name, needle) + (row.englishName ? ` <span class="en">· ${highlightHtml(row.englishName, needle)}</span>` : "") }} />
          <span class="typ song">song{row.local ? " · local" : ""}{row.proposed ? " · proposed" : ""}{row.viaLyrics ? " · lyrics" : ""}</span>
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
  const [pills, setPills] = useState<string[]>([]);
  const [text, setText] = useState("");
  const q = useMemo(() => [...pills, text.trim()].filter(Boolean).join(" "), [pills, text]);
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [hi, setHi] = useState(-1);
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const dd = useRef<HTMLDivElement>(null);

  const parsed = useMemo(() => parseQuery(q), [q]);
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
    else if (row.kind === "song") void openLyrics(row.id);
    else if (row.kind === "track") {
      if (!row.songId) return setNote("This Track has no Song in the archive, so there are no lyrics to open.");
      void openLyrics(row.songId, row.versionId);
    } else return setNote("Albums have no lyrics; search for one of its Tracks.");
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
    clear();
    close();
    (document.activeElement as HTMLElement | null)?.blur();
  };

  /** Text query + Enter with no row highlighted: the results page, laid out like the Library grid. */
  const showAll = () => {
    navigate(searchHref(q.trim()));
    close();
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const clear = () => {
    setPills([]);
    setText("");
    setRes(null);
  };

  /** Filter-only query naming only Groups + Enter: that Group's own page. */
  const openGroupPage = () => {
    const g = parsed.groups.length === 1 ? parsed.groups[0] : null;
    const to = g === "songs" ? "/songs" : g === "artists" ? "/artists" : g === "videos" ? "/" : null;
    if (!to) return;
    navigate(to);
    clear();
    close();
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const addPills = (tokens: string[]) => {
    if (!tokens.length) return;
    setPills((ps) => [...ps, ...tokens.filter((t) => !ps.some((p) => p.toLowerCase() === t.toLowerCase()))]);
  };

  /** Typing: every finished word (a space after it) that is a filter moves out of the text into a pill. Only while
   *  the caret is at the end, so editing earlier text never makes it jump. */
  const onInput = (el: HTMLInputElement) => {
    const v = el.value;
    setOpen(true);
    setNote(null);
    const m = el.selectionStart === v.length ? v.match(/^([\s\S]*\s)(\S*)$/) : null;
    if (m) {
      const done = m[1]!.split(/\s+/).filter(Boolean);
      const found = done.filter(isFilterToken);
      if (found.length) {
        const rest = done.filter((w) => !isFilterToken(w));
        addPills(found);
        setText(rest.length ? `${rest.join(" ")} ${m[2]}` : m[2]!);
        return;
      }
    }
    setText(v);
  };

  const removePill = (token: string) => {
    setPills((ps) => ps.filter((p) => p !== token));
    setOpen(true);
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
      // The grid's URL has no Unshared filter, so `#unshared` opens the results page, which applies it (#158).
      if (parsed.text.trim() || parsed.unshared) return showAll();
      if (hasVideoFilters(parsed)) return applyFilters();
      openGroupPage();
    } else if (e.key === "Backspace" && pills.length) {
      const el = e.target as HTMLInputElement;
      if (el.selectionStart === 0 && el.selectionEnd === 0) {
        e.preventDefault();
        setPills((ps) => ps.slice(0, -1));
      }
    }
  };

  const showDd = open && q.trim() !== "";
  let idx = -1;
  const total = res ? res.groups.reduce((n, g) => n + g.total, 0) : 0;
  const filterOnlyApplicable = parsed.text.trim() === "" && hasVideoFilters(parsed);

  return (
    <div class="sbox" ref={box}>
      <div class="search" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), document.getElementById(SEARCH_ID)?.focus())}>
        {pills.map((t) => (
          <span class="fpill" key={t} style={{ "--c": `var(--t${pillSlot(t)})` }}>
            {pillLabel(t)}
            <button aria-label={`Remove ${pillLabel(t)}`} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => removePill(t)}>
              ×
            </button>
          </span>
        ))}
        <input
          id={SEARCH_ID}
          type="search"
          autocomplete="off"
          spellcheck={false}
          placeholder={pills.length ? "" : "Search titles, artists, lyrics…  #fav #available"}
          value={text}
          aria-controls="results"
          onInput={(e) => onInput(e.target as HTMLInputElement)}
          onFocus={() => q.trim() && setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </div>
      <span class="hint">
        <kbd>/</kbd>
      </span>
      {showDd && (
        <div class="dd" id="results" role="listbox" ref={dd}>
          <div class="dd-head">
            {!pills.length && !parsed.text.includes("#") && <span>narrow with #songs #videos #artists #tracks #albums #lyrics</span>}
            <span class="n">{res ? `${total} result${total === 1 ? "" : "s"}` : "…"}</span>
          </div>
          {filterOnlyApplicable && (
            <div class="tip">
              <kbd>Enter</kbd> applies these filters to the Library grid. <kbd>↓</kbd> then <kbd>Enter</kbd> opens a result.
            </div>
          )}
          {parsed.text.trim() !== "" && flat.length > 0 && (
            <div class="tip">
              <kbd>Enter</kbd> shows every matching Video as a grid. <kbd>↓</kbd> then <kbd>Enter</kbd> opens a result.
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
                return <RowView key={`${row.kind}${row.id}`} row={row} needle={res.needle} idx={i} on={i === hi} pick={() => openRow(row)} />;
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
