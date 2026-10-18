// The Chapter filmstrip under the Player on Now playing (spec 5.3): one card per Chapter with the strip frame at its start,
// timestamp, ♪ when it has a Song, a dashed "suggested" mark and the title. A focused card handles its own keys (they
// never reach the Player): Enter edits the title, t the time, `.` sets the start to the playhead, ← → nudge ±1 s and
// seek, s attaches a Song, ⌫ deletes after a confirm, y / x confirm / reject a Suggested Chapter, f toggles Favorite,
// Space seeks, Esc gives focus back to the Player.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { formatStart, nudgeStart, parseTimeField } from "../shared/timestamps";
import type { ChapterDto, ChapterPatch, VideoDto } from "../shared/types";
import { Picker, createSongRow, rowsOf, songPickerRow, type SongRow } from "./HeaderEdit";
import { TRASH } from "./ui";
import type { PlayerCtl } from "./Player";
import { api, apiError, toggleFavorite } from "./data";
import { FavoriteBadge, StripFrame } from "./ui";

interface StripProps {
  video: VideoDto;
  chapters: ChapterDto[];
  /** The Chapter the playhead is in. */
  curId: string | null;
  ctl: { current: PlayerCtl | null };
  /** A Chapter just made with `c`: its card opens with the title field. */
  newId: string | null;
  /** The list changed on the server (or a card edited): replace it and refresh the Video (chapterCount). */
  onList(list: ChapterDto[]): void;
  onAdd(): void;
  onNewDone(): void;
}

type Mode = "view" | "title" | "time" | "delete";

/** The id of the catch-all field that takes focus the moment `c` is pressed, so typing right after it is not read as Player keys. */
export const SINK_ID = "chs-sink";

/** Takes the text typed into the catch-all field (and empties it). */
function takeSink(): string {
  const el = document.getElementById(SINK_ID) as HTMLInputElement | null;
  const v = el?.value ?? "";
  if (el) el.value = "";
  return v;
}

/** Called by the page the instant `c` is pressed: move focus off the Player at once. */
export function catchTyping() {
  const el = document.getElementById(SINK_ID) as HTMLInputElement | null;
  if (!el) return;
  el.value = "";
  el.focus({ preventScroll: true });
}

