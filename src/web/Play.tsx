// /play/:videoId[?t=] — the Now playing screen (spec 5.3): the Player on top, the title row, then availability icon,
// favorite badge, Type and Artist tags (edited inline, HeaderEdit.tsx), with the Chapter strip area reserved below
// (ticket #26) and the Lyrics drawer on the right (Lyrics.tsx, spec 5.4).
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { chapterAt, lyricsTarget } from "../shared/lyrics/target";
import { positionIn, resolvePlayingFrom, SOURCE_LABEL, stepFrom } from "../shared/playingFrom";
import type { ChapterDto, VideoDto } from "../shared/types";
import { Player, type PlayerCtl } from "./Player";
import { ChapterStrip, catchTyping } from "./Chapters";
import { api, apiError, replaceVideo, setLastPlayed, toggleFavorite, useStore } from "./data";
import { loadPlayingFrom, onPlayingFromChange, savePlayingFrom } from "./playingFrom";
import { current, jumpTo, jumpToVideo, widenToVideo, cycleRepeat, type Playlist } from "../shared/playlist";
import { entryRange, libraryPlaylist, nextEntry, nextLabel, playlistFor, prevEntry, prevLabel, repeatLabel, shuffleLabel, shuffleStartLabel, toggleShuffle, type Move } from "../shared/playlistPlayer";
import { endPlaylist, loadPlaylist, onPlaylistChange, playlistStarts, startPlaylist, updatePlaylist } from "./playlist";
import { endedShows, markEnded, showPlayedFor, toggleShowPlayed, type EndedMark, type ShowPlayed } from "../shared/playlistPanel";
import { PlaylistPanel } from "./PlaylistPanel";
import { navigate, playHref } from "./router";
import { AcceptAll, HeaderFields, HeaderTitle } from "./HeaderEdit";
import { LyricsReader } from "./Lyrics";
import { RelocateButton } from "./Relocate";
import { AvailabilityIcon, FavoriteBadge, fmtDuration } from "./ui";
import { AudioPanel } from "./AudioPanel";
import { DeleteVideoDialog } from "./DeleteVideo";
import { DEFAULT_AUDIO, isDefaultAudio, type AudioPreset, type AudioState } from "../shared/audio";

const POLL_MS = 3000;

// The Playlist panel outlives this screen (Play unmounts between Videos of a list page): a new Playlist start opens it
// once, and it stays as the user left it until the Playlist ends. Not persisted across a reload.
let panelWanted = false;
let panelSeenStart = 0;

