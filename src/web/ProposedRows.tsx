// Proposed rows, Elevate, Expose and Repoint in the UI (docs/sharing-spec.md §3.4, §3.5, §4.4, §4.6, §7.5; ticket #146).
// A Video Editor's new Song, Version or Artist on a Shared Video is a Proposed row: created through `writeRow` with the
// "use existing / create anyway" prompt on `VD422`, edited and deleted (with the in-use count on `VD423` and the offer
// to Repoint first). The Elevate control (Video Editor + archive admin or moderator) and the Expose toggle (archive
// admin) sit on the Song (and the Artist) where its archive actions would be. Every prompt is one modal, `RowPromptHost`,
// mounted once in main.tsx; the flows here await it. The pure rules are writeOps.ts.
import { useEffect, useRef, useState } from "preact/hooks";
import type { DuplicateCandidate } from "../shared/archiveWire";
import type { RowInfo } from "../server/sharedWrites";
import type { SearchRow } from "../shared/types";
import { api, apiError } from "./data";
import { Picker, rowsOf } from "./HeaderEdit";
import { useSession } from "./session";
import { ProposedMark } from "./ui";
import { readRow, repointRow, writeRow, WriteLinkError } from "./writeLink";
import {
  candidateRows, CONFIRM_PUBLIC_LINE, duplicatePrompt, inUseLine, rowRoles, TABLE_WORD, useCount,
  type CandidateRow, type NamedRow, type RowRoles, type RowTable,
} from "./writeOps";

// ---------------------------------------------------------------------------------------------------------------
// The prompt host
// ---------------------------------------------------------------------------------------------------------------

type Prompt =
  | { kind: "duplicate"; table: RowTable; name: string; mode: "create" | "elevate"; rows: CandidateRow[]; done: (a: { use: string } | { force: true } | null) => void }
  | { kind: "text"; title: string; label: string; value: string; done: (a: string | null) => void }
  | { kind: "confirm"; title: string; body: string; ok: string; done: (a: boolean) => void }
  | { kind: "inUse"; line: string; done: (a: boolean) => void }
  | { kind: "pick"; table: RowTable; title: string; exclude: string; songId: string | null; done: (a: (NamedRow & { songId?: string | null }) | null) => void }
  | { kind: "message"; title: string; body: string; done: (a: true) => void };

let prompt: Prompt | null = null;
const subs = new Set<() => void>();
const setPrompt = (p: Prompt | null) => {
  prompt = p;
  for (const f of subs) f();
};
type Ask<P> = P extends { done: (a: infer A) => void } ? A : never;
function ask<P extends Prompt>(p: Omit<P, "done">): Promise<Ask<P>> {
  prompt?.done(null as never); // a newer prompt replaces an open one
  return new Promise((resolve) => setPrompt({ ...p, done: (a: unknown) => (setPrompt(null), resolve(a as Ask<P>)) } as P));
}

const askDuplicate = (table: RowTable, name: string, mode: "create" | "elevate", rows: CandidateRow[]) =>
  ask<Extract<Prompt, { kind: "duplicate" }>>({ kind: "duplicate", table, name, mode, rows });
const askText = (title: string, label: string, value: string) => ask<Extract<Prompt, { kind: "text" }>>({ kind: "text", title, label, value });
const askConfirm = (title: string, body: string, ok: string) => ask<Extract<Prompt, { kind: "confirm" }>>({ kind: "confirm", title, body, ok });
const askPick = (table: RowTable, title: string, exclude: string, songId: string | null) => ask<Extract<Prompt, { kind: "pick" }>>({ kind: "pick", table, title, exclude, songId });
const tell = (title: string, body: string) => ask<Extract<Prompt, { kind: "message" }>>({ kind: "message", title, body });

export function RowPromptHost() {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  if (!prompt) return null;
  return <PromptDialog key={prompt.kind + (prompt as { title?: string }).title} p={prompt} />;
}

