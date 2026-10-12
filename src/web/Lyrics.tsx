// The Lyrics drawer, variant "Reader" (spec 5.4, #12 prototype A). One Script at a time, Version pills, numbered lines
// continuous across stanzas, no current line, superscript Markers with a tooltip, a Footnotes section for the shown
// Script. `[` and `]` cycle Markers only while this element has focus; Esc closes it when it has focus.
// Local Songs and Local Versions (written here, not in the archive) are marked "local" in the header, on their pills
// and above their lines; a pencil opens the editor (LyricsEditor) for a Local Version, a plus adds one to any Song.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { entriesById, augmentMarkers, defaultMarkerLabel, footnoteDefDomId } from "../shared/lyrics/markers";
import { markersInReadingOrder, numberLines, parseHtmlToLines } from "../shared/lyrics/normalize";
import { SCRIPTS, effectiveScript, presentScripts } from "../shared/lyrics/scripts";
import { isPointedVersionAt, openingVersionIndex } from "../shared/lyrics/trackVersion";
import type { ScriptKey } from "../shared/lyrics/types";
import type { SongDto } from "../shared/types";
import { api, apiError } from "./data";
import { LyricsEditor } from "./LyricsEditor";

const SCRIPT_STORE = "tuva.lyricsScript";
let scriptPref: ScriptKey = "cyrillic";
try {
  const s = localStorage.getItem(SCRIPT_STORE);
  if (s === "cyrillic" || s === "transliteration" || s === "translation") scriptPref = s;
} catch {}

interface Tip {
  id: number;
  html: string;
  orphan: boolean;
  x: number;
  y: number;
}

export interface LyricsReaderProps {
  songId: string;
  /** The Version the Chapter or Video points at; null = the first in display order. */
  versionId: string | null;
  /** The pointer came from a Chapter: its Version pill reads "· this chapter". */
  fromChapter?: boolean;
  /** Present on Now playing: shows a close button and makes Esc close. */
  onClose?: () => void;
  /** A Version pill was clicked: the page writes it to the Video (absent when the pointer is a Chapter's, or on the Lyrics page). */
  onPickVersion?: (versionId: string) => void;
  /** Take focus once the Song has loaded (opened from the button or the search box). */
  autoFocus?: boolean;
  /** Called once the drawer has taken that focus, so the page can stop asking (a Chapter change must not steal focus from the Player). */
  onFocused?: () => void;
}

