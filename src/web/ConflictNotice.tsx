// The conflict notice (docs/sharing-spec.md §4.2; ticket #145): a Shared write that met a newer row reloads it and says
// who changed it, when, old → new, with **Keep theirs** (the default) or **Apply mine** (a fresh write). And the scan
// warning (§4.5): files on this machine that belong to a soft-deleted Shared Video, with the reason and who deleted it;
// a Video Editor may restore it, for anyone else the files stay unlisted.
import { useEffect, useState } from "preact/hooks";
import { useSession } from "./session";
import { reloadAll } from "./data";
import { applyMine, keepTheirs, useConflict, writeLink } from "./writeLink";
import { conflictLines } from "./writeOps";

export function ConflictNotice() {
  const c = useConflict();
  const s = useSession();
  if (c.phase === "idle") return null;
  if (c.phase === "reloading")
    return (
      <div class="root-bar conflict-bar" role="status">
        <span>Someone changed this Video after you loaded it. Reloading it…</span>
      </div>
    );
  const l = conflictLines(c.entry.detail, s.record?.userId ?? null);
  return (
    <div class="root-bar conflict-bar" role="alert">
      <span>
        <b>{l.who}</b> changed “{c.entry.video.title ?? "this Video"}”{l.when ? ` ${l.when}` : ""}
        {l.change ? <span class="mono"> ({l.change})</span> : null}. Your edit was not saved.
        {c.error && <span class="err"> {c.error}</span>}
      </span>
      <button class="btn small" autoFocus disabled={c.phase === "applying"} onClick={keepTheirs}>
        Keep theirs
      </button>
      <button class="btn small" disabled={c.phase === "applying"} onClick={() => void applyMine()}>
        {c.phase === "applying" ? "Applying…" : "Apply mine"}
      </button>
    </div>
  );
}

/** `GET /api/videos/deleted-matches`: soft-deleted Shared Videos this machine holds files of. */
export interface DeletedMatch {
  id: string;
  title: string;
  updatedAt: string;
  deletedAt: string;
  deletedBy: string | null;
  reason: string | null;
  files: string[];
}

let matches: DeletedMatch[] = [];
let dismissed = false;
const subs = new Set<() => void>();
/** Re-reads the scan warning (after a scan finished). */
export async function refreshDeletedMatches() {
  try {
    const r = await fetch("/api/videos/deleted-matches");
    if (!r.ok) return;
    const next = (await r.json()) as DeletedMatch[];
    if (JSON.stringify(next) !== JSON.stringify(matches)) dismissed = false;
    matches = next;
    for (const f of subs) f();
  } catch {}
}

const fileName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function DeletedMatchNotice() {
  const [, bump] = useState(0);
  const s = useSession();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    subs.add(f);
    void refreshDeletedMatches();
    return () => void subs.delete(f);
  }, []);
  if (dismissed || !matches.length) return null;
  const restore = async (m: DeletedMatch) => {
    setBusy(true);
    setErr(null);
    try {
      await writeLink({ id: m.id, shared: true, updatedAt: m.updatedAt, title: m.title }, { kind: "video.restore" });
      await reloadAll();
      await refreshDeletedMatches();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div class="root-bar deleted-bar" role="alert">
      <div>
        {matches.map((m) => (
          <p key={m.id}>
            {m.files.length === 1 ? <span class="mono">{fileName(m.files[0]!)}</span> : `${m.files.length} files`} belong{m.files.length === 1 ? "s" : ""} to “{m.title}”, deleted
            {m.deletedBy && s.record?.userId === m.deletedBy ? " by you" : " by a Video Editor"}: {m.reason ?? "no reason given"}.{" "}
            {s.canEdit ? (
              <button class="btn small" disabled={busy} onClick={() => void restore(m)}>
                Restore
              </button>
            ) : (
              <span class="dim">{m.files.length === 1 ? "It stays" : "They stay"} unlisted.</span>
            )}
          </p>
        ))}
        {err && <p class="err">{err}</p>}
      </div>
      <button class="root-bar-x" aria-label="Dismiss" title="Dismiss" onClick={() => ((dismissed = true), bump((n) => n + 1))}>
        ×
      </button>
    </div>
  );
}