function PromptDialog({ p }: { p: Prompt }) {
  const box = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(p.kind === "text" ? p.value : "");
  useEffect(() => {
    const d = box.current;
    if (d && !d.open) d.showModal();
  }, []);
  const cancel = () => p.done((p.kind === "confirm" || p.kind === "inUse" ? false : p.kind === "message" ? true : null) as never);
  return (
    <dialog ref={box} class="delconfirm rowprompt" aria-label="Proposed row" onCancel={(e) => (e.preventDefault(), cancel())}>
      {p.kind === "duplicate" && <DuplicateBody p={p} />}
      {p.kind === "text" && (
        <form method="dialog" onSubmit={(e) => (e.preventDefault(), p.done(text.trim() || null))}>
          <h3>{p.title}</h3>
          <input class="pk-in" autoFocus aria-label={p.label} value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
          <div class="actions">
            <button type="button" class="btn" onClick={cancel}>Cancel</button>
            <button type="submit" class="btn primary" disabled={!text.trim()}>Save</button>
          </div>
        </form>
      )}
      {p.kind === "confirm" && (
        <>
          <h3>{p.title}</h3>
          <p>{p.body}</p>
          <div class="actions">
            <button class="btn" autoFocus onClick={cancel}>Cancel</button>
            <button class="btn primary" onClick={() => p.done(true)}>{p.ok}</button>
          </div>
        </>
      )}
      {p.kind === "inUse" && (
        <>
          <h3>Still in use</h3>
          <p>{p.line}</p>
          <div class="actions">
            <button class="btn" onClick={cancel}>Cancel</button>
            <button class="btn primary" autoFocus onClick={() => p.done(true)}>Repoint…</button>
          </div>
        </>
      )}
      {p.kind === "pick" && <PickBody p={p} />}
      {p.kind === "message" && (
        <>
          <h3>{p.title}</h3>
          <p>{p.body}</p>
          <div class="actions">
            <button class="btn" autoFocus onClick={() => p.done(true)}>OK</button>
          </div>
        </>
      )}
    </dialog>
  );
}

function DuplicateBody({ p }: { p: Extract<Prompt, { kind: "duplicate" }> }) {
  const words = duplicatePrompt(p.table, p.name, p.mode, p.rows);
  return (
    <>
      <h3>{words.title}</h3>
      <ul class="cands">
        {p.rows.map((r) => (
          <li key={r.id}>
            <span class="cand-nm">{r.name}</span> <span class="dim">· {r.where}</span>
            {r.kind === "proposed" && <ProposedMark />}
            <button class="btn small" onClick={() => p.done({ use: r.id })}>{words.use}</button>
          </li>
        ))}
      </ul>
      <div class="actions">
        <button class="btn" onClick={() => p.done(null)}>Cancel</button>
        <button class="btn" onClick={() => p.done({ force: true })}>{words.force}</button>
      </div>
    </>
  );
}