export function ChapterStrip({ video, chapters, curId, ctl, newId, onList, onAdd, onNewDone }: StripProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const wantFocus = useRef<string | null>(null);
  const [pickFor, setPickFor] = useState<string | null>(null);
  const pickBox = useRef<HTMLDivElement>(null);
  const [pickLeft, setPickLeft] = useState(0);
  useEffect(() => {
    if (pickFor == null) return;
    // open next to the card, clamped so the box stays inside the strip
    const wrap = pickBox.current?.parentElement;
    const card = scroller.current?.querySelector<HTMLElement>(`[data-chapter="${pickFor}"]`);
    if (wrap && card) {
      const w = wrap.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const width = pickBox.current?.offsetWidth ?? 380;
      setPickLeft(Math.max(0, Math.min(c.left - w.left, w.width - width)));
    }
    pickBox.current?.scrollIntoView({ block: "nearest" });
  }, [pickFor]);
  const [note, setNote] = useState<string | null>(null);
  const suggestedN = chapters.filter((c) => c.suggested).length;

  const reload = async () => {
    const list = await api.chapters(video.id);
    onList(list);
    return list;
  };
  const run = async (what: () => Promise<unknown>): Promise<boolean> => {
    try {
      await what();
      setNote(null);
      await reload();
      return true;
    } catch (e) {
      setNote(apiError(e));
      return false;
    }
  };

  // keep the focus on a card across the re-sort that follows a nudge
  useLayoutEffect(() => {
    const id = wantFocus.current;
    if (id == null) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-chapter="${id}"]`);
    if (!el) return;
    wantFocus.current = null;
    // only when focus is lost or still on a card: a picker or the Player that took focus meanwhile keeps it
    const a = document.activeElement;
    if (!a || a === document.body || a.closest(".chcard")) el.focus({ preventScroll: true });
  });

  // the current Chapter stays in view while the Video plays
  useEffect(() => {
    const sc = scroller.current;
    const el = curId != null ? sc?.querySelector<HTMLElement>(`[data-chapter="${curId}"]`) : null;
    if (!sc || !el) return;
    if (el.offsetLeft < sc.scrollLeft || el.offsetLeft + el.offsetWidth > sc.scrollLeft + sc.clientWidth) sc.scrollTo({ left: Math.max(0, el.offsetLeft - 24), behavior: "smooth" });
  }, [curId]);

  const duration = video.durationS;
  const picking = chapters.find((c) => c.id === pickFor) ?? null;

  const focusNeighbour = (id: string) => {
    const i = chapters.findIndex((c) => c.id === id);
    const next = chapters[i + 1] ?? chapters[i - 1];
    if (next) wantFocus.current = next.id;
    else ctl.current?.focus();
  };

  return (
    <section class="chapter-strip" aria-label="Chapters">
      <div class="chs-head">
        <h2>
          Chapters <span class="dim">{chapters.length ? `· ${chapters.length}` : ""}</span>
        </h2>
        <button class="btn small" title="Add a Chapter at the playhead (c, with the Player focused)" onClick={onAdd}>
          + Add at playhead
        </button>
        {suggestedN > 0 && (
          <button class="btn small" title="Confirm every Suggested Chapter of this Video" onClick={() => void run(() => api.confirmAllChapters(video.id))}>
            Confirm all ({suggestedN})
          </button>
        )}
        {note && <span class="edit-err" role="alert">{note}</span>}
      </div>
      <div class="chs-wrap">
        <input id={SINK_ID} class="chs-sink" tabIndex={-1} aria-hidden="true" autocomplete="off" />
        <div class="chs-scroll" ref={scroller}>
          {chapters.length === 0 && <span class="dim chs-empty">No Chapters yet. Press <kbd>c</kbd> while the Player has focus to add one at the playhead.</span>}
          {chapters.map((c) => (
            <ChapterCard
              key={c.id}
              c={c}
              video={video}
              ctl={ctl}
              cur={c.id === curId}
              autoEdit={c.id === newId}
              duration={duration}
              onNewDone={onNewDone}
              run={run}
              keepFocus={(id) => (wantFocus.current = id)}
              afterDelete={focusNeighbour}
              pickSong={() => setPickFor(c.id)}
            />
          ))}
        </div>
        {picking && (
          <div class="chs-pick" ref={pickBox} style={{ left: `${pickLeft}px` }}>
            <div class="dim chs-picklbl">Song for {formatStart(picking.startS)} {picking.title}</div>
            <Picker<SongRow>
              placeholder="Search Songs…"
              search={rowsOf("song")}
              row={songPickerRow}
              onPick={(r) => {
                setPickFor(null);
                wantFocus.current = picking.id;
                void run(() => api.patchChapter(picking.id, { songId: r.id }));
              }}
              create={createSongRow((id) => {
                setPickFor(null);
                wantFocus.current = picking.id;
                void run(() => api.patchChapter(picking.id, { songId: id }));
              })}
              onClose={() => {
                setPickFor(null);
                wantFocus.current = picking.id;
                // the card may not have re-rendered; focus it directly too
                scroller.current?.querySelector<HTMLElement>(`[data-chapter="${picking.id}"]`)?.focus({ preventScroll: true });
              }}
            />
          </div>
        )}
      </div>
    </section>
  );
}

interface CardProps {
  c: ChapterDto;
  video: VideoDto;
  ctl: { current: PlayerCtl | null };
  cur: boolean;
  autoEdit: boolean;
  duration: number | null;
  onNewDone(): void;
  run(what: () => Promise<unknown>): Promise<boolean>;
  keepFocus(id: string): void;
  afterDelete(id: string): void;
  pickSong(): void;
}

function ChapterCard({ c, video, ctl, cur, autoEdit, duration, onNewDone, run, keepFocus, afterDelete, pickSong }: CardProps) {
  const [mode, setMode] = useState<Mode>(autoEdit ? "title" : "view");
  const [err, setErr] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const fresh = useRef(autoEdit); // opened by `c`: Esc removes it, and focus returns to the Player afterwards
  const typedAhead = useRef(autoEdit ? takeSink() : ""); // what was typed between pressing `c` and the card appearing

  // an edit that the server refuses (a taken start, say) shows its message on the card, next to the field
  const tryPatch = async (p: ChapterPatch): Promise<boolean> => {
    keepFocus(c.id);
    try {
      await api.patchChapter(c.id, p);
    } catch (e) {
      setErr(apiError(e));
      return false;
    }
    setErr(null);
    await run(async () => {});
    return true;
  };

  const toView = () => {
    setMode("view");
    setErr(null);
    queueMicrotask(() => root.current?.focus({ preventScroll: true }));
  };
  const finishNew = () => {
    if (fresh.current) {
      fresh.current = false;
      onNewDone();
      ctl.current?.focus();
    } else toView();
  };

  const saveTitle = async (text: string) => {
    const t = text.trim().replace(/\s+/g, " ");
    if (t !== c.title) {
      if (!(await tryPatch({ title: t }))) return;
    }
    setMode("view");
    finishNew();
  };
  const cancelTitle = async () => {
    if (fresh.current) {
      // a Chapter made with `c` and abandoned: remove it (manual, so no tombstone)
      fresh.current = false;
      onNewDone();
      await run(() => api.deleteChapter(c.id));
      ctl.current?.focus();
      return;
    }
    toView();
  };
  const saveTime = async (text: string) => {
    const t = parseTimeField(text);
    if (t == null) return setErr("Time as m:ss, h:mm:ss or seconds");
    if (Math.abs(t - c.startS) > 0.0005) {
      if (!(await tryPatch({ startS: t }))) return;
      ctl.current?.seekTo(t);
    }
    toView();
  };
  // A held arrow key repeats faster than the server answers: each press builds on the start the previous one asked for,
  // and the requests are sent in order.
  const latest = useRef(c);
  latest.current = c;
  const ahead = useRef<{ start: number; inFlight: number; chain: Promise<unknown> }>({ start: c.startS, inFlight: 0, chain: Promise.resolve() });
  if (!ahead.current.inFlight) ahead.current.start = c.startS;
  const nudge = (delta: number) => {
    const a = ahead.current;
    const to = nudgeStart(a.start, delta, duration);
    if (to === a.start) return;
    a.start = to;
    a.inFlight++;
    a.chain = a.chain.then(async () => {
      const ok = await tryPatch({ startS: to });
      a.inFlight--;
      if (ok) ctl.current?.seekTo(to); // the Player jumps to the new start so it can be heard
      else a.start = latest.current.startS;
    });
  };
  const setToPlayhead = async () => {
    const now = ctl.current?.time();
    if (now == null) return;
    const to = nudgeStart(now, 0, duration);
    if (to === c.startS) return;
    if (await tryPatch({ startS: to })) ctl.current?.say(`Chapter start: ${formatStart(to)}`);
  };
  const remove = async () => {
    afterDelete(c.id);
    await run(() => (c.suggested ? api.rejectChapter(c.id) : api.deleteChapter(c.id)));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation(); // keys inside a card never reach the Player (nor the global list keys)
    if (e.target !== e.currentTarget && mode !== "delete") return; // typing in a field: the field decides
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    const handled = () => e.preventDefault();
    if (mode === "delete") {
      if (k === "Enter" || k === "y") (handled(), void remove());
      else if (k === "Escape" || k === "n") (handled(), toView());
      return;
    }
    if (mode !== "view") return;
    if (k === "ArrowLeft") (handled(), nudge(-1));
    else if (k === "ArrowRight") (handled(), nudge(1));
    else if (k === ".") (handled(), void setToPlayhead());
    else if (k === "Enter" || k === "e") (handled(), setMode("title"));
    else if (k === "t") (handled(), setMode("time"));
    else if (k === "s") (handled(), pickSong());
    else if (k === "Backspace" || k === "Delete") (handled(), setMode("delete"));
    else if (k === " ") (handled(), ctl.current?.seekTo(c.startS));
    else if (k === "y" && c.suggested) (handled(), keepFocus(c.id), void run(() => api.confirmChapter(c.id)));
    else if (k === "x" && c.suggested) (handled(), void remove());
    else if (k === "f" || k === "F") (handled(), void toggleFavorite("chapter", c.id).then(() => run(async () => {})));
    else if (k === "Escape") (handled(), ctl.current?.focus());
  };

  const versions = c.song?.versions ?? [];
  const label = `${formatStart(c.startS)} ${c.title || "untitled"}${c.suggested ? ", suggested" : ""}`;
  return (
    <div
      class={`chcard${cur ? " cur" : ""}${c.suggested ? " sug" : ""}${mode !== "view" ? " editing" : ""}`}
      ref={root}
      tabIndex={0}
      role="group"
      aria-label={label}
      aria-current={cur ? "true" : undefined}
      data-chapter={c.id}
      onKeyDown={onKeyDown}
    >
      <button class="chthumb" tabIndex={-1} title={`Seek to ${formatStart(c.startS)}`} onClick={() => (ctl.current?.seekTo(c.startS), root.current?.focus({ preventScroll: true }))}>
        <StripFrame video={video} t={c.startS} />
        <span class="chnote" aria-hidden="true">
          {c.songId ? "♪" : ""}
        </span>
      </button>
      <div class="chbody">
        <div class="chline">
          {mode === "time" ? (
            <InlineInput
              class="chtime-in mono"
              label="Start time"
              initial={formatStart(c.startS)}
              onSave={saveTime}
              onCancel={toView}
            />
          ) : (
            <button class="chtime mono" tabIndex={-1} title="Click to type a time (m:ss, h:mm:ss or seconds)" onClick={() => setMode("time")}>
              {formatStart(c.startS)}
            </button>
          )}
          {c.suggested && <span class="sugmark" title={`Suggested from ${c.source}: confirm or reject`}>suggested</span>}
          <button
            class="favtoggle chfav"
            tabIndex={-1}
            aria-pressed={!!c.favoritedAt}
            aria-label={c.favoritedAt ? "Remove Chapter from Favorites" : "Add Chapter to Favorites"}
            title={c.favoritedAt ? "Favorite: click to remove (f)" : "Add to Favorites (f)"}
            onClick={() => void toggleFavorite("chapter", c.id).then(() => run(async () => {}))}
          >
            <FavoriteBadge off={!c.favoritedAt} />
          </button>
        </div>
        {mode === "title" ? (
          <InlineInput class="chtitle-in" label="Chapter title" initial={typedAhead.current || c.title} caretEnd={!!typedAhead.current} placeholder="Title…" onSave={saveTitle} onCancel={cancelTitle} />
        ) : (
          <div class={`chtitle${c.title ? "" : " dim"}`} title={c.title || "Untitled: press Enter to name it"} onDblClick={() => setMode("title")}>
            {c.title || "untitled"}
          </div>
        )}
        {c.song && (
          <div class="chsong" title={c.song.englishName ?? undefined}>
            ♪ {c.song.name ?? <span class="dim">unknown song</span>}
          </div>
        )}
        {versions.length > 1 && c.songId && (
          <span class="pills chpills" role="group" aria-label="Version">
            {versions.map((x, i) => {
              const on = c.versionId ? c.versionId === x.id : i === 0;
              return (
                <button key={x.id} class={`pill${on ? " on" : ""}`} tabIndex={-1} aria-pressed={on} onClick={() => void tryPatch({ versionId: x.id })}>
                  {x.label}
                </button>
              );
            })}
          </span>
        )}
        {mode === "delete" ? (
          <div class="chconfirm" role="alertdialog" aria-label="Confirm delete">
            <span>{c.suggested ? "Reject this suggestion?" : "Delete this Chapter?"}</span>
            <button class="btn small danger" tabIndex={-1} onClick={() => void remove()}>
              {c.suggested ? "Reject" : "Delete"} <kbd>↵</kbd>
            </button>
            <button class="btn small" tabIndex={-1} onClick={toView}>
              Cancel <kbd>esc</kbd>
            </button>
          </div>
        ) : (
          <div class="chact">
            {c.suggested && (
              <>
                <button class="chbtn ok" tabIndex={-1} title="Confirm this Chapter (y)" onClick={() => (keepFocus(c.id), void run(() => api.confirmChapter(c.id)))}>
                  ✓ confirm
                </button>
                <button class="chbtn no" tabIndex={-1} title="Reject this suggestion (x); it will not come back" onClick={() => void remove()}>
                  ✕ reject
                </button>
              </>
            )}
            <button class="chbtn" tabIndex={-1} title="Attach a Song (s)" onClick={pickSong}>
              ♪ {c.songId ? "change" : "Song"}
            </button>
            {c.songId && (
              <button class="chbtn" tabIndex={-1} title="Clear the Song" aria-label="Clear the Song" onClick={() => void tryPatch({ songId: null })}>
                ×
              </button>
            )}
            {!c.suggested && (
              <button class="chbtn no" tabIndex={-1} title="Delete this Chapter (⌫)" aria-label="Delete this Chapter" onClick={() => setMode("delete")}>
                {TRASH}
              </button>
            )}
          </div>
        )}
        {err && (
          <div class="edit-err chrerr" role="alert">
            {err}
          </div>
        )}
      </div>
    </div>
  );
}

/** A one-line field: Enter saves (reading the field's own value), Esc cancels, blur saves. */
function InlineInput(props: { initial: string; label: string; class: string; placeholder?: string; caretEnd?: boolean; onSave(text: string): void; onCancel(): void }) {
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // `autofocus` is honoured once per document by the browser, so a field that appears later takes focus itself
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus({ preventScroll: false });
    if (props.caretEnd) el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <input
      ref={input}
      class={props.class}
      aria-label={props.label}
      placeholder={props.placeholder}
      defaultValue={props.initial}
      spellcheck={false}
      autocomplete="off"
      onFocus={(e) => !props.caretEnd && (e.currentTarget as HTMLInputElement).select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          done.current = true;
          props.onSave((e.currentTarget as HTMLInputElement).value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          done.current = true;
          props.onCancel();
        }
      }}
      onBlur={(e) => {
        if (done.current) return;
        done.current = true;
        props.onSave((e.currentTarget as HTMLInputElement).value);
      }}
    />
  );
}
