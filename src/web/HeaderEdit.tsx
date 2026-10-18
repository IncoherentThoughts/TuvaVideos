// Inline metadata editing on the Now playing header (spec 5.3): click the title, click the Type tag, the "Song:" row
// and the Artist row. Every edit goes through the server, which clears the Suggested flag and stamps the source
// `manual`; the answer (the whole Video) replaces the page's copy and the library store.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { TYPES, type VideoType } from "../shared/filters";
import type { ArtistRef, SearchRow, VideoDto, VideoPatch } from "../shared/types";
import { api, apiError, loadArtists, replaceVideo } from "./data";
import { TypeTag, artistSlot, artistTitle } from "./ui";
import { Link } from "./router";
import { defaultLibraryState, libraryQuery } from "../shared/libraryView";
import { writeLink, WriteLinkError } from "./writeLink";

type Change = (v: VideoDto) => void;
export type SongRow = Extract<SearchRow, { kind: "song" }>;
type ArtistRow = Extract<SearchRow, { kind: "artist" }>;

/** A search field with a result list under it. `create` is the clearly separate "make a new one" row. */
export function Picker<T>(props: {
  placeholder: string;
  search: (q: string) => Promise<T[]>;
  row: (item: T) => ComponentChildren;
  onPick: (item: T) => void;
  /** Offered only when the search found nothing to pick. */
  create?: (q: string) => { label: string; run: () => void } | null;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<T[] | null>(null);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);

  useEffect(() => {
    if (!q.trim()) return void setItems(null);
    let alive = true;
    const t = setTimeout(() => props.search(q).then((r) => alive && (setItems(r), setHi(0))).catch(() => {}), 70);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);
  useEffect(() => {
    const on = (e: MouseEvent) => !box.current?.contains(e.target as Node) && props.onClose();
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, []);

  const create = items && items.length === 0 && q.trim() ? props.create?.(q.trim()) ?? null : null;
  const count = (items?.length ?? 0) + (create ? 1 : 0);
  const choose = (i: number) => {
    if (create && i === 0) return create.run();
    const it = items?.[i - (create ? 1 : 0)];
    if (it !== undefined) props.onPick(it);
  };

  return (
    <div class="picker" ref={box}>
      <input
        ref={field}
        autoFocus
        class="pk-in"
        placeholder={props.placeholder}
        value={q}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (count) setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + count) % count);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (count) choose(hi);
          }
        }}
      />
      {q.trim() && items && (
        <div class="pk-list" role="listbox">
          {create && (
            <button class={`pk-row create${hi === 0 ? " on" : ""}`} role="option" aria-selected={hi === 0} onMouseDown={(e) => e.preventDefault()} onClick={create.run}>
              <span class="plus" aria-hidden="true">+</span>
              {create.label}
            </button>
          )}
          {items.map((it, i) => {
            const idx = i + (create ? 1 : 0);
            return (
              <button key={i} class={`pk-row${hi === idx ? " on" : ""}`} role="option" aria-selected={hi === idx} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onPick(it)}>
                {props.row(it)}
              </button>
            );
          })}
          {count === 0 && <div class="pk-none dim">Nothing found</div>}
        </div>
      )}
    </div>
  );
}

/** A Song row in a Picker: name, English name, and "· local" for a Local Song. */
export const songPickerRow = (r: SongRow) => (
  <>
    <span>{r.name}</span>
    {r.englishName && <span class="dim"> · {r.englishName}</span>}
    {r.local && <span class="dim"> · local</span>}
    {r.proposed && <span class="dim"> · proposed</span>}
  </>
);

/** The Picker's create row for Songs: makes a Local Song named `q` (or returns the one already so named) and hands it on. */
export const createSongRow = (onCreated: (id: string) => void, onError?: (msg: string) => void) => (q: string) => ({
  label: `add '${q}' as local song`,
  run: async () => {
    try {
      const s = await api.createSong({ name: q });
      onCreated(s.id);
    } catch (e) {
      onError?.(apiError(e));
    }
  },
});

export function rowsOf<K extends "song" | "artist">(kind: K) {
  return async (q: string): Promise<Extract<SearchRow, { kind: K }>[]> => {
    const res = await api.search(`#${kind}s ${q}`);
    return res.groups.flatMap((g) => g.rows).filter((r) => r.kind === kind) as Extract<SearchRow, { kind: K }>[];
  };
}

function useEdit(v: VideoDto, onChange: Change) {
  const [err, setErr] = useState<string | null>(null);
  const apply = async (p: () => Promise<VideoDto>) => {
    try {
      const next = await p();
      replaceVideo(next);
      onChange(next);
      setErr(null);
      return true;
    } catch (e) {
      // a conflict is the conflict notice's (ConflictNotice.tsx), not an inline error
      setErr(e instanceof WriteLinkError && e.word === "conflict" ? null : String((e as Error).message ?? e).replace(/^\/api\/\S+: /, ""));
      return false;
    }
  };
  return { err, apply, patch: (p: VideoPatch) => apply(() => writeLink(v, { kind: "video.update", patch: p })) };
}