function PickBody({ p }: { p: Extract<Prompt, { kind: "pick" }> }) {
  const [versions, setVersions] = useState<{ id: string; label: string; proposed: boolean; local: boolean }[] | null>(null);
  useEffect(() => {
    if (p.table === "version" && p.songId) api.song(p.songId).then((s) => setVersions(s.versions.filter((v) => v.id !== p.exclude).map((v) => ({ id: v.id, label: v.label, proposed: !!v.proposed, local: v.local })))).catch(() => setVersions([]));
  }, []);
  return (
    <>
      <h3>{p.title}</h3>
      {p.table === "version" ? (
        versions === null ? (
          <p class="dim">Loading…</p>
        ) : versions.length === 0 ? (
          <p class="dim">This Song has no other Version.</p>
        ) : (
          <ul class="cands">
            {versions.map((v) => (
              <li key={v.id}>
                <span class="cand-nm">{v.label}</span>
                {v.proposed && <ProposedMark />}
                {v.local && <span class="dim"> · local</span>}
                <button class="btn small" onClick={() => p.done({ id: v.id, name: v.label, songId: p.songId })}>Choose</button>
              </li>
            ))}
          </ul>
        )
      ) : p.table === "song" ? (
        <Picker<Extract<SearchRow, { kind: "song" }>>
          placeholder="Search Songs…"
          search={async (q) => (await rowsOf("song")(q)).filter((r) => r.id !== p.exclude)}
          row={(r) => (
            <>
              <span>{r.name}</span>
              <span class="dim"> · {r.local ? "local" : r.proposed ? "proposed" : "archive"}</span>
            </>
          )}
          onPick={(r) => p.done({ id: r.id, name: r.name })}
          onClose={() => {}}
        />
      ) : (
        <Picker<Extract<SearchRow, { kind: "artist" }>>
          placeholder="Search Artists…"
          search={async (q) => (await rowsOf("artist")(q)).filter((r) => r.id !== p.exclude)}
          row={(r) => (
            <>
              <span>{r.name}</span>
              <span class="dim"> · {r.local ? "local" : r.proposed ? "proposed" : "archive"} · {r.videoCount} Video{r.videoCount === 1 ? "" : "s"}</span>
            </>
          )}
          onPick={(r) => p.done({ id: r.id, name: r.name })}
          onClose={() => {}}
        />
      )}
      <div class="actions">
        <button class="btn" onClick={() => p.done(null)}>Cancel</button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The mark (§7.5)
// ---------------------------------------------------------------------------------------------------------------

export { ProposedMark };

// ---------------------------------------------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------------------------------------------

const dupDetail = (e: unknown): DuplicateCandidate[] | null =>
  e instanceof WriteLinkError && e.archive?.word === "duplicate-candidate" ? e.archive.detail : null;
const inUseDetail = (e: unknown): { count: number | null } | null =>
  e instanceof WriteLinkError && e.archive?.word === "in-use" ? { count: e.archive.detail?.count ?? null } : null;

/**
 * Creates a Proposed row (§3.4). On `duplicate-candidate` the prompt lists the candidates: "use this one" resolves to
 * that row's id, "create anyway" re-sends with `force`. Null when the person cancelled.
 */
export async function createProposed(table: RowTable, fields: Record<string, string | null>): Promise<string | null> {
  const name = (table === "version" ? fields.label : fields.name) ?? "";
  try {
    return (await writeRow({ kind: "proposed.create", table, fields })).id;
  } catch (e) {
    const detail = dupDetail(e);
    if (!detail) throw e;
    const rows = candidateRows(detail);
    const a = await askDuplicate(table, name, "create", rows);
    if (!a) return null;
    if ("use" in a) return a.use;
    return (await writeRow({ kind: "proposed.create", table, fields, force: true })).id;
  }
}

/** The Picker's create row on a Shared Video (Proposed) or an Unshared one (Local, as before). */
export function createRowFor(table: "song" | "artist", q: string, shared: boolean): { label: string; make: () => Promise<string | null> } {
  if (shared) return { label: `add '${q}' as proposed ${table}`, make: () => createProposed(table, { name: q }) };
  return {
    label: `add '${q}' as local ${table}`,
    make: async () => (table === "song" ? (await api.createSong({ name: q })).id : (await api.createArtist(q)).id),
  };
}

/** Repoint (§4.6): pick the target, confirm with the count, move every use. Resolves true when something moved. */
export async function repointFlow(table: RowTable, info: RowInfo, o: { deleteAfter?: boolean } = {}): Promise<boolean> {
  const from = { id: info.id, name: info.name ?? info.id };
  const to = await askPick(table, `Repoint “${from.name}” to…`, info.id, table === "version" ? info.parent?.id ?? null : null);
  if (!to) return false;
  const n = useCount(info);
  const what = table === "artist" ? "Video link" : "Video or Chapter";
  const ok = await askConfirm(
    `Repoint ${n} ${what}${n === 1 ? "" : "s"}?`,
    `Every ${what} on “${from.name}” moves to “${to.name}”, one history row per Video.${info.kind === "proposed" && (o.deleteAfter || table === "artist") ? ` The Proposed ${TABLE_WORD[table]} is then deleted.` : ""}`,
    "Repoint",
  );
  if (!ok) return false;
  try {
    const r = await repointRow(table, from, to, o);
    if (r.failed.length) await tell("Some uses were not moved", `${r.moved} moved; ${r.failed.length} not: ${r.failed.map((f) => `${f.title} (${f.line})`).join("; ")}`);
    return r.moved > 0 || r.deleted;
  } catch (e) {
    await tell("Repoint failed", (e as Error).message);
    return false;
  }
}

/** Deletes a Proposed row (§3.4): only when nothing points at it; on `in-use` the count and the Repoint offer. */
export async function deleteProposedFlow(table: RowTable, info: RowInfo): Promise<boolean> {
  const name = info.name ?? info.id;
  if (!(await askConfirm(`Delete the Proposed ${TABLE_WORD[table]} “${name}”?`, "For every Video Editor and Member. It was never on the lyrics website.", "Delete"))) return false;
  try {
    await writeRow({ kind: "proposed.delete", table, id: info.id, name, stamp: info.updatedAt });
    return true;
  } catch (e) {
    const used = inUseDetail(e);
    if (!used) {
      await tell("Not deleted", (e as Error).message);
      return false;
    }
    if (!(await ask<Extract<Prompt, { kind: "inUse" }>>({ kind: "inUse", line: inUseLine(table, name, used.count) }))) return false;
    const fresh = (await readRow(table, info.id)) ?? info;
    return repointFlow(table, fresh, { deleteAfter: true });
  }
}

/** Renames a Proposed row (any Video Editor, with history). */
export async function renameProposedFlow(table: RowTable, info: RowInfo): Promise<boolean> {
  const col = table === "version" ? "label" : "name";
  const before = info.fields ?? { [col]: info.name };
  const next = await askText(`Rename the Proposed ${TABLE_WORD[table]}`, col, String(before[col] ?? info.name ?? ""));
  if (!next) return false;
  try {
    await writeRow({ kind: "proposed.update", table, id: info.id, stamp: info.updatedAt, before, fields: { [col]: next } });
    return true;
  } catch (e) {
    await tell("Not renamed", (e as Error).message);
    return false;
  }
}

/**
 * Elevate (§4.4): a Version under a public Song says it becomes public first (`confirm_public`); on
 * `duplicate-candidate` the archive rows are offered (`use_existing`) or "as a new one" (`force`).
 */
export async function elevateFlow(table: RowTable, info: RowInfo): Promise<boolean> {
  const name = info.name ?? info.id;
  let confirmPublic = false;
  if (table === "version" && info.parent && info.parent.kind === "archive" && !info.parent.hidden) {
    if (!(await askConfirm(`Elevate “${name}” and make it public?`, CONFIRM_PUBLIC_LINE, "Elevate and publish"))) return false;
    confirmPublic = true;
  } else if (!(await askConfirm(`Elevate “${name}” into the archive?`, `It lands hidden on the lyrics website and Exposed to Members; every Video and Chapter on it moves to the archive row.`, "Elevate"))) return false;
  const base = { kind: "elevate" as const, table, id: info.id, name, confirmPublic, parent: info.parent };
  try {
    await writeRow(base);
    return true;
  } catch (e) {
    const detail = dupDetail(e);
    if (!detail) {
      await tell("Not elevated", (e as Error).message);
      return false;
    }
    const a = await askDuplicate(table, name, "elevate", candidateRows(detail, { exclude: info.id, archiveOnly: true }));
    if (!a) return false;
    try {
      await writeRow("use" in a ? { ...base, useExisting: a.use } : { ...base, force: true });
      return true;
    } catch (e2) {
      await tell("Not elevated", (e2 as Error).message);
      return false;
    }
  }
}

export async function exposureFlow(target: "song" | "artist", info: RowInfo): Promise<boolean> {
  try {
    await writeRow({ kind: "exposure", target, id: info.id, name: info.name ?? info.id, expose: !info.exposed });
    return true;
  } catch (e) {
    await tell(info.exposed ? "Not unexposed" : "Not exposed", (e as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The controls on a Song / Version / Artist
// ---------------------------------------------------------------------------------------------------------------

/** The account's row roles (`archive_role` and the grant from the Session record) and whether edits are enabled now. */
export function useRowRoles(): RowRoles & { enabled: boolean } {
  const s = useSession();
  return { ...rowRoles(s.record), enabled: s.canEdit };
}

/** The controls the account may use on one row, shown by role (§7.5); nothing at all for anyone else. */
export function RowActions({ table, id, onChanged, compact }: { table: RowTable; id: string; onChanged?: () => void; compact?: boolean }) {
  const roles = useRowRoles();
  const [info, setInfo] = useState<RowInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    readRow(table, id).then((r) => alive && setInfo(r)).catch(() => alive && setInfo(null));
    return () => void (alive = false);
  }, [table, id, n]);
  if (!info) return null;
  const proposed = info.kind === "proposed";
  const canExpose = roles.expose && info.kind === "archive" && table !== "version" && (info.hidden || info.exposed);
  const canRepointArtist = table === "artist" && (info.kind === "local" || roles.propose) && useCount(info) > 0;
  if (!(proposed && roles.propose) && !canExpose && !canRepointArtist) return null;
  const run = async (f: () => Promise<boolean>) => {
    setBusy(true);
    setErr(null);
    try {
      if (await f()) {
        setN((x) => x + 1);
        onChanged?.();
      }
    } catch (e) {
      setErr(apiError(e));
    }
    setBusy(false);
  };
  const dis = busy || (info.kind !== "local" && !roles.enabled);
  return (
    <span class={`rowacts${compact ? " compact" : ""}`} onClick={(e) => e.stopPropagation()}>
      {proposed && roles.propose && (
        <>
          <button class="btn small" disabled={dis} onClick={() => void run(() => renameProposedFlow(table, info))}>Rename</button>
          {roles.elevate && (
            <button class="btn small" disabled={dis} title="Copy it into the archive (hidden, Exposed) and move every Video and Chapter to it" onClick={() => void run(() => elevateFlow(table, info))}>
              Elevate
            </button>
          )}
          {table !== "artist" && useCount(info) > 0 && (
            <button class="btn small" disabled={dis} onClick={() => void run(() => repointFlow(table, info))}>Repoint…</button>
          )}
          <button class="btn small" disabled={dis} onClick={() => void run(() => deleteProposedFlow(table, info))}>Delete</button>
        </>
      )}
      {canRepointArtist && (
        <button class="btn small" disabled={dis} title={info.kind === "local" ? "Move this Local Artist's Videos to another Artist; the Local Artist goes" : "Move every Video on this Artist to another one"} onClick={() => void run(() => repointFlow(table, info))}>
          Repoint…
        </button>
      )}
      {canExpose && (
        <button class={`btn small${info.exposed ? " on" : ""}`} disabled={dis} aria-pressed={info.exposed} title={info.exposed ? "Members can read this hidden row; click to stop" : "Let Members read this hidden row"} onClick={() => void run(() => exposureFlow(table as "song" | "artist", info))}>
          {info.exposed ? "Exposed ✓" : "Expose"}
        </button>
      )}
      {err && <span class="edit-err" role="alert">{err}</span>}
    </span>
  );
}

/** "+ Proposed Version" on a Song (a Video Editor; the Song archive or Proposed). */
export function AddProposedVersion({ songId, onAdded }: { songId: string; onAdded?: (id: string) => void }) {
  const roles = useRowRoles();
  if (!roles.propose) return null;
  const add = async () => {
    const label = await askText("New Proposed Version", "label", "");
    if (!label) return;
    try {
      const id = await createProposed("version", { label, song_id: songId });
      if (id) onAdded?.(id);
    } catch (e) {
      await tell("Not created", (e as Error).message);
    }
  };
  return (
    <button class="btn small" disabled={!roles.enabled} title="A Proposed Version: Member-readable, never on the lyrics website" onClick={() => void add()}>
      + Proposed Version
    </button>
  );
}