export function LyricsReader({ songId, versionId, fromChapter = false, onClose, onPickVersion, autoFocus = false, onFocused }: LyricsReaderProps) {
  const [song, setSong] = useState<SongDto | null | undefined>(undefined);
  const [pick, setPick] = useState<string | null>(null);
  const [script, setScript] = useState<ScriptKey>(scriptPref);
  const [tip, setTip] = useState<Tip | null>(null);
  /** The editor: closed, a new Version, or the Local Version being edited. */
  const [editing, setEditing] = useState<null | { versionId: string | null }>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameErr, setRenameErr] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);

  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!reload) setSong(undefined);
    if (!reload) setPick(null);
    api.song(songId).then((s) => alive && setSong(s)).catch(() => alive && setSong(null));
    return () => {
      alive = false;
    };
  }, [songId, reload]);
  useEffect(() => (setEditing(null), setRenaming(false)), [songId]);
  useEffect(() => setPick(null), [versionId]);
  useEffect(() => {
    if (autoFocus && song) {
      root.current?.focus({ preventScroll: true });
      onFocused?.();
    }
  }, [autoFocus, song]);

  const versions = song?.versions ?? [];
  const idx = pick ? Math.max(0, versions.findIndex((v) => v.id === pick)) : openingVersionIndex(versions, versionId);
  const version = versions[idx];
  const present = useMemo(() => presentScripts(version ? { cyrillic: version.scripts.cyrillic.html, transliteration: version.scripts.transliteration.html, translation: version.scripts.translation.html } : null), [version]);
  const sc = effectiveScript(script, present);
  const data = version?.scripts[sc];
  const prefix = version ? `${version.id}-${sc}` : "";

  const lines = useMemo(() => {
    if (!data) return [];
    return numberLines(augmentMarkers(parseHtmlToLines(data.html), data.footnotes, { kind: "fn", idPrefix: prefix, label: defaultMarkerLabel }));
  }, [data, prefix]);
  const byId = useMemo(() => entriesById(data?.footnotes ?? []), [data]);
  const used = useMemo(() => new Set(markersInReadingOrder(data?.html ?? "")), [data]);
  const defs = useMemo(() => {
    const seen = new Map<number, number>();
    return [...(data?.footnotes ?? [])]
      .map((f, i) => ({ f, i }))
      .sort((a, b) => a.f.id - b.f.id || a.i - b.i)
      .map(({ f }) => {
        const n = seen.get(f.id) ?? 0;
        seen.set(f.id, n + 1);
        const base = footnoteDefDomId("fn", prefix, f.id);
        return { f, domId: n ? `${base}-dup${n}` : base, unref: !used.has(f.id) };
      });
  }, [data, prefix, used]);

  const chooseScript = (k: ScriptKey) => {
    scriptPref = k;
    try {
      localStorage.setItem(SCRIPT_STORE, k);
    } catch {}
    setScript(k);
  };

  const supOf = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.("sup[data-fn]") as HTMLElement | null;
  const showTip = (sup: HTMLElement) => {
    const id = Number(sup.dataset.fn);
    const e = byId.get(id);
    const r = sup.getBoundingClientRect();
    setTip({ id, html: e?.text ?? "", orphan: !e, x: Math.max(8, Math.min(r.left, innerWidth - 340)), y: r.bottom + 6 });
  };
  const jump = (sup: HTMLElement) => {
    const id = Number(sup.dataset.fn);
    if (!byId.has(id)) return;
    const el = document.getElementById(footnoteDefDomId("fn", prefix, id));
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1600);
  };
  const cycle = (dir: 1 | -1) => {
    const all = [...(body.current?.querySelectorAll<HTMLElement>("sup[data-fn]") ?? [])];
    if (!all.length) return;
    const i = all.indexOf(document.activeElement as HTMLElement);
    const next = all[(i + dir + all.length) % all.length]!;
    next.focus({ preventScroll: false });
    next.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "[" || e.key === "]") {
      e.preventDefault();
      e.stopPropagation();
      cycle(e.key === "]" ? 1 : -1);
    } else if (e.key === "Escape") {
      if (tip) setTip(null);
      if (onClose) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    } else if ((e.key === "Enter" || e.key === " ") && supOf(e.target)) {
      e.preventDefault();
      jump(supOf(e.target)!);
    }
  };

  const alternates = (song?.names ?? []).filter((n) => n.kind === "alternate_title" || n.kind === "alternate_spelling").map((n) => n.text);
  const editingVersion = editing?.versionId ? versions.find((v) => v.id === editing.versionId) ?? null : null;
  /** After a save or delete: re-read the Song (forgetSong already dropped the cache) and show the Version in question. */
  const afterEdit = (showId: string | null) => {
    setEditing(null);
    setPick(showId);
    setReload((n) => n + 1);
    root.current?.focus({ preventScroll: true });
  };
  const rename = async (name: string) => {
    if (!song) return;
    const t = name.trim();
    if (!t || t === song.name) return void setRenaming(false);
    try {
      await api.patchSong(song.id, { name: t });
      setRenameErr(null);
      setRenaming(false);
      setReload((n) => n + 1);
    } catch (e) {
      setRenameErr(apiError(e));
    }
  };

  return (
    <aside class="drawer" ref={root} tabIndex={-1} data-lyrics-drawer="" aria-label="Lyrics" onKeyDown={onKeyDown}>
      <div class="hd">
        <div class="row">
          {/* Title first; the controls sit beside it when they fit and drop below it (right-aligned) when they do not. */}
          <span class="ttl">
            {song?.local && !renaming ? (
              <span
                class="editable ttl-btn"
                role="button"
                tabIndex={0}
                title="Local Song · click to rename"
                onClick={() => setRenaming(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") (e.preventDefault(), e.stopPropagation(), setRenaming(true));
                }}
              >
                {song.name}
              </span>
            ) : song?.local && renaming ? (
              <input
                class="pk-in ttl-in"
                autoFocus
                value={song.name}
                aria-label="Song name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.preventDefault(), void rename((e.target as HTMLInputElement).value));
                  else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setRenaming(false));
                }}
                onBlur={(e) => void rename((e.target as HTMLInputElement).value)}
              />
            ) : (
              (song ? song.name : song === null ? "Unknown song" : "Lyrics")
            )}
            {song?.englishName && <span class="en">· {song.englishName}</span>}
            {song?.local && <span class="localmark" title="A local Song: created in this library, not in the archive">local song</span>}
          </span>
          <span class="hctl">
            <span class="seg" role="group" aria-label="Script">
              {SCRIPTS.map((x) => (
                <button key={x.key} class={sc === x.key ? "on" : ""} aria-pressed={sc === x.key} disabled={!present.includes(x.key)} title={present.includes(x.key) ? undefined : `This Version has no ${x.label}`} onClick={() => chooseScript(x.key)}>
                  {x.label}
                </button>
              ))}
            </span>
            {song && !editing && (
              <button class="ib add" aria-label="Add a local Version" title="Write a local lyrics Version for this Song" onClick={() => setEditing({ versionId: null })}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 4v16M4 12h16" /></svg>
              </button>
            )}
            {onClose && (
              <button class="ib close" aria-label="Close lyrics" title="Close (Esc while the drawer has focus)" onClick={onClose}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
              </button>
            )}
          </span>
        </div>
        {renameErr && <div class="edit-err" role="alert">{renameErr}</div>}
        {alternates.length > 0 && (
          <div class="alts dim" title={alternates.join(", ")}>
            also: {alternates.join(" · ")}
          </div>
        )}
        {versions.length > 1 && (
          <div class="pills" role="group" aria-label="Version">
            {versions.map((x, i) => (
              <button key={x.id} class={`pill${i === idx ? " on" : ""}${x.local ? " local" : ""}`} aria-pressed={i === idx} title={`${x.local ? "Local Version (stored here, not in the archive)" : "Archive Version"}${onPickVersion ? " · sets this Video's Version" : ""}`} onClick={() => (setPick(x.id), onPickVersion?.(x.id))}>
                {x.label}
                {x.local && <span class="b"> · local</span>}
                {fromChapter && isPointedVersionAt(versions, versionId, i) && <span class="b"> · this chapter</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        class="body"
        id="lyrbody"
        ref={body}
        onMouseOver={(e) => supOf(e.target) && showTip(supOf(e.target)!)}
        onMouseOut={(e) => supOf(e.target) && !supOf(e.relatedTarget) && setTip(null)}
        onFocusIn={(e) => supOf(e.target) && showTip(supOf(e.target)!)}
        onFocusOut={(e) => supOf(e.target) && setTip(null)}
        onScroll={() => tip && setTip(null)}
        onClick={(e) => supOf(e.target) && jump(supOf(e.target)!)}
      >
        {editing && song && (
          <LyricsEditor
            key={editing.versionId ?? "new"}
            songId={song.id}
            version={editingVersion}
            takenLabels={versions.filter((v) => v.id !== editing.versionId).map((v) => v.label)}
            script={sc}
            onSaved={afterEdit}
            onDeleted={() => afterEdit(null)}
            onCancel={() => (setEditing(null), root.current?.focus({ preventScroll: true }))}
          />
        )}
        {!editing && song === undefined && <p class="empty">Loading…</p>}
        {!editing && song === null && <p class="empty">This Song is not in the Mirror (unknown song).</p>}
        {!editing && song && !version && (
          <p class="empty">
            {song.local ? "This local Song has no lyrics yet." : "This Song has no Version in the Mirror: no lyrics."}{" "}
            <button class="linkbtn" onClick={() => setEditing({ versionId: null })}>+ add local lyrics</button>
          </p>
        )}
        {!editing && version && (
          <div class={`vsrc${version.local ? " local" : ""}`} role="note">
            {version.local ? (
              <>
                <span class="localmark">local</span>
                <span>Stored in this library, not in the archive.</span>
                <button class="linkbtn" onClick={() => setEditing({ versionId: version.id })}>edit</button>
              </>
            ) : (
              <span class="dim">From the archive Mirror.</span>
            )}
          </div>
        )}
        {!editing && version && present.length === 0 && <p class="empty">This Version has no text.</p>}
        {!editing && version && present.length > 0 && (
          <div class="lyr" lang={SCRIPTS.find((x) => x.key === sc)!.lang}>
            {lines.map((l, i) =>
              l.blank ? (
                <div class="gap" key={i} />
              ) : (
                <div class="l" key={i}>
                  <span class="ln" aria-hidden="true">{l.n}</span>
                  <span dangerouslySetInnerHTML={{ __html: l.html }} />
                </div>
              ),
            )}
          </div>
        )}
        {!editing && defs.length > 0 && (
          <section aria-label="Footnotes">
            <div class="fnh">
              <span>Footnotes</span>
              <span class="dim">{defs.length}</span>
            </div>
            <ul class="fnlist">
              {defs.map(({ f, domId, unref }) => (
                <li key={domId} id={domId} class={unref ? "unref" : ""} role="doc-endnote">
                  <b>{f.id}</b>
                  {f.text.trim() ? <span dangerouslySetInnerHTML={{ __html: f.text }} /> : <span class="dim">(empty)</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {tip && (
        <div class="fntip" role="tooltip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }}>
          <b>{tip.id}</b>
          {tip.orphan ? <i class="dim">no footnote with this number</i> : tip.html.trim() ? <span dangerouslySetInnerHTML={{ __html: tip.html }} /> : <i class="dim">(empty)</i>}
        </div>
      )}
    </aside>
  );
}
