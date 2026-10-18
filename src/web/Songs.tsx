// /songs: every Mirror Song some Video or Chapter points at, and every Local Song, with counts; filter by name, lyrics,
// sort; "New local Song…" makes a Local Song and opens its lyrics page so lyrics can be written.
// Opening a Song follows the search dropdown's rule (lyricsNav.ts): the first Video performing it with the drawer
// open, else the lyrics page on its own.
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  SONG_SORTS, cmpNullsLast, cmpText, nameMatches, naturalDir, parseSongsSearch, songsQuery, type SongSort, type SongsState,
} from "../shared/listView";
import type { SongListDto } from "../shared/types";
import { NameFilter, SortControls } from "./ListControls";
import { api, apiError, useStore } from "./data";
import { openLyrics } from "./lyricsNav";
import { navigate } from "./router";
import { Poster } from "./ui";

const SORT_LABEL: Record<SongSort, string> = { name: "Name", videos: "Videos", chapters: "Chapters", added: "Latest Video" };

export function viewSongs(songs: SongListDto[], st: SongsState): SongListDto[] {
  const sign = st.dir === "asc" ? 1 : -1;
  const out = songs.filter((s) => (!st.lyricsOnly || s.versionCount > 0) && nameMatches(st.q, s.name, s.englishName));
  out.sort((x, y) => {
    let c = 0;
    if (st.sort === "videos") c = sign * (x.videoCount - y.videoCount);
    else if (st.sort === "chapters") c = sign * (x.chapterCount - y.chapterCount);
    else if (st.sort === "added") c = cmpNullsLast(x.addedAt, y.addedAt, sign);
    else c = sign * cmpText(x.name, y.name);
    return c || cmpText(x.name, y.name);
  });
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function SongRow({ s }: { s: SongListDto }) {
  const { videos } = useStore();
  const poster = useMemo(() => videos?.find((v) => v.id === s.posterVideoId), [videos, s.posterVideoId]);
  const go = () => void openLyrics(s.id);
  const counts = [s.videoCount > 0 && plural(s.videoCount, "Video"), s.chapterCount > 0 && plural(s.chapterCount, "Chapter")].filter(Boolean) as string[];
  return (
    <div
      class="arow song"
      data-item=""
      data-id={s.id}
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
          <span class="nm-text">{s.name}</span>
          {s.englishName && <span class="en">{s.englishName}</span>}
          {s.local && <span class="localmark" title="A local Song: created in this library, not in the archive">local</span>}
          {s.proposed && <span class="localmark" title="Proposed: not yet in the archive">proposed</span>}
        </div>
        <div class="cnt">
          {counts.join(" · ") || <span class="dim">no Video yet</span>}
          {s.versionCount > 0 ? (
            <span class="lyr-mark" title={`${plural(s.versionCount, "lyrics Version")}${s.localVersionCount ? ` (${s.localVersionCount} local)` : " in the archive"}`}>
              {" "}· lyrics{s.localVersionCount > 0 && <span class="dim"> ({s.localVersionCount === s.versionCount ? "local" : `${s.localVersionCount} local`})</span>}
            </span>
          ) : (
            <span class="dim"> · no lyrics</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function Songs({ search }: { search: string }) {
  const [songs, setSongs] = useState<SongListDto[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const create = async (name: string) => {
    const t = name.trim();
    if (!t) return void setCreating(false);
    try {
      const s = await api.createSong({ name: t });
      setCreating(false);
      setCreateErr(null);
      navigate(`/lyrics/${s.id}`);
    } catch (e) {
      setCreateErr(apiError(e));
    }
  };
  const st = useMemo(() => parseSongsSearch(search), [search]);
  useEffect(() => {
    let alive = true;
    api.songs().then((r) => alive && setSongs(r)).catch((e) => alive && setErr(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);
  const shown = useMemo(() => (songs ? viewSongs(songs, st) : []), [songs, st]);
  const go = (patch: Partial<SongsState>) => navigate(`/songs${songsQuery({ ...st, ...patch })}`, { replace: true });
  return (
    <div class="page">
      <div class="controls" role="toolbar" aria-label="Song filters">
        <NameFilter value={st.q} onChange={(q) => go({ q })} placeholder="Filter by name…" label="Filter Songs by name" />
        <span class="sep" />
        <button class={`chip${st.lyricsOnly ? " on" : ""}`} aria-pressed={st.lyricsOnly} onClick={() => go({ lyricsOnly: !st.lyricsOnly })} title="Only Songs with lyrics in the archive Mirror">
          With lyrics
        </button>
        <span class="sep" />
        <SortControls sorts={SONG_SORTS} labels={SORT_LABEL} sort={st.sort} dir={st.dir} onSort={(sort) => go({ sort, dir: naturalDir(sort) })} onDir={(dir) => go({ dir })} />
        <span class="sep" />
        {!creating ? (
          <button class="btn small" onClick={() => setCreating(true)} title="Make a Song the archive does not have; its lyrics are written on its page">
            + New local Song…
          </button>
        ) : (
          <input
            class="pk-in"
            autoFocus
            placeholder="Song name (Enter to create)"
            aria-label="New local Song name"
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), void create((e.target as HTMLInputElement).value));
              else if (e.key === "Escape") (e.preventDefault(), setCreating(false), setCreateErr(null));
            }}
          />
        )}
        <span class="count">{songs ? `${shown.length} of ${songs.length} Song${songs.length === 1 ? "" : "s"}` : "loading…"}</span>
      </div>
      {createErr && <div class="edit-err" role="alert">{createErr}</div>}
      {err && <div class="empty-state">Could not load Songs: {err}</div>}
      {songs && songs.length === 0 && <div class="empty-state">No Song is linked to a Video or Chapter yet. Songs arrive with the archive import and are attached from Now playing.</div>}
      {songs && songs.length > 0 && shown.length === 0 && (
        <div class="empty-state">
          No Songs match these filters.{" "}
          <button class="linkbtn" onClick={() => navigate("/songs", { replace: true })}>Clear them</button>
        </div>
      )}
      <div class="alist">
        {shown.map((s) => (
          <SongRow key={s.id} s={s} />
        ))}
      </div>
    </div>
  );
}