export function Play({ videoId, t, lyrics, lyricsVersion }: { videoId: number; t: number | null; lyrics: string | null; lyricsVersion: string | null }) {
  const { videos } = useStore();
  const [v, setV] = useState<VideoDto | null | undefined>(undefined);

  // load, then poll: Root availability changes under a playing Copy are seen here (spec 4.2)
  useEffect(() => {
    setLastPlayed(videoId);
    setV(undefined);
    let alive = true;
    api.video(videoId).then((r) => alive && setV(r)).catch(() => alive && setV(null));
    const timer = setInterval(() => {
      api.video(videoId).then((r) => alive && setV(r)).catch(() => {});
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [videoId]);

  // Playing from: the snapshot taken when this Video was opened from a list; library order otherwise
  const [snapVersion, setSnapVersion] = useState(0);
  useEffect(() => onPlayingFromChange(() => setSnapVersion((n) => n + 1)), []);
  const playingFrom = useMemo(
    () => resolvePlayingFrom(loadPlayingFrom(), videoId, videos ? videos.map((x) => x.id) : [videoId]),
    [videoId, videos, snapVersion],
  );
  useEffect(() => {
    // keep the library-order fallback across a reload; never replace a list snapshot that still holds the Video
    if (videos && playingFrom.source === "library" && loadPlayingFrom()?.ids.includes(videoId) !== true) savePlayingFrom("library", playingFrom.ids);
  }, [playingFrom, videos, videoId]);

  const byId = useMemo(() => new Map((videos ?? []).map((x) => [x.id, x])), [videos]);
  const pos = positionIn(playingFrom, videoId);

  const onStep = useCallback(
    (dir: 1 | -1): string | null => {
      // Videos with no Available Copy are skipped: stepping onto one would only show "Copy unavailable"
      const to = stepFrom(playingFrom, videoId, dir, (id) => byId.get(id)?.available ?? true);
      if (to == null) return null;
      navigate(playHref(to));
      return `${dir > 0 ? "Next" : "Previous"}: ${byId.get(to)?.title ?? `Video ${to}`}`;
    },
    [playingFrom, videoId, byId],
  );

  // ---- Playlist (spec 4.8) ----
  // Opening a Video by any route (r, URL, grid, search, `<` `>`): in the Playlist it moves the cursor there, outside it the
  // Playlist ends and the Player is back to plain Playing from.
  const [, setPlTick] = useState(0);
  const [plOpen, setPlOpenState] = useState(() => {
    // mounting after a list page's shuffle started a Playlist: the panel opens
    if (playlistStarts() !== panelSeenStart) (panelSeenStart = playlistStarts(), (panelWanted = true));
    return panelWanted && !!loadPlaylist();
  });
  const setPlOpen = (on: boolean) => (panelWanted = on, setPlOpenState(on));
  useEffect(
    () =>
      onPlaylistChange(() => {
        setPlTick((n) => n + 1);
        if (!loadPlaylist()) setPlOpen(false); // the Playlist ended
        else if (playlistStarts() !== panelSeenStart) (panelSeenStart = playlistStarts(), setPlOpen(true)); // a new one started
      }),
    [],
  );
  const [ended, setEnded] = useState<EndedMark | null>(null); // the Player reached the end with Repeat off
  const [shownPlayed, setShownPlayed] = useState<ShowPlayed>({ gen: 0, on: false });
  useEffect(() => {
    const pl = loadPlaylist();
    if (!pl || current(pl)?.videoId === videoId) return;
    const jumped = jumpToVideo(pl, videoId);
    if (jumped) updatePlaylist(jumped);
    else endPlaylist();
  }, [videoId]);
  const playlist = playlistFor(loadPlaylist(), videoId);
  const [nonce, setNonce] = useState(0); // a new Entry of the same Video opens a fresh Player (it opens at the Entry's start)
  const playable = (id: number) => byId.get(id)?.available ?? true;
  const title = (id: number) => byId.get(id)?.title ?? `Video ${id}`;

  /** Make `pl`'s current Entry the one on screen: a Chapter Entry opens at its Chapter's start. */
  const goTo = (pl: Playlist) => {
    const e = current(pl)!;
    const open = (at: number | null, next: Playlist) => {
      updatePlaylist(next);
      if (e.videoId === videoId) setNonce((n) => n + 1);
      navigate(playHref(e.videoId, at));
    };
    if (e.chapterId === undefined) return open(null, pl);
    const from = e.videoId === videoId && chaptersRef.current.length ? Promise.resolve(chaptersRef.current) : api.chapters(e.videoId).catch(() => []);
    void from.then((list) => {
      const c = list.find((x) => x.id === e.chapterId);
      open(c ? c.startS : null, c ? pl : widenToVideo(pl)); // a deleted Chapter plays as the Video
    });
  };
  const playlistNext = (via: "end" | "key"): { kind: Move["kind"]; label: string | null } => {
    const pl = loadPlaylist();
    if (!pl) return { kind: "none", label: null };
    const m = nextEntry(pl, via, playable);
    if (m.kind === "move") {
      goTo(m.pl);
      return { kind: "move", label: nextLabel(title(current(m.pl)!.videoId)) };
    }
    if (m.pl !== pl) updatePlaylist(m.pl); // a one-Entry list wrapping reshuffles
    return { kind: m.kind, label: null };
  };
  const playlistPrev = (): string | null => {
    const pl = loadPlaylist();
    const back = pl && prevEntry(pl, playable);
    if (!back) return null;
    goTo(back);
    return prevLabel(title(current(back)!.videoId));
  };
  const playlistShuffle = (): string => {
    const pl = loadPlaylist();
    if (pl) {
      updatePlaylist(toggleShuffle(pl));
      return shuffleLabel(loadPlaylist()!);
    }
    if (!videos) return "Library is still loading";
    const started = libraryPlaylist(videos.map((x) => x.id), videoId);
    if (!started) return "This Video is not in the library";
    startPlaylist(started.entries, { source: "library-all", shuffled: true, startAt: started.order[0] });
    return shuffleStartLabel(started.entries.length);
  };
  const playlistRepeat = (): string => {
    const pl = loadPlaylist();
    if (!pl) return "Repeat: one";
    updatePlaylist(cycleRepeat(pl));
    return repeatLabel(loadPlaylist()!);
  };

  const panelPl = loadPlaylist();
  const closePanel = () => (setPlOpen(false), ctl.current?.focus());
  const say = (t: string | null) => t && ctl.current?.say(t);
  const jumpEntry = (entryIndex: number) => {
    const pl = loadPlaylist();
    if (pl) goTo(jumpTo(pl, entryIndex));
  };

  const refresh = () => api.video(videoId).then(setV).catch(() => {});

  // ---- Chapters (spec 5.3) ----
  const [chapters, setChapters] = useState<ChapterDto[]>([]);
  const [newId, setNewId] = useState<number | null>(null);
  const [curId, setCurId] = useState<number | null>(null);
  const ctl = useRef<PlayerCtl | null>(null);
  const chaptersRef = useRef<ChapterDto[]>([]);
  const playhead = useRef(0);
  const pointCurrent = () => setCurId(chapterAt(chaptersRef.current, playhead.current)?.id ?? null);
  const acceptChapters = (list: ChapterDto[]) => {
    chaptersRef.current = list;
    setChapters(list);
    pointCurrent();
    // the Library's in-memory copy carries chapterCount: keep it right
    void api.video(videoId).then((fresh) => (replaceVideo(fresh), setV(fresh))).catch(() => {});
  };
  useEffect(() => {
    chaptersRef.current = [];
    setChapters([]);
    setNewId(null);
    setCurId(null);
    playhead.current = 0;
    let alive = true;
    api.chapters(videoId).then((list) => alive && (chaptersRef.current = list, setChapters(list), pointCurrent())).catch(() => {});
    return () => {
      alive = false;
    };
  }, [videoId]);
  const onTime = useCallback((t: number) => {
    playhead.current = t;
    const id = chapterAt(chaptersRef.current, t)?.id ?? null;
    setCurId((cur) => (cur === id ? cur : id));
  }, []);
  const addChapter = async (t?: number) => {
    const at = t ?? ctl.current?.time() ?? playhead.current;
    catchTyping(); // keys typed before the new card opens must not reach the Player
    try {
      const c = await api.addChapter(videoId, { startS: at });
      setNewId(c.id);
      acceptChapters(await api.chapters(videoId));
    } catch (e) {
      ctl.current?.say(apiError(e));
      ctl.current?.focus();
    }
  };
  const marks = useMemo(() => chapters.map((c) => ({ startS: c.startS, title: c.title || "untitled", suggested: c.suggested })), [chapters]);
  const curChapter = chapters.find((c) => c.id === curId) ?? null;

  // The State panel (`i`): in the drawer slot while no lyrics are shown, under the Player otherwise.
  const [stateOpen, setStateOpen] = useState(false);
  const stateHost = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);
  useEffect(() => bump((n) => n + 1), [stateOpen]); // the host div mounts in this render; the Player portals into it on the next

  // The Audio panel (`a`, spec 4.7) takes the drawer slot; opening it closes State and Lyrics, and vice versa.
  // The Video's settings load with it and every change is written back (debounced); the defaults clear the row.
  const [audioOpen, setAudioOpen] = useState(false);
  const toggleAudio = () => {
    setAudioOpen((on) => {
      if (!on) (setStateOpen(false), setDrawer(false));
      return !on;
    });
  };
  const [audio, setAudio] = useState<AudioState | undefined>(undefined);
  const audioWrite = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setAudio(undefined);
    let alive = true;
    api.audio(videoId).then((r) => alive && setAudio(r.state ?? DEFAULT_AUDIO)).catch(() => alive && setAudio(DEFAULT_AUDIO));
    return () => {
      alive = false;
      clearTimeout(audioWrite.current);
    };
  }, [videoId]);
  const changeAudio = (patch: Partial<AudioState>) =>
    setAudio((prev) => {
      // functional: two changes in one tick (a click and a slider, say) must both land
      const next = { ...(prev ?? DEFAULT_AUDIO), ...patch };
      clearTimeout(audioWrite.current);
      audioWrite.current = setTimeout(() => void api.setAudio(videoId, isDefaultAudio(next) ? null : next).catch((e) => ctl.current?.say(apiError(e))), 400);
      return next;
    });
  const [presets, setPresets] = useState<AudioPreset[]>([]);
  useEffect(() => {
    if (audioOpen) api.audioPresets().then(setPresets).catch(() => {});
  }, [audioOpen]);
  const savePreset = async (name: string, eq: number[]) => {
    await api.savePreset(name, eq);
    setPresets(await api.audioPresets());
  };
  const deletePreset = async (name: string) => {
    await api.deletePreset(name).catch((e) => ctl.current?.say(apiError(e)));
    setPresets(await api.audioPresets());
  };

  // The drawer: closed by default; opened by its button or by choosing a Song in the search box (`?lyrics=<song>`).
  const [deleting, setDeleting] = useState(false);
  const deleted = useRef(false);
  const [drawer, setDrawer] = useState(!!lyrics);
  const [focusDrawer, setFocusDrawer] = useState(!!lyrics);
  const seenParam = useRef(lyrics);
  useEffect(() => {
    if (lyrics && (lyrics !== seenParam.current || !drawer)) (setDrawer(true), setFocusDrawer(true));
    seenParam.current = lyrics;
  }, [lyrics, lyricsVersion]);
  useEffect(() => { if (drawer) setAudioOpen(false); }, [drawer]);
  const closeDrawer = () => {
    setDrawer(false);
    setFocusDrawer(false);
    if (lyrics) navigate(playHref(videoId, t), { replace: true });
    document.querySelector<HTMLElement>("[data-player]")?.focus({ preventScroll: true });
  };
  // `y`: the drawer, when there is a Song to show (the Chapter's or the Video's)
  const toggleLyrics = (): string | null => {
    if (drawer) return (closeDrawer(), null);
    if (!lyrics && !(v && lyricsTarget(curChapter, v))) return "no lyrics: this Video has no Song";
    setDrawer(true);
    setFocusDrawer(true);
    return null;
  };
  // The Chapter the playhead is in, if it has a Song; else the Video's own Song (spec 5.4).
  const target = lyrics
    ? { songId: lyrics, versionId: lyricsVersion, fromChapter: false }
    : v ? lyricsTarget(curChapter, v) : null;

  // `t` (spec 7.4): the Chapter the playhead is in, then the Video's own Song
  const studioSongs = useRef<string[]>([]);
  studioSongs.current = [...new Set([curChapter?.songId, v?.songId].filter((x): x is string => !!x))];

  const entry = playlist ? entryRange(current(playlist), chapters, v?.durationS ?? null) : null;

  const panelOpen = plOpen && !!loadPlaylist();
  const drawerOpen = (audioOpen && !drawer && !!audio) || (!drawer && stateOpen) || drawer;

  if (v === undefined) return <div class="np"><p class="muted">Loading…</p></div>;
  if (v === null || v.id !== videoId) return <div class="empty-state">No such Video.</div>;

  return (
    <div class="np">
      <div class="np-main">
        <Player key={`${v.id}:${nonce}`} video={v} playlist={playlist} entry={entry} onPlaylistNext={playlistNext} onPlaylistPrev={playlistPrev} onPlaylistShuffle={playlistShuffle} onPlaylistRepeat={playlistRepeat} onPlaylistEnded={() => { const pl = loadPlaylist(); if (pl) setEnded(markEnded(pl, playlistStarts())); }} onPlaylistPanelToggle={() => setPlOpen(!plOpen && !!loadPlaylist())} playlistPanelOpen={plOpen} onPlaylistWiden={() => { const pl = loadPlaylist(); if (pl) updatePlaylist(widenToVideo(pl)); }} startT={t} chapters={marks} onStep={onStep} onAddChapter={(at) => void addChapter(at)} onTime={onTime} ctl={ctl} studioSongs={() => studioSongs.current} stateOpen={stateOpen} onVideo={setV} onStateToggle={() => (setAudioOpen(false), setStateOpen((on) => !on))} stateHost={drawer ? undefined : stateHost} onLyricsToggle={toggleLyrics} audioOpen={audioOpen} onAudioToggle={toggleAudio} audioSettings={audio} />
        <div class="np-head">
          <div class="np-titlerow">
            <div class="np-titles">
              <HeaderTitle video={v} onChange={setV} />
              {v.titleLatin && <div class="latin muted">{v.titleLatin}</div>}
            </div>
            <span class="from mono" title="< and > step through this list">
              Playing from: {SOURCE_LABEL[playingFrom.source]}
              {pos && <> · {pos.n} of {pos.total}</>}
            </span>
          </div>
          <div class="np-meta">
            <AvailabilityIcon availability={v.availability} />
            <button
              class="favtoggle"
              aria-pressed={!!v.favoritedAt}
              aria-label={v.favoritedAt ? "Remove from Favorites" : "Add to Favorites"}
              title={v.favoritedAt ? "Favorite: click to remove" : "Click to add to Favorites"}
              onClick={() => {
                void toggleFavorite("video", v.id).then(refresh);
                document.querySelector<HTMLElement>("[data-player]")?.focus({ preventScroll: true });
              }}
            >
              <FavoriteBadge off={!v.favoritedAt} />
            </button>
            <RelocateButton video={v} onChange={setV} />
            <span class="mono dim">{fmtDuration(v.durationS)}</span>
            <button class={`btn small lyricsbtn${drawer ? " on" : ""}`} aria-pressed={drawer} aria-controls="lyrbody" title="Lyrics drawer (y while the Player has focus)" onClick={() => (drawer ? closeDrawer() : (setDrawer(true), setFocusDrawer(true)))}>
              Lyrics
            </button>
            <AcceptAll video={v} onChange={setV} />
          </div>
          <HeaderFields video={v} onChange={setV} />
        </div>
        <ChapterStrip video={v} chapters={chapters} curId={curId} ctl={ctl} newId={newId} onList={acceptChapters} onAdd={() => void addChapter()} onNewDone={() => setNewId(null)} />
        {v.youtubeId && (
          <div class="np-source dim">
            YouTube:{" "}
            <a href={`https://www.youtube.com/watch?v=${v.youtubeId}`} target="_blank" rel="noopener noreferrer" title="Open the YouTube page in your browser">
              youtube.com/watch?v={v.youtubeId}
            </a>
          </div>
        )}
        {v.instagramId && (
          <div class="np-source dim">
            Instagram:{" "}
            <a href={`https://www.instagram.com/p/${v.instagramId}/`} target="_blank" rel="noopener noreferrer" title="Open the Instagram post in your browser">
              instagram.com/p/{v.instagramId}
            </a>
          </div>
        )}
        <div class="np-delete">
          <button class="btn small danger" onClick={() => setDeleting(true)}>
            Delete from library…
          </button>
        </div>
        {deleting && (
          <DeleteVideoDialog
            video={v}
            onDeleted={() => (deleted.current = true)}
            onClose={() => {
              setDeleting(false);
              if (deleted.current) navigate("/");
              else ctl.current?.focus();
            }}
          />
        )}
      </div>
      {(drawerOpen || panelOpen) && (
        <div class="drawer-wrap">
          {audioOpen && !drawer && audio && (
            <AudioPanel
              vid={{ get current() { return ctl.current?.video() ?? null; } }}
              state={audio}
              onChange={changeAudio}
              onReset={() => changeAudio(DEFAULT_AUDIO)}
              presets={presets}
              onSavePreset={savePreset}
              onDeletePreset={deletePreset}
              onClose={() => (setAudioOpen(false), ctl.current?.focus())}
              copies={v.copies}
            />
          )}
          {!drawer && stateOpen && <div class="drawer statehost" ref={stateHost} />}
          {drawer &&
            (target ? (
              <LyricsReader key={target.fromChapter ? "chapter" : target.songId} songId={target.songId} versionId={target.versionId} fromChapter={target.fromChapter} onClose={closeDrawer} onPickVersion={!target.fromChapter && !lyrics && v.songId === target.songId ? (versionId) => void api.patchVideo(v.id, { versionId }).then((fresh) => (replaceVideo(fresh), setV(fresh))).catch(() => {}) : undefined} onChangeSong={!target.fromChapter && !lyrics && v.songId === target.songId ? (songId) => void api.patchVideo(v.id, { songId }).then((fresh) => (replaceVideo(fresh), setV(fresh))).catch(() => {}) : undefined} autoFocus={focusDrawer} onFocused={() => setFocusDrawer(false)} />
            ) : (
              <aside class="drawer" tabIndex={-1} data-lyrics-drawer="" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), closeDrawer())}>
                <div class="hd"><div class="row"><span class="ttl">Lyrics</span><button class="ib" aria-label="Close lyrics" onClick={closeDrawer}>×</button></div></div>
                <div class="body"><p class="empty">no lyrics: this Video has no Song. Set one with the Song row, or search for a Song.</p></div>
              </aside>
            ))}
          {panelOpen && panelPl && (
            <PlaylistPanel
              playlist={panelPl}
              gen={playlistStarts()}
              videos={byId}
              ended={endedShows(ended, panelPl, playlistStarts())}
              showPlayed={showPlayedFor(shownPlayed, playlistStarts())}
              onShowPlayed={() => setShownPlayed((s) => toggleShowPlayed(s, playlistStarts()))}
              onJump={jumpEntry}
              onPrev={() => say(playlistPrev())}
              onNext={() => say(playlistNext("key").label)}
              onShuffle={() => say(playlistShuffle())}
              onRepeat={() => say(playlistRepeat())}
              onClose={closePanel}
            />
          )}
        </div>
      )}
    </div>
  );
}
