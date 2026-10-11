import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { libraryQuery, defaultLibraryState } from "../shared/libraryView";
import {
  ARTIST_KINDS, ARTIST_SORTS, artistsQuery, cmpNullsLast, cmpText, nameMatches, naturalDir, parseArtistsSearch, type ArtistSort, type ArtistsState,
} from "../shared/listView";
import type { ArtistDto, VideoDto } from "../shared/types";
import type { SearchRow } from "../shared/types";
import { NameFilter, SortControls } from "./ListControls";
import { api, apiError, loadArtists, reloadAll, useStore } from "./data";
import { navigate } from "./router";
import { Poster } from "./ui";

const SORT_LABEL: Record<ArtistSort, string> = { name: "Name", videos: "Videos", added: "Latest Video" };
const KIND_LABEL = { all: "All", mirror: "Archive", local: "Local" } as const;

/** Filter and order the Artists for the page. `videos` supplies the date of each Artist's newest Video. */
export function viewArtists(artists: ArtistDto[], st: ArtistsState, videos: VideoDto[] | null): ArtistDto[] {
  const byId = new Map((videos ?? []).map((v) => [v.id, v]));
  const added = (a: ArtistDto) => {
    const v = a.posterVideoId != null ? byId.get(a.posterVideoId) : undefined;
    return v ? (v.addedAt ?? v.createdAt) : null;
  };
  const sign = st.dir === "asc" ? 1 : -1;
  const out = artists.filter((a) => (st.kind === "all" || (st.kind === "local") === a.local) && nameMatches(st.q, a.name, a.nameLatin));
  out.sort((x, y) => {
    let c = 0;
    if (st.sort === "videos") c = sign * (x.videoCount - y.videoCount);
    else if (st.sort === "added") c = cmpNullsLast(added(x), added(y), sign);
    else c = sign * cmpText(x.name, y.name);
    return c || cmpText(x.name, y.name);
  });
  return out;
}

/** "merge into…": search Mirror Artists, pick one, confirm. Only a Local Artist can be merged (spec 2.3). */
function MergeInto({ artist, onClose }: { artist: ArtistDto; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Extract<SearchRow, { kind: "artist" }>[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState<Extract<SearchRow, { kind: "artist" }> | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus(), []);
  // a click anywhere outside the popover closes it, like the header pickers
  useEffect(() => {
    const on = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, []);
  useEffect(() => {
    if (!q.trim()) return setRows(null);
    const ac = new AbortController();
    const t = setTimeout(() => {
      api
        .search(`#artists ${q}`, ac.signal)
        .then((r) => {
          const g = r.groups.find((x) => x.key === "artists");
          setRows(((g?.rows ?? []) as SearchRow[]).filter((x): x is Extract<SearchRow, { kind: "artist" }> => x.kind === "artist" && !x.local && x.id !== artist.id));
        })
        .catch(() => {});
    }, 80);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q]);

  const confirm = async () => {
    if (!pick) return;
    setBusy("Merging…");
    try {
      await api.merge(artist.id, pick.id);
      await reloadAll();
      onClose();
    } catch (e) {
      setBusy(String((e as Error).message ?? e));
    }
  };

  return (
    <div class="merge" ref={box} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onClose(); }}>
      {pick ? (
        <div>
          <div style={{ marginBottom: "8px" }}>
            Merge <b>{artist.name}</b> into <b>{pick.name}</b>? Its {artist.videoCount} Video{artist.videoCount === 1 ? "" : "s"} move to {pick.name} and the Local Artist is removed.
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button class="btn" onClick={confirm} disabled={busy === "Merging…"}>Merge</button>
            <button class="btn" onClick={() => setPick(null)}>Back</button>
            {busy && <span class="muted">{busy}</span>}
          </div>
        </div>
      ) : (
        <>
          <input ref={input} placeholder="Search Mirror Artists…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          {rows === null ? (
            <div class="none">Type the name of an archive Artist.</div>
          ) : rows.length === 0 ? (
            <div class="none">No Mirror Artist matches. Mirror Artists arrive with the archive import.</div>
          ) : (
            rows.map((r) => (
              <button key={r.id} class="opt" onClick={() => setPick(r)}>
                {r.name} <span class="dim mono">{r.videoCount} Video{r.videoCount === 1 ? "" : "s"}</span>
              </button>
            ))
          )}
        </>
      )}
    </div>
  );
}