/** The title (click to edit) and, under it, the Latin title. */
export function HeaderTitle({ video: v, onChange, locked }: { video: VideoDto; onChange: Change; /** Edit gate closed (chipView.ts editGate). */ locked?: boolean }) {
  const { patch, err } = useEdit(v, onChange);
  if (locked) return <h1>{v.title}</h1>;
  return (
    <>
      <TitleField v={v} patch={patch} />
      {err && <span class="edit-err" role="alert">{err}</span>}
    </>
  );
}

/** Type tag, "Song:" row and Artist row. */
/** True when the Type, the Song or any Artist is still a suggestion (dashed): what "Accept all" would confirm. */
export const hasSuggestions = (v: VideoDto) => v.typeSuggested || (!!v.songId && v.songSuggested) || v.artists.some((a) => a.suggested);

/** "Accept all": confirms the Suggested Type, Song and Artists in one go. Hidden once nothing is left to confirm. */
export function AcceptAll({ video: v, onChange }: { video: VideoDto; onChange: Change }) {
  const [busy, setBusy] = useState(false);
  if (!hasSuggestions(v)) return null;
  const run = async () => {
    setBusy(true);
    try {
      let cur = v;
      const patch: VideoPatch = {};
      if (cur.typeSuggested) patch.type = cur.type;
      if (cur.songId && cur.songSuggested) patch.songId = cur.songId;
      if (Object.keys(patch).length) cur = await writeLink(cur, { kind: "video.update", patch });
      if (cur.artists.some((a) => a.suggested)) {
        cur = await writeLink(cur, { kind: "artists.confirm" });
        void loadArtists();
      }
      replaceVideo(cur);
      onChange(cur);
    } catch (e) {
      alert(`Could not accept the suggestions: ${String((e as Error).message ?? e).replace(/^\/api\/\S+: /, "")}`);
    }
    setBusy(false);
  };
  return (
    <button class="btn small acceptall" disabled={busy} title="Confirm the Suggested Type, Song and Artists" onClick={() => void run()}>
      ✓ Accept all
    </button>
  );
}

export function HeaderFields({ video: v, onChange }: { video: VideoDto; onChange: Change }) {
  const { patch, apply, err } = useEdit(v, onChange);
  return (
    <>
      <div class="np-meta2">
        <TypeField v={v} patch={patch} />
        <SongField v={v} patch={patch} />
        <ArtistField v={v} apply={apply} />
      </div>
      {err && <div class="edit-err" role="alert">{err}</div>}
    </>
  );
}

function TitleField({ v, patch }: { v: VideoDto; patch: (p: VideoPatch) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(v.title);
  if (!editing)
    return (
      <h1
        class="editable"
        tabIndex={0}
        title="Click to edit the title"
        onClick={() => (setText(v.title), setEditing(true))}
        onKeyDown={(e) => (e.key === "Enter" ? (setText(v.title), setEditing(true)) : undefined)}
      >
        {v.title}
      </h1>
    );
  const save = async (value: string) => {
    const t = value.trim();
    if (t && t !== v.title) await patch({ title: t });
    setEditing(false);
  };
  return (
    <input
      class="title-edit"
      autoFocus
      value={text}
      aria-label="Title"
      onInput={(e) => setText((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void save((e.target as HTMLInputElement).value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setEditing(false);
        }
      }}
      onBlur={() => setEditing(false)}
      onFocus={(e) => (e.target as HTMLInputElement).select()}
    />
  );
}

/** Flips an absolutely positioned popup above its anchor when it would run past the bottom of the viewport. */
function useFlipUp(open: boolean) {
  const pop = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!open) return void setUp(false);
    const el = pop.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const anchor = el.parentElement?.getBoundingClientRect();
    const roomAbove = anchor ? anchor.top : 0;
    setUp(r.bottom > window.innerHeight && roomAbove >= r.height);
  }, [open]);
  return { pop, up };
}

