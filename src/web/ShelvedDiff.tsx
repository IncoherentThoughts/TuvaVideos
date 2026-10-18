// The one red/green diff row of Shelved edits (docs/sharing-spec.md §2.3, §7.4; ticket #157): what this machine had
// (red, struck) → what the shared library says (green). Used by the reconciliation confirmation, the post-Sync
// popup (src/web/Account.tsx) and the Shelved drawer (src/web/History.tsx). The rows are built server side
// (src/shared/shelvedDiff.ts).
import type { ComponentChildren } from "preact";
import { SHELVED_EXPLAINER, type DiffRow, type VideoDiff } from "../shared/shelvedDiff";

export function DiffRowView({ row, children }: { row: DiffRow; children?: ComponentChildren }) {
  return (
    <li class="sd-row">
      <span class="sd-label">{row.label}</span>
      <span class="sd-vals">
        <del class="sd-before" title="What this machine had (now shelved)">
          {row.before}
        </del>
        <span class="sd-arrow" aria-hidden="true">
          →
        </span>
        <ins class="sd-after" title="What the shared library says">
          {row.after}
        </ins>
      </span>
      {children}
    </li>
  );
}

/** Every Video's rows under its title. */
export function VideoDiffList({ diffs }: { diffs: VideoDiff[] }) {
  if (!diffs.length) return null;
  return (
    <div class="sd-list">
      {diffs.map((d) => (
        <section key={d.videoId} class="sd-video">
          <div class="sd-title">{d.videoTitle}</div>
          <ul class="sd-rows">
            {d.rows.map((r, i) => (
              <DiffRowView key={i} row={r} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The plain explanation of the term, with the key: red is what you had, green is what shows now. */
export function ShelvedExplainer() {
  return (
    <p class="sd-explain">
      {SHELVED_EXPLAINER} <span class="sd-key"><del class="sd-before">Red</del> is what this machine had; <ins class="sd-after">green</ins> is what the shared library says.</span>
    </p>
  );
}