/** Click the name of a Local Artist to fix its spelling; Enter saves, Esc cancels. */
function NameField({ a }: { a: ArtistDto }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(a.name);
  const [err, setErr] = useState<string | null>(null);
  if (!a.local) return <span class="nm-text">{a.name}</span>;
  if (!editing)
    return (
      <button
        class="nm-text editable"
        title="Click to rename this Local Artist"
        onClick={(e) => {
          e.stopPropagation();
          setText(a.name);
          setErr(null);
          setEditing(true);
        }}
      >
        {a.name}
      </button>
    );
  const save = async () => {
    const t = text.trim();
    if (!t || t === a.name) return setEditing(false);
    try {
      await api.renameArtist(a.id, t);
      await Promise.all([loadArtists(), reloadAll()]);
      setEditing(false);
    } catch (e) {
      setErr(apiError(e));
    }
  };
  return (
    <span class="nm-edit" onClick={(e) => e.stopPropagation()}>
      <input
        class="nm-in"
        autoFocus
        value={text}
        aria-label="Artist name"
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onFocus={(e) => (e.target as HTMLInputElement).select()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.preventDefault(), void save());
          else if (e.key === "Escape") (e.preventDefault(), setEditing(false));
        }}
        onBlur={() => void save()}
      />
      {err && <span class="edit-err" role="alert">{err}</span>}
    </span>
  );
}

function ArtistRow({ a, open, setOpen }: { a: ArtistDto; open: boolean; setOpen: (v: boolean) => void }) {
  const { videos } = useStore();
  const poster = useMemo(() => videos?.find((v) => v.id === a.posterVideoId), [videos, a.posterVideoId]);
  const go = () => navigate(`/${libraryQuery({ ...defaultLibraryState(), artist: a.name })}`);
  return (
    <div
      class="arow"
      data-item=""
      data-id={a.id}
      tabIndex={0}
      role="link"
      onClick={go}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && e.key === "Enter") go();
      }}
    >
      {poster ? <Poster video={poster} /> : <div class="thumb ph" />}
      <div>
        <div class="nm">
          <NameField a={a} />
          {a.local && <span class="tag local" title="Created here; the archive has no row for this Artist">local</span>}
        </div>
        <div class="cnt">
          {a.videoCount} Video{a.videoCount === 1 ? "" : "s"}
        </div>
      </div>
      <div class="acts">
        {a.local && (
          <button
            class="btn small"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!open);
            }}
          >
            merge into…
          </button>
        )}
      </div>
      {open && <MergeInto artist={a} onClose={() => setOpen(false)} />}
    </div>
  );
}

export function Artists({ search }: { search: string }) {
  const { artists, videos } = useStore();
  const [openId, setOpenId] = useState<number | null>(null);
  useEffect(() => void loadArtists(), []);
  const st = useMemo(() => parseArtistsSearch(search), [search]);
  const shown = useMemo(() => (artists ? viewArtists(artists, st, videos) : []), [artists, videos, st]);
  const go = (patch: Partial<ArtistsState>) => navigate(`/artists${artistsQuery({ ...st, ...patch })}`, { replace: true });
  return (
    <div class="page">
      <div class="controls" role="toolbar" aria-label="Artist filters">
        <NameFilter value={st.q} onChange={(q) => go({ q })} placeholder="Filter by name…" label="Filter Artists by name" />
        <span class="sep" />
        {ARTIST_KINDS.map((k) => (
          <button key={k} class={`chip${st.kind === k ? " on" : ""}`} aria-pressed={st.kind === k} onClick={() => go({ kind: k })} title={k === "mirror" ? "Artists from the archive Mirror" : k === "local" ? "Local Artists, created here" : undefined}>
            {KIND_LABEL[k]}
          </button>
        ))}
        <span class="sep" />
        <SortControls sorts={ARTIST_SORTS} labels={SORT_LABEL} sort={st.sort} dir={st.dir} onSort={(sort) => go({ sort, dir: naturalDir(sort) })} onDir={(dir) => go({ dir })} />
        <span class="count">{artists ? `${shown.length} of ${artists.length} Artist${artists.length === 1 ? "" : "s"}` : "loading…"}</span>
      </div>
      {artists && artists.length === 0 && (
        <div class="empty-state">No Artists are assigned to a Video yet. Artists are set from the Now playing header (ticket #24) or arrive with the archive import.</div>
      )}
      {artists && artists.length > 0 && shown.length === 0 && (
        <div class="empty-state">
          No Artists match these filters.{" "}
          <button class="linkbtn" onClick={() => navigate("/artists", { replace: true })}>Clear them</button>
        </div>
      )}
      <div class="alist">
        {shown.map((a) => (
          <ArtistRow key={a.id} a={a} open={openId === a.id} setOpen={(v) => setOpenId(v ? a.id : null)} />
        ))}
      </div>
    </div>
  );
}
