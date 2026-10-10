// Inline metadata editing on the Now playing header (spec 5.3): click the title, click the Type tag, the "Song:" row
// and the Artist row. Every edit goes through the server, which clears the Suggested flag and stamps the source
// `manual`; the answer (the whole Video) replaces the page's copy and the library store.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { TYPES, type VideoType } from "../shared/filters";
import type { ArtistRef, SearchRow, VideoDto, VideoPatch } from "../shared/types";
import { api, loadArtists, replaceVideo } from "./data";
import { ArtistTag, TypeTag } from "./ui";

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
      setErr(String((e as Error).message ?? e).replace(/^\/api\/\S+: /, ""));
      return false;
    }
  };
  return { err, apply, patch: (p: VideoPatch) => apply(() => api.patchVideo(v.id, p)) };
}

/** The title (click to edit) and, under it, the Latin title. */
export function HeaderTitle({ video: v, onChange }: { video: VideoDto; onChange: Change }) {
  const { patch, err } = useEdit(v, onChange);
  return (
    <>
      <TitleField v={v} patch={patch} />
      {err && <span class="edit-err" role="alert">{err}</span>}
    </>
  );
}

/** Type tag, "Song:" row and Artist row. */
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

function TypeField({ v, patch }: { v: VideoDto; patch: (p: VideoPatch) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
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
        <div class="menu" role="menu" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
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

function SongField({ v, patch }: { v: VideoDto; patch: (p: VideoPatch) => Promise<boolean> }) {
  const [picking, setPicking] = useState(false);
  const s = v.song;
  const versions = s?.versions ?? [];
  return (
    <span class="field songrow">
      <span class="lbl">Song:</span>
      {s && (
        <span class={`songchip${v.songSuggested ? " sug" : ""}`} title={v.songSuggested ? "Suggested Song (from the archive's Performances)" : undefined}>
          {s.name ?? <span class="dim">unknown song</span>}
          {s.englishName && <span class="en"> · {s.englishName}</span>}
        </span>
      )}
      {s && v.songSuggested && (
        <button class="confirm" title="Confirm this Song" aria-label="Confirm Song" onClick={() => void patch({ songId: v.songId })}>
          ✓
        </button>
      )}
      {s && versions.length > 1 && (
        <span class="pills" role="group" aria-label="Version">
          {versions.map((x, i) => {
            const on = v.versionId ? v.versionId === x.id : i === 0;
            return (
              <button key={x.id} class={`pill${on ? " on" : ""}`} aria-pressed={on} onClick={() => void patch({ versionId: x.id })}>
                {x.label}
              </button>
            );
          })}
        </span>
      )}
      {!picking && (
        <button class="linkbtn" onClick={() => setPicking(true)}>
          {s ? "change" : "set Song…"}
        </button>
      )}
      {s && !picking && (
        <button class="linkbtn" title="Clear the Song" aria-label="Clear the Song" onClick={() => void patch({ songId: null })}>
          clear ×
        </button>
      )}
      {picking && (
        <Picker<SongRow>
          placeholder="Search Songs…"
          search={rowsOf("song")}
          row={(r) => (
            <>
              <span>{r.name}</span>
              {r.englishName && <span class="dim"> · {r.englishName}</span>}
            </>
          )}
          onPick={(r) => (setPicking(false), void patch({ songId: r.id }))}
          onClose={() => setPicking(false)}
        />
      )}
    </span>
  );
}

function ArtistField({ v, apply }: { v: VideoDto; apply: (p: () => Promise<VideoDto>) => Promise<boolean> }) {
  const [adding, setAdding] = useState(false);
  const save = async (ids: number[]) => {
    if (await apply(() => api.setVideoArtists(v.id, ids))) void loadArtists();
  };
  const ids = v.artists.map((a) => a.id);
  return (
    <span class="field artistrow">
      <span class="lbl">Artists:</span>
      {v.artists.map((a: ArtistRef) => (
        <span class="achip" key={a.id}>
          <ArtistTag artist={a} />
          <button class="x" aria-label={`Remove ${a.name}`} title="Remove" onClick={() => void save(ids.filter((i) => i !== a.id))}>
            ×
          </button>
        </span>
      ))}
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
              <span class="dim"> · {r.local ? "local" : "archive"}</span>
            </>
          )}
          onPick={(r) => (setAdding(false), void save([...ids, r.id]))}
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
