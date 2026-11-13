// The filter bar pieces the list screens share: a name filter box, the sort select with its direction toggle.
import type { Dir } from "../shared/listView";

export function NameFilter({ value, onChange, placeholder, label }: { value: string; onChange: (q: string) => void; placeholder: string; label: string }) {
  return (
    <span class="qbox">
      <input
        class="chip qin"
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          e.stopPropagation(); // arrows and `f` belong to the box while typing
          if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        }}
      />
      {value && (
        <button class="qclear" aria-label="Clear the name filter" onClick={() => onChange("")}>
          ×
        </button>
      )}
    </span>
  );
}

/** The sort direction as a drawn arrow: the text glyphs ↑ ↓ are hairline-thin in the UI font. */
export function SortArrow({ dir }: { dir: Dir }) {
  return (
    <svg class="sortarrow" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {dir === "asc" ? <path d="M8 13.5V2.5M3.5 7 8 2.5 12.5 7" /> : <path d="M8 2.5v11M3.5 9 8 13.5 12.5 9" />}
    </svg>
  );
}

export function SortControls<S extends string>({ sorts, labels, sort, dir, onSort, onDir }: {
  sorts: readonly S[]; labels: Record<S, string>; sort: S; dir: Dir; onSort: (s: S) => void; onDir: (d: Dir) => void;
}) {
  return (
    <span class="cgroup sortgrp">
      <select class="chip" aria-label="Sort" value={sort} onChange={(e) => onSort((e.target as HTMLSelectElement).value as S)}>
        {sorts.map((s) => (
          <option key={s} value={s}>
            {labels[s]}
          </option>
        ))}
      </select>
      <button class="chip dir" title="Reverse the order" aria-label={`Sorted ${dir === "asc" ? "ascending" : "descending"}; reverse`} onClick={() => onDir(dir === "asc" ? "desc" : "asc")}>
        <SortArrow dir={dir} />
      </button>
    </span>
  );
}