function TypeField({ v, patch }: { v: VideoDto; patch: (p: VideoPatch) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const { pop, up } = useFlipUp(open);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, [open]);
  return (
    <span class="field" ref={box}>
      <button class="tagbtn" title={v.typeSuggested ? "Suggested Type: click to change" : "Click to change the Type"} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <TypeTag type={v.type} suggested={v.typeSuggested} />
      </button>
      {v.typeSuggested && (
        <button class="confirm" title="Confirm this Type" aria-label="Confirm Type" onClick={() => void patch({ type: v.type })}>
          ✓
        </button>
      )}
      {open && (
        <div class={`menu${up ? " up" : ""}`} role="menu" ref={pop} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
          {TYPES.map((t: VideoType) => (
            <button key={t} role="menuitemradio" aria-checked={t === v.type} class={t === v.type ? "on" : ""} autoFocus={t === v.type} onClick={() => (setOpen(false), void patch({ type: t }))}>
              <TypeTag type={t} />
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** The Song tag links to every Video performing the Song, like an Artist tag; relinking lives at the top of the lyrics drawer. */
function SongField({ v, patch }: { v: VideoDto; patch: (p: VideoPatch) => Promise<boolean> }) {
  const [picking, setPicking] = useState(false);
  const s = v.song;
  return (
    <span class="field songrow">
      <span class="lbl">Song:</span>
      {s && (
        <span class={`achip songchip${v.songSuggested ? " sug" : ""}`}>
          <Link
            href={`/${libraryQuery({ ...defaultLibraryState(), song: s.id })}`}
            class="achip-main"
            title={`Every Video performing ${s.name ?? "this Song"}${v.songSuggested ? ` · Suggested (${v.suggestionSource === "title" ? "from the Video's title" : "from the archive's Performances"})` : ""} · change it from the lyrics drawer`}
          >
            {s.name ?? <span class="dim">unknown song</span>}
            {s.englishName && <span class="en"> · {s.englishName}</span>}
          </Link>
          <button class="x" title="Clear the Song" aria-label="Clear the Song" onClick={() => void patch({ songId: null })}>
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
          </button>
        </span>
      )}
      {s && v.songSuggested && (
        <button class="confirm" title="Confirm this Song" aria-label="Confirm Song" onClick={() => void patch({ songId: v.songId })}>
          ✓
        </button>
      )}
      {!s && !picking && (
        <button class="linkbtn" onClick={() => setPicking(true)}>
          + add
        </button>
      )}
      {!s && picking && <SongPicker onPick={(id) => (setPicking(false), void patch({ songId: id }))} onClose={() => setPicking(false)} />}
    </span>
  );
}

/** Search Songs (or make a Local one) and hand back the chosen id. */
export function SongPicker({ onPick, onClose }: { onPick: (songId: string) => void; onClose: () => void }) {
  return (
    <Picker<SongRow>
      placeholder="Search Songs…"
      search={rowsOf("song")}
      row={songPickerRow}
      onPick={(r) => onPick(r.id)}
      create={createSongRow(onPick)}
      onClose={onClose}
    />
  );
}

function ArtistField({ v, apply }: { v: VideoDto; apply: (p: () => Promise<VideoDto>) => Promise<boolean> }) {
  const [adding, setAdding] = useState(false);
  const save = async (ids: string[]) => {
    if (await apply(() => writeLink(v, { kind: "artists.set", artistIds: ids }))) void loadArtists();
  };
  const ids = v.artists.map((a) => a.id);
  const confirmed = v.artists.filter((a) => !a.suggested).map((a) => a.id);
  const anySuggested = v.artists.some((a) => a.suggested);
  return (
    <span class="field artistrow">
      <span class="lbl">Artists:</span>
      {v.artists.map((a: ArtistRef) => (
        <span class={`achip tag${a.suggested ? " sug" : ""}`} key={a.id} style={{ "--c": `var(--t${artistSlot(a.name)})` }} title={artistTitle(a)}>
          <Link href={`/${libraryQuery({ ...defaultLibraryState(), artist: a.name })}`} class="achip-main taglink" title={`Every Video by ${a.name}`}>
            {a.name}
            {a.suggested && <i class="sugmark">suggested</i>}
          </Link>
          <button class="x" aria-label={a.suggested ? `Reject ${a.name}` : `Remove ${a.name}`} title={a.suggested ? "Reject this suggestion" : "Remove"} onClick={() => void apply(() => writeLink(v, { kind: "artists.remove", artistId: a.id })).then((ok) => ok && void loadArtists())}>
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
          </button>
        </span>
      ))}
      {anySuggested && (
        <button class="confirm" title="Confirm the Suggested Artists" aria-label="Confirm Artists" onClick={() => void apply(() => writeLink(v, { kind: "artists.confirm" })).then((ok) => ok && void loadArtists())}>
          ✓
        </button>
      )}
      {!adding && (
        <button class="linkbtn" onClick={() => setAdding(true)}>
          {v.artists.length ? "+ add" : "add Artist…"}
        </button>
      )}
      {adding && (
        <Picker<ArtistRow>
          placeholder="Search Artists…"
          search={async (q) => (await rowsOf("artist")(q)).filter((r) => !ids.includes(r.id))}
          row={(r) => (
            <>
              <span>{r.name}</span>
              <span class="dim"> · {r.local ? "local" : r.proposed ? "proposed" : "archive"}</span>
            </>
          )}
          onPick={(r) => (setAdding(false), void save([...confirmed, ...ids.filter((i) => !confirmed.includes(i)), r.id]))}
          create={(q) => ({
            label: `add '${q}' as local artist`,
            run: async () => {
              try {
                const a = await api.createArtist(q);
                setAdding(false);
                await save(ids.includes(a.id) ? ids : [...ids, a.id]);
              } catch {}
            },
          })}
          onClose={() => setAdding(false)}
        />
      )}
    </span>
  );
}
