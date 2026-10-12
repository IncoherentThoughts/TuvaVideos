// The lyrics drawer's editor for a Local Version: label, one Script at a time (the same segmented control as the
// Reader), a textarea of lines (`[3]` is a Footnote Marker) and a textarea of Footnotes (`3: text` per line). Saves
// through POST /api/songs/:id/versions or PATCH /api/versions/:id; the plain <-> HTML conversion is shared/lyrics/plain.
import { useEffect, useRef, useState } from "preact/hooks";
import { footnotesToText, htmlToPlain, linesToHtml, parseFootnotesText } from "../shared/lyrics/plain";
import { SCRIPTS } from "../shared/lyrics/scripts";
import { DEFAULT_VERSION_LABEL } from "../shared/lyrics/trackVersion";
import type { ScriptDto, ScriptKey, VersionDto, VersionInput } from "../shared/lyrics/types";
import { api, apiError } from "./data";

interface Draft { lines: string; footnotes: string }
type Drafts = Record<ScriptKey, Draft>;

const emptyDrafts = (): Drafts => ({ cyrillic: { lines: "", footnotes: "" }, transliteration: { lines: "", footnotes: "" }, translation: { lines: "", footnotes: "" } });
const draftsOf = (v: VersionDto): Drafts => {
  const d = emptyDrafts();
  for (const s of SCRIPTS) d[s.key] = { lines: htmlToPlain(v.scripts[s.key].html), footnotes: footnotesToText(v.scripts[s.key].footnotes) };
  return d;
};

/** The request body for the drafts: every Script sent, empty ones as null so an edit can clear a Script. */
export function versionInputOf(label: string, d: Drafts): VersionInput {
  const scripts: Partial<Record<ScriptKey, ScriptDto | null>> = {};
  for (const s of SCRIPTS) {
    const html = linesToHtml(d[s.key].lines);
    scripts[s.key] = html ? { html, footnotes: parseFootnotesText(d[s.key].footnotes) } : null;
  }
  return { label: label.trim(), scripts };
}

export interface LyricsEditorProps {
  songId: string;
  /** The Local Version being edited, or null for a new one. */
  version: VersionDto | null;
  /** Labels already taken by the Song's other Versions (refused before the round trip). */
  takenLabels: string[];
  /** The Script the Reader was showing: the editor opens on it. */
  script: ScriptKey;
  onSaved: (versionId: string) => void;
  onDeleted?: () => void;
  onCancel: () => void;
}

export function LyricsEditor({ songId, version, takenLabels, script: initial, onSaved, onDeleted, onCancel }: LyricsEditorProps) {
  const [label, setLabel] = useState(version?.label ?? (takenLabels.length ? "" : DEFAULT_VERSION_LABEL));
  const [drafts, setDrafts] = useState<Drafts>(() => (version ? draftsOf(version) : emptyDrafts()));
  const [script, setScript] = useState<ScriptKey>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), [script]);

  const d = drafts[script];
  const setDraft = (patch: Partial<Draft>) => setDrafts({ ...drafts, [script]: { ...d, ...patch } });
  const filled = SCRIPTS.filter((s) => drafts[s.key].lines.trim()).map((s) => s.key);
  const clash = takenLabels.some((l) => l.toLowerCase() === label.trim().toLowerCase() && l !== version?.label);
  const canSave = !busy && !!label.trim() && !clash && filled.length > 0;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      const body = versionInputOf(label, drafts);
      const r = version ? await api.patchVersion(songId, version.id, body) : await api.addVersion(songId, body);
      onSaved(r.id);
    } catch (e) {
      setErr(apiError(e));
      setBusy(false);
    }
  };
  const del = async () => {
    if (!version) return;
    setBusy(true);
    try {
      await api.deleteVersion(songId, version.id);
      onDeleted?.();
    } catch (e) {
      setErr(apiError(e));
      setBusy(false);
    }
  };

  return (
    <form
      class="lyr-edit"
      aria-label={version ? "Edit local Version" : "New local Version"}
      onSubmit={(e) => (e.preventDefault(), void save())}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save();
        } else if (e.key === "[" || e.key === "]") e.stopPropagation(); // the Reader's Marker keys: let the textarea have them
      }}
    >
      <div class="lyr-edit-head">
        <span class="localmark" title="Stored in this library, not in the archive">local</span>
        <span class="muted">{version ? "Editing a local Version" : "New local Version"}</span>
      </div>
      <label class="lyr-edit-row">
        <span class="lbl">Label</span>
        <input class="pk-in" value={label} maxLength={80} placeholder={DEFAULT_VERSION_LABEL} aria-invalid={clash} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
      </label>
      {clash && <div class="edit-err">This Song already has a Version labelled {label.trim()}.</div>}
      <div class="lyr-edit-row">
        <span class="seg" role="group" aria-label="Script to edit">
          {SCRIPTS.map((x) => (
            <button type="button" key={x.key} class={script === x.key ? "on" : ""} aria-pressed={script === x.key} onClick={() => setScript(x.key)}>
              {x.label}
              {drafts[x.key].lines.trim() && <span class="dot" aria-label="has text" />}
            </button>
          ))}
        </span>
      </div>
      <textarea
        ref={area}
        class="lyr-ta lines"
        lang={SCRIPTS.find((x) => x.key === script)!.lang}
        value={d.lines}
        spellcheck={false}
        placeholder={`${SCRIPTS.find((x) => x.key === script)!.label} lines, one per line. An empty line starts a new stanza; [1] marks Footnote 1.`}
        aria-label={`${SCRIPTS.find((x) => x.key === script)!.label} lines`}
        onInput={(e) => setDraft({ lines: (e.target as HTMLTextAreaElement).value })}
      />
      <textarea
        class="lyr-ta fns"
        value={d.footnotes}
        spellcheck={false}
        placeholder="Footnotes, one per line: 1: text"
        aria-label={`${SCRIPTS.find((x) => x.key === script)!.label} footnotes`}
        onInput={(e) => setDraft({ footnotes: (e.target as HTMLTextAreaElement).value })}
      />
      {err && <div class="edit-err" role="alert">{err}</div>}
      <div class="lyr-edit-actions">
        <button type="submit" class="btn small" disabled={!canSave} title={filled.length ? "Save (⌘/Ctrl+Enter)" : "Type at least one Script first"}>
          {version ? "Save" : "Add Version"}
        </button>
        <button type="button" class="btn small" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        {version && !confirmDelete && (
          <button type="button" class="btn small danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Delete…
          </button>
        )}
        {version && confirmDelete && (
          <span class="lyr-edit-confirm">
            <span class="muted">Delete this local Version?</span>
            <button type="button" class="btn small danger" disabled={busy} onClick={() => void del()}>
              Delete
            </button>
            <button type="button" class="btn small" disabled={busy} onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </span>
        )}
      </div>
    </form>
  );
}
